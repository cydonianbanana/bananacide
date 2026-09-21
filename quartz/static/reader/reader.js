"use strict"

// 縦書きリーダー。/works/data/<slug>.json を読み、紙面を横方向に送って表示する。
// 行送り（line-height）を整数pxに固定し、ページ幅をその整数倍にすることで、
// ページの境目がつねに行の切れ目に一致するようにしている。
//
// 節は1本以上の「帯（トラック）」を持つ。帯はいずれも節の右端を原点として
// 横へ流れるので、ページを送れば全ての帯が同時に進む。春霞エンタングルメントの
// 三段組や筐体反転の上下段は、これで同期する。

const SIZES = { s: 16, m: 18, l: 21 }
const SIZE_ORDER = ["s", "m", "l"]
const LINE_HEIGHT_FACTOR = 1.9
const MAX_LINES_PER_PAGE = 24
const MAX_CHARS_PER_LINE = 38
const FAINT_SCALE = 0.86
// 帯を並べるには、いちばん狭い帯にこれだけの字数が要る。
// 足りない画面では並置をやめ、帯を順に読ませる
const MIN_CHARS_PER_BAND = 8
// 傾斜する帯が、いちばん狭くなったときでも確保する字数と、流し込みの安全弁
const MIN_CHARS_PER_RAMP = 3
// レイヤー（段下げ）のいちばん深いところに残す字数。段差はここまで詰められる
const MIN_CHARS_PER_LAYER = 8
const MAX_RAMP_PAGES = 400
const SWIPE_THRESHOLD = 40
const SETTINGS_KEY = "reader:settings"

const els = {
  body: document.body,
  stage: document.getElementById("stage"),
  viewport: document.getElementById("viewport"),
  flow: document.getElementById("flow"),
  title: document.getElementById("work-title"),
  pageLabel: document.getElementById("page-label"),
  message: document.getElementById("message"),
  back: document.getElementById("back"),
  backNote: document.getElementById("back-note"),
  plate: document.getElementById("plate"),
  plateImage: document.querySelector("#plate img"),
  toc: document.getElementById("toc"),
  tocList: document.getElementById("toc-list"),
  tocMeta: document.getElementById("toc-meta"),
  tocToggle: document.getElementById("toc-toggle"),
}

let slug = ""
let data = null
let sections = []
let paragraphs = [] // {el, page} 組み直しのたびに作る、段落とページの対応表
let noteReturn = [] // 註釈へ飛ぶ前にいたページ
let layers = null // {min, max} レイヤーを持つ作品の、段下げの深さの範囲
let mode = "vertical"
let size = "m"
let page = 0
let pages = 1
let pageWidth = 0

// localStorage は private window などで例外を投げるので、素通りできるようにしておく

function readStore(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* 保存できなくても読書は続けられる */
  }
}

function loadSettings() {
  let saved = {}
  try {
    saved = JSON.parse(readStore(SETTINGS_KEY) || "{}")
  } catch {
    saved = {}
  }
  mode = saved.mode === "horizontal" ? "horizontal" : "vertical"
  size = SIZE_ORDER.includes(saved.size) ? saved.size : "m"
  els.body.dataset.mode = mode
  els.body.dataset.size = size
  if (saved.theme === "light" || saved.theme === "dark") {
    document.documentElement.dataset.theme = saved.theme
  }
  refreshControls()
}

function saveSettings() {
  writeStore(
    SETTINGS_KEY,
    JSON.stringify({ mode, size, theme: document.documentElement.dataset.theme || "" }),
  )
}

function refreshControls() {
  document.getElementById("mode-toggle").textContent = mode === "vertical" ? "横書き" : "縦書き"
  document.getElementById("theme-toggle").textContent = isDark() ? "明" : "暗"
}

function isDark() {
  const forced = document.documentElement.dataset.theme
  if (forced) return forced === "dark"
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

// 本文の組み立て

// 行頭のカギ括弧。括弧そのものが字下げの役を果たすので、段落の字下げは付けない
const SPEECH_HEAD_RE = /^[「『]/

let paragraphCounter = 0

function appendBlocks(node, blocks) {
  for (const block of blocks) {
    if (block.type === "gap") {
      const gap = document.createElement("p")
      gap.className = "gap"
      gap.setAttribute("aria-hidden", "true")
      gap.textContent = "　"
      node.append(gap)
      continue
    }
    const el = document.createElement(block.type === "h3" ? "h3" : "p")
    el.innerHTML = block.html
    if (block.kind) el.className = block.kind
    // kind と併せ持つ（《…》内の台詞など）ので、className を潰さず足す
    if (block.type !== "h3" && SPEECH_HEAD_RE.test(el.textContent)) {
      el.classList.add("speech")
    }
    // 天からの段下げ。深さ0が版面の上端で、負の深さはそこより上へ出る
    if (layers && typeof block.depth === "number") {
      el.dataset.depth = String(block.depth)
      el.style.setProperty("--d", String(block.depth - layers.min))
    }
    if (block.type !== "h3") el.dataset.i = String(paragraphCounter++)
    node.append(el)
  }
}

function buildPlate(figure) {
  const el = document.createElement("section")
  el.className = "plate"

  const wrap = document.createElement("figure")
  const image = document.createElement("img")
  image.src = figure.src
  image.alt = figure.caption
  image.width = figure.w
  image.height = figure.h
  image.addEventListener("click", () => showPlate(figure))

  const caption = document.createElement("figcaption")
  caption.textContent = figure.caption

  wrap.append(image, caption)
  el.append(wrap)
  return { el, tracks: [], figure, heading: null, startPage: 0, pageCount: 1, ramped: false }
}

function buildTrack(def, heading) {
  const node = document.createElement("div")
  node.className = def.style === "faint" ? "track faint" : "track"
  if (def.role) node.dataset.role = def.role

  let title = null
  if (heading) {
    title = document.createElement("h2")
    title.textContent = heading
    node.append(title)
  }
  appendBlocks(node, def.blocks)

  // 帯の位置と高さは、数値のほかに [始め, 終わり] の傾斜も取る。
  // 傾斜する帯はページごとに高さが変わるので、級数は主従で変えない
  const ramped = Array.isArray(def.top) || Array.isArray(def.height)

  return {
    node,
    heading: title,
    blocks: Array.from(node.children).filter((child) => child !== title),
    top: def.top === undefined ? 0 : def.top,
    height: def.height === undefined ? 1 : def.height,
    scale: !ramped && def.style === "faint" ? FAINT_SCALE : 1,
    style: def.style || "",
    role: def.role || "",
    ramped,
  }
}

// 段下げを持つ作品かどうか。深さの範囲は、組み付けで段差を決めるのに要る
function measureLayers() {
  let min = null
  let max = null
  for (const section of data.sections) {
    const groups = section.tracks
      ? section.tracks.map((track) => track.blocks)
      : [section.blocks || []]
    for (const blocks of groups) {
      for (const block of blocks) {
        if (typeof block.depth !== "number") continue
        min = min === null ? block.depth : Math.min(min, block.depth)
        max = max === null ? block.depth : Math.max(max, block.depth)
      }
    }
  }
  return min === null ? null : { min, max }
}

function render() {
  els.flow.textContent = ""
  paragraphCounter = 0

  sections = data.sections.map((source) => {
    if (source.figure) {
      const plate = buildPlate(source.figure)
      els.flow.append(plate.el)
      return plate
    }

    const el = document.createElement("section")
    const defs = source.tracks || [{ top: 0, height: 1, blocks: source.blocks }]
    // 節の見出しは主の声に付ける。終章で灰の語りが上の帯に来ても、
    // 見出しは本文の側に残る
    const titled = Math.max(
      0,
      defs.findIndex((def) => def.style !== "faint"),
    )
    const tracks = defs.map((def, index) =>
      buildTrack(def, index === titled ? source.heading : null),
    )
    for (const track of tracks) el.append(track.node)

    els.flow.append(el)
    return {
      el,
      tracks,
      figure: null,
      heading: source.heading,
      startPage: 0,
      pageCount: 0,
      ramped: tracks.some((track) => track.ramped),
    }
  })
}

// 帯が実際に使った幅。max-content の解釈は環境でぶれるうえ、
// 終端の目印を置くとそれ自体が1列を占めて空のページを生むので、
// 中身の要素がどこまで左へ伸びたかを直接測る
function measureTrack(track) {
  const box = track.node.getBoundingClientRect()
  let left = box.right
  for (const child of track.node.children) {
    const rect = child.getBoundingClientRect()
    if (rect.width || rect.height) left = Math.min(left, rect.left)
  }
  return left < box.right ? box.right - left : box.width
}

// 傾斜する帯
//
// 高さがページごとに変わる帯は、ひとつづきの縦組フローには載らない。
// ページを1枚ずつ作り、入るところまで流しては切る。
//
// 筐体反転の終章がこれで、初出は1行45字・1ページ19行の紙面に、上段（日誌）が
// 30→22→14→6字と痩せ、下段（灰の語り）がそのぶん太る。位置は動かず、面積が
// 並ぶ2枚目を境に主客が入れ替わる。台本の「0.667→0.133」はこの動きで、
// 節のページ数で割って補間するので、画面が変わっても身振りは残る。

function bandStart(value) {
  return Array.isArray(value) ? value[0] : value
}

function bandMean(value) {
  return Array.isArray(value) ? (value[0] + value[1]) / 2 : value
}

function rampAt(value, page, pages) {
  if (!Array.isArray(value)) return value
  if (pages <= 1) return value[0]
  const ratio = Math.min(1, Math.max(0, page / (pages - 1)))
  return value[0] + (value[1] - value[0]) * ratio
}

// このページの帯の位置。上下2本の前提で、帯のあいだのアキを保ったまま、
// 狭いほうの帯に最低限の字数を残す
function bandShares(section, page, pages, geom) {
  const shares = section.tracks.map((track) => ({
    top: rampAt(track.top, page, pages),
    height: rampAt(track.height, page, pages),
  }))

  if (shares.length === 2) {
    const gap = Math.max(0, shares[1].top - shares[0].height)
    const least = Math.min(0.4, (MIN_CHARS_PER_RAMP * geom.fontSize) / geom.lineLength)
    const head = Math.min(Math.max(shares[0].height, least), 1 - gap - least)
    shares[0] = { top: 0, height: head }
    shares[1] = { top: head + gap, height: 1 - head - gap }
  }

  // 狭いほうの帯が淡くなる。字数が並ぶページでは、台本が淡と書いたほうを淡いままにする
  const lines = shares.map((share) => Math.round((share.height * geom.lineLength) / geom.fontSize))
  const widest = Math.max(...lines)
  const main = lines.map((n, i) => n === widest && section.tracks[i].style !== "faint")
  const decided = main.some(Boolean)
  shares.forEach((share, i) => {
    share.faint = decided ? !main[i] : lines[i] < widest
  })
  return shares
}

function textNodes(node) {
  const list = []
  let total = 0
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    list.push({ node: text, start: total })
    total += text.data.length
  }
  return { list, total }
}

function spotAt(list, index) {
  let hit = list[0]
  for (const item of list) {
    if (item.start > index) break
    hit = item
  }
  if (!hit) return null
  return { node: hit.node, offset: Math.min(Math.max(0, index - hit.start), hit.node.data.length) }
}

// ページに入る最後の位置。縦組では文字の x 座標が文書順に単調に減るので、
// 先頭からそこまでの範囲の幅で判定でき、二分探索が効く
function fitLength(node, limit) {
  const { list, total } = textNodes(node)
  if (!total) return { total: 0, cut: 0 }

  const right = node.getBoundingClientRect().right
  const range = document.createRange()
  const fits = (index) => {
    const spot = spotAt(list, index)
    if (!spot) return true
    range.setStart(list[0].node, 0)
    range.setEnd(spot.node, spot.offset)
    const box = range.getBoundingClientRect()
    return !box.width || right - box.left <= limit + 0.5
  }

  if (fits(total)) return { total, cut: total }

  let low = 0
  let high = total
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(mid)) low = mid
    else high = mid - 1
  }
  return { total, cut: low }
}

// 親文字を落としきったルビは、振り仮名だけが残ってしまうので畳む
function pruneRuby(node) {
  for (const ruby of node.querySelectorAll("ruby")) {
    const base = Array.from(ruby.childNodes)
      .filter((child) => child.nodeName !== "RT")
      .map((child) => child.textContent)
      .join("")
    if (!base.trim()) ruby.remove()
  }
}

function dropText(node, count) {
  let left = count
  for (const item of textNodes(node).list) {
    if (left <= 0) break
    if (item.node.data.length <= left) {
      left -= item.node.data.length
      item.node.data = ""
    } else {
      item.node.data = item.node.data.slice(left)
      left = 0
    }
  }
  pruneRuby(node)
}

function truncate(node, index) {
  const { list, total } = textNodes(node)
  if (index >= total) return
  const spot = spotAt(list, index)
  if (!spot) return

  const range = document.createRange()
  range.setStart(spot.node, spot.offset)
  range.setEnd(node, node.childNodes.length)
  range.deleteContents()

  pruneRuby(node)
  while (node.lastElementChild && !node.lastElementChild.textContent) {
    node.lastElementChild.remove()
  }
}

// 帯の残りをこのページへ流し、入りきらない分は次のページへ送る
function fill(stream, node, limit, first) {
  const blocks = stream.track.blocks
  if (first && stream.track.heading) node.append(stream.track.heading.cloneNode(true))
  const head = node.textContent.length

  const parts = []
  for (let i = stream.at; i < blocks.length; i += 1) {
    const clone = blocks[i].cloneNode(true)
    if (i === stream.at && stream.offset) {
      dropText(clone, stream.offset)
      clone.classList.add("cont")
      clone.removeAttribute("data-i")
    }
    parts.push({ index: i, el: clone, base: i === stream.at ? stream.offset : 0 })
    node.append(clone)
  }

  const room = fitLength(node, limit)
  if (room.cut >= room.total) {
    stream.at = blocks.length
    stream.offset = 0
    return
  }

  const cut = Math.max(room.cut, head + 1)
  let seen = head
  let next = { index: blocks.length, offset: 0 }
  for (const part of parts) {
    const length = part.el.textContent.length
    if (cut < seen + length) {
      next = { index: part.index, offset: part.base + (cut - seen) }
      break
    }
    seen += length
    next = { index: part.index + 1, offset: 0 }
  }
  // 1文字も進まないと組み付けが終わらないので、かならず先へ進める
  if (next.index === stream.at && next.offset <= stream.offset) {
    next = { index: stream.at, offset: stream.offset + 1 }
  }

  stream.at = next.index
  stream.offset = next.offset
  truncate(node, cut)
}

function pourSection(section, geom, pages) {
  section.el.textContent = ""
  const streams = section.tracks.map((track) => ({ track, at: 0, offset: 0 }))
  const remains = () => streams.some((stream) => stream.at < stream.track.blocks.length)

  let page = 0
  while (page < MAX_RAMP_PAGES) {
    const shares = bandShares(section, page, pages, geom)
    streams.forEach((stream, i) => {
      if (stream.at >= stream.track.blocks.length) return
      const node = document.createElement("div")
      node.className = shares[i].faint ? "track slice faint" : "track slice"
      if (stream.track.role) node.dataset.role = stream.track.role
      node.style.top = `${shares[i].top * 100}%`
      node.style.height = `${shares[i].height * 100}%`
      node.style.right = `${page * geom.pageWidth}px`
      node.style.width = `${geom.pageWidth}px`
      node.style.fontSize = `${geom.fontSize}px`
      node.style.lineHeight = `${geom.advance}px`
      node.style.setProperty("--step", `${geom.advance}px`)
      section.el.append(node)
      fill(stream, node, geom.pageWidth, page === 0)
      if (!node.textContent) node.remove()
    })
    page += 1
    if (!remains()) break
  }
  return Math.max(1, page)
}

// 帯が使う面積の平均から、節の枚数をあたりを付ける
function guessPages(section, geom) {
  const lines = Math.max(1, Math.round(geom.pageWidth / geom.advance))
  let most = 1
  for (const track of section.tracks) {
    const chars = track.blocks.reduce((sum, el) => sum + el.textContent.length, 0)
    const perLine = Math.max(
      1,
      Math.floor((bandMean(track.height) * geom.lineLength) / geom.fontSize),
    )
    most = Math.max(most, Math.ceil(chars / (lines * perLine)))
  }
  return most
}

// ページ数が決まらないと傾斜が引けず、傾斜が決まらないとページ数が出ない。
// 見積もりから始めて、流し込んだ枚数が見積もりに追いつくまで繰り返す。
//
// 枚数を増やすと傾斜がゆるみ、はじめのページの帯がそのぶん細くなるので、
// 多めの枚数もそれ自体で辻褄が合ってしまう。前回の結果を種にすると
// 文字サイズを往復しただけで枚数が増えたままになるため、毎回見積もりから
// 引き直し、収まる最小の枚数まで詰める
function paginateRamp(section, geom) {
  let pages = guessPages(section, geom)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const used = pourSection(section, geom, pages)
    if (used <= pages) break
    pages = used
  }
  for (let attempt = 0; attempt < 8 && pages > 1; attempt += 1) {
    if (pourSection(section, geom, pages - 1) !== pages - 1) break
    pages -= 1
  }
  section.pageCount = pourSection(section, geom, pages)
}

// 傾斜する帯は組み付けのたびにページを作り直すので、
// 順に読ませるとき（横書き・stacked）は元の帯を section に戻す
function restoreSource(section) {
  if (!section.ramped) return
  if (section.el.firstChild === section.tracks[0].node) return
  section.el.textContent = ""
  for (const track of section.tracks) section.el.append(track.node)
}

// 組み付け

function layout(keep) {
  const anchor = keep || currentParagraph()
  const fontSize = SIZES[size]
  const advance = Math.round(fontSize * LINE_HEIGHT_FACTOR)

  els.flow.style.fontSize = `${fontSize}px`
  els.flow.style.lineHeight = `${advance}px`

  if (mode === "horizontal") {
    for (const section of sections) {
      restoreSource(section)
      section.el.style.right = ""
      section.el.style.width = ""
      for (const track of section.tracks) {
        track.node.style.top = ""
        track.node.style.height = ""
        track.node.style.right = ""
        track.node.style.fontSize = ""
        track.node.style.lineHeight = ""
        track.node.style.removeProperty("--step")
      }
    }
    els.viewport.style.width = ""
    els.viewport.style.height = ""
    els.flow.style.removeProperty("--indent") // 横書きの段下げは CSS の既定値に任せる
    els.flow.style.transform = ""
    paragraphs = []
    pages = 1
    page = 0
    buildToc()
    updateStatus()
    if (anchor) anchor.scrollIntoView({ block: "start" })
    return
  }

  const style = getComputedStyle(els.stage)
  const availableWidth =
    els.stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  const availableHeight =
    els.stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)

  // 段下げを持つ作品では、版面の上端より上へ出る段のぶんだけ天に逃げ場を作る。
  // 1段の段差は作品が決める（既定1字）。狭い画面では、いちばん深い段に
  // 字が残るところまで詰める
  const step = layers ? data.layerStep || 1 : 0
  const up = layers ? Math.max(0, -layers.min) : 0
  const down = layers ? Math.max(0, layers.max) : 0
  const lineLength = Math.max(
    advance * 4,
    Math.min(availableHeight, fontSize * (MAX_CHARS_PER_LINE + up * step)),
  )
  const indent =
    up + down
      ? Math.max(
          0,
          Math.min(
            fontSize * step,
            (lineLength - MIN_CHARS_PER_LAYER * fontSize) / (up + down),
          ),
        )
      : 0
  els.flow.style.setProperty("--indent", `${indent}px`)

  const linesPerPage = Math.max(
    1,
    Math.min(MAX_LINES_PER_PAGE, Math.floor(availableWidth / advance)),
  )
  pageWidth = linesPerPage * advance

  els.viewport.style.width = `${pageWidth}px`
  els.viewport.style.height = `${Math.floor(lineLength)}px`

  // いちばん狭い帯が読める高さかどうかで、並置するか順に読ませるかを決める。
  // 傾斜する帯は終わり際だけ細くなるので、平均で見る
  const narrowest = Math.min(1, ...sections.flatMap((s) => s.tracks.map((t) => bandMean(t.height))))
  const stacked = lineLength * narrowest < fontSize * MIN_CHARS_PER_BAND
  els.body.classList.toggle("stacked", stacked)

  let offset = 0
  for (const section of sections) {
    section.el.style.right = "0px"
    section.el.style.width = `${pageWidth}px`

    if (section.figure) {
      section.pageCount = 1
    } else if (section.ramped && !stacked) {
      paginateRamp(section, { pageWidth, lineLength, advance, fontSize })
    } else {
      restoreSource(section)
      let width = 0
      let stackedWidth = 0
      for (const track of section.tracks) {
        // 順に読ませるときは、どの帯も紙面いっぱいを使う
        track.node.style.top = stacked ? "0%" : `${bandStart(track.top) * 100}%`
        track.node.style.height = stacked ? "100%" : `${bandStart(track.height) * 100}%`
        // 帯ごとに級数を変えても、行送りがページ幅を割り切るようにしておく。
        // そうしないと帯の行がページの境目で真っ二つになる
        const wanted = advance * track.scale
        const lines = Math.max(1, Math.round(pageWidth / wanted))
        const step = pageWidth / lines
        track.node.style.lineHeight = `${step}px`
        track.node.style.fontSize = `${step / LINE_HEIGHT_FACTOR}px`
        // 見出しの下のアキもこの幅にそろえる（reader.css の --step）
        track.node.style.setProperty("--step", `${step}px`)

        const measured = measureTrack(track)
        width = Math.max(width, measured)
        if (stacked && section.tracks.length > 1) {
          track.node.style.right = `${stackedWidth}px`
          stackedWidth += Math.max(1, Math.ceil((measured - 2) / pageWidth)) * pageWidth
        } else {
          track.node.style.right = "0px"
        }
      }
      section.pageCount = stackedWidth
        ? stackedWidth / pageWidth
        : Math.max(1, Math.ceil((width - 2) / pageWidth))
    }

    section.startPage = offset / pageWidth
    section.el.style.width = `${section.pageCount * pageWidth}px`
    section.el.style.right = `${offset}px`
    offset += section.pageCount * pageWidth
  }
  pages = Math.max(1, offset / pageWidth)

  indexParagraphs()
  buildToc()
  // 傾斜する帯のページは組み直しで作り替わる。栞と同じく、段落は番号で捕まえる
  const kept = anchor && anchor.isConnected ? anchor : findParagraph(anchor && anchor.dataset.i)
  goto(kept ? pageOf(kept) : page, false)
}

function findParagraph(index) {
  if (index === undefined || index === null) return null
  return els.flow.querySelector(`p[data-i="${CSS.escape(index)}"]`)
}

// 段落がどのページに載るかを組み付け時に控えておく。
// ページ送りのアニメーション中に座標を読むと途中の値を拾ってしまうため、
// 栞や組み直しではこの表だけを使う
function indexParagraphs() {
  paragraphs = Array.from(els.flow.querySelectorAll("p[data-i]"), (el) => ({
    el,
    page: measurePage(el),
  }))
}

// #flow と要素は同じ transform で動くので、右端からの距離はページ送り中も変わらない
function measurePage(el) {
  const flowRight = els.flow.getBoundingClientRect().right
  return Math.max(0, Math.floor((flowRight - el.getBoundingClientRect().right + 2) / pageWidth))
}

function pageOf(el) {
  if (mode === "horizontal") return 0
  const hit = paragraphs.find((entry) => entry.el === el)
  return hit ? hit.page : measurePage(el)
}

function currentParagraph() {
  if (mode === "horizontal") {
    for (const p of els.flow.querySelectorAll("p[data-i]")) {
      if (p.getBoundingClientRect().bottom > 0) return p
    }
    return null
  }
  const exact = paragraphs.find((entry) => entry.page === page)
  if (exact) return exact.el
  let previous = null
  for (const entry of paragraphs) {
    if (entry.page > page) break
    previous = entry
  }
  return previous ? previous.el : null
}

// ページ送り

function goto(target, animate = true) {
  if (mode === "horizontal") return
  if (!animate) {
    els.flow.style.transition = "none"
    // 背面タブでは transition が時刻0のまま凍り、途中値が inline style を上回り続ける。
    // 送りを飛ばすときは先に畳んでおく
    els.flow.getAnimations().forEach((animation) => animation.cancel())
  }
  page = Math.min(Math.max(0, Math.round(target)), pages - 1)
  els.flow.style.transform = `translateX(${page * pageWidth}px)`
  if (!animate) {
    void els.flow.offsetWidth
    els.flow.style.transition = ""
  }
  updateStatus()
  saveMark()
}

function turn(delta) {
  clearNoteReturn()
  goto(page + delta)
}

function sectionAt(target) {
  let found = sections[0]
  for (const section of sections) {
    if (section.startPage <= target) found = section
  }
  return found
}

function updateStatus() {
  if (mode === "horizontal") {
    els.pageLabel.textContent = `${data.title}　全${data.chars}字`
    return
  }
  const section = sectionAt(page)
  const heading = section && section.heading ? `　${section.heading}` : ""
  els.pageLabel.textContent = `${page + 1} / ${pages}${heading}`
}

function saveMark() {
  const current = currentParagraph()
  if (current) writeStore(`reader:${slug}:mark`, current.dataset.i)
}

// 組み付けの時点で goto が栞を書き直してしまうので、
// 保存されていた値は組み付けの前に読み出しておく
function restoreMark(mark) {
  if (!mark) return
  const el = findParagraph(mark)
  if (!el) return
  if (mode === "horizontal") el.scrollIntoView({ block: "start" })
  else goto(pageOf(el), false)
}

// 註釈の往復

function clearNoteReturn() {
  if (!noteReturn.length) return
  noteReturn = []
  els.backNote.hidden = true
}

function jumpToNote(number) {
  const target = els.flow.querySelector(`[id="note-${CSS.escape(number)}"]`)
  if (!target) return
  if (mode === "horizontal") {
    target.scrollIntoView({ block: "start", behavior: "smooth" })
    return
  }
  noteReturn.push(page)
  els.backNote.hidden = false
  goto(measurePage(target))
}

function returnFromNote() {
  const back = noteReturn.pop()
  if (back === undefined) return
  if (!noteReturn.length) els.backNote.hidden = true
  goto(back)
}

// 図版の拡大

function showPlate(figure) {
  els.plateImage.src = figure.src
  els.plateImage.alt = figure.caption
  els.plate.hidden = false
}

function hidePlate() {
  els.plate.hidden = true
  els.plateImage.removeAttribute("src")
}

// 目次

function buildToc() {
  els.tocMeta.textContent = [data.issue, `全${data.chars}字`].filter(Boolean).join("　/　")
  els.tocList.textContent = ""

  // 見出しのある作品は見出しだけを並べる。無い作品は節に番号を振る
  const titled = sections.some((section) => section.heading)

  sections.forEach((section, i) => {
    if (section.figure) return
    if (titled && !section.heading) return
    const label = section.heading || (i === 0 ? "本文" : `第${i + 1}節`)

    const item = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"

    const name = document.createElement("span")
    name.textContent = label
    const number = document.createElement("span")
    number.textContent = mode === "vertical" ? `${section.startPage + 1}` : ""

    button.append(name, number)
    button.addEventListener("click", () => {
      clearNoteReturn()
      if (mode === "vertical") goto(section.startPage)
      else section.el.scrollIntoView({ block: "start", behavior: "smooth" })
      toggleToc(false)
    })

    item.append(button)
    els.tocList.append(item)
  })
}

function toggleToc(force) {
  const open = force === undefined ? els.toc.hidden : force
  els.toc.hidden = !open
  els.tocToggle.setAttribute("aria-expanded", String(open))
}

// 操作

function setMode(next) {
  const anchor = currentParagraph()
  mode = next
  els.body.dataset.mode = mode
  clearNoteReturn()
  refreshControls()
  saveSettings()
  layout(anchor)
}

function setSize(step) {
  const index = SIZE_ORDER.indexOf(size) + step
  if (index < 0 || index >= SIZE_ORDER.length) return
  size = SIZE_ORDER[index]
  els.body.dataset.size = size
  saveSettings()
  layout()
}

function bindControls() {
  document.getElementById("next").addEventListener("click", () => turn(1))
  document.getElementById("prev").addEventListener("click", () => turn(-1))
  document.getElementById("size-up").addEventListener("click", () => setSize(1))
  document.getElementById("size-down").addEventListener("click", () => setSize(-1))
  els.tocToggle.addEventListener("click", () => toggleToc())
  els.backNote.addEventListener("click", returnFromNote)
  els.plate.addEventListener("click", hidePlate)

  document.getElementById("mode-toggle").addEventListener("click", () => {
    setMode(mode === "vertical" ? "horizontal" : "vertical")
  })

  document.getElementById("theme-toggle").addEventListener("click", () => {
    document.documentElement.dataset.theme = isDark() ? "light" : "dark"
    refreshControls()
    saveSettings()
  })

  // 本文中の註釈番号。ページ送りのタップ判定より先に処理する
  els.flow.addEventListener("click", (event) => {
    const ref = event.target.closest("a.noteref")
    if (!ref) return
    event.preventDefault()
    event.stopPropagation()
    jumpToNote(ref.dataset.note)
  })

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!els.plate.hidden) return hidePlate()
      return toggleToc(false)
    }
    if (mode !== "vertical") return
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
      case "PageDown":
      case " ":
        event.preventDefault()
        turn(1)
        break
      case "ArrowRight":
      case "ArrowUp":
      case "PageUp":
        event.preventDefault()
        turn(-1)
        break
      case "Home":
        goto(0)
        break
      case "End":
        goto(pages - 1)
        break
    }
  })

  let wheelAcc = 0
  window.addEventListener(
    "wheel",
    (event) => {
      if (mode !== "vertical" || !els.toc.hidden || !els.plate.hidden) return
      event.preventDefault()
      wheelAcc += Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      if (Math.abs(wheelAcc) < 40) return
      turn(wheelAcc > 0 ? 1 : -1)
      wheelAcc = 0
    },
    { passive: false },
  )

  // 縦書きでは次のページが左から来るので、右向きのスワイプで先へ進む
  let start = null
  els.stage.addEventListener("pointerdown", (event) => {
    start = { x: event.clientX, y: event.clientY }
  })
  els.stage.addEventListener("pointerup", (event) => {
    if (!start) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    start = null
    if (event.target.closest("a.noteref, #flow figure img")) return
    if (mode === "vertical" && Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      turn(dx > 0 ? 1 : -1)
      return
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) els.body.classList.toggle("ui-hidden")
  })

  let scrollTimer = 0
  window.addEventListener("scroll", () => {
    if (mode !== "horizontal") return
    window.clearTimeout(scrollTimer)
    scrollTimer = window.setTimeout(saveMark, 200)
  })

  // 断片だけが変わっても読み込み直す（別の作品へのリンクを踏んだとき）
  window.addEventListener("hashchange", () => location.reload())

  let resizeTimer = 0
  const relayout = () => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => layout(), 150)
  }
  window.addEventListener("resize", relayout)
  window.addEventListener("orientationchange", relayout)
}

// 起動

function fail(text) {
  els.message.hidden = false
  els.message.textContent = text
}

async function main() {
  loadSettings()
  bindControls()

  // 作品は URL の断片で指定する（/static/reader/#kumiki）。
  // Quartz のリンク変換がクエリ文字列を潰すため、? ではなく # を使っている
  const requested = location.hash.slice(1) || new URLSearchParams(location.search).get("work") || ""
  slug = requested.replace(/[^A-Za-z0-9_-]/g, "")
  if (!slug) {
    fail("作品が指定されていない。works ページから開いてくれ。")
    return
  }

  try {
    // GitHub Pages はどのファイルにも max-age=600 を返す。本文だけは公開したそばから
    // 新しいものを読ませたいので、ETag での問い合わせを毎回させる
    const response = await fetch(`/works/data/${slug}.json`, { cache: "no-cache" })
    if (!response.ok) throw new Error(String(response.status))
    data = await response.json()
  } catch {
    fail("本文を読み込めなかった。")
    return
  }

  document.title = `${data.title} — bananacide`
  els.title.textContent = data.title
  els.back.href = `/works/${slug}`

  const mark = readStore(`reader:${slug}:mark`)
  layers = measureLayers()
  render()
  layout()
  restoreMark(mark)
  els.message.hidden = true

  // 明朝体の読み込み完了で字幅が変わるので、組み直す
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => layout())
  }
  // 図版の読み込みでも紙面の幅が変わる
  for (const image of els.flow.querySelectorAll("img")) {
    image.addEventListener("load", () => layout(), { once: true })
  }
}

main()
