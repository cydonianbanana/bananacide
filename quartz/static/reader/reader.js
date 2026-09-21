"use strict"

// 縦書きリーダー。/works/data/<slug>.json を読み、紙面を横方向に送って表示する。
// 行送り（line-height）を整数pxに固定し、ページ幅をその整数倍にすることで、
// ページの境目がつねに行の切れ目に一致するようにしている。

const SIZES = { s: 16, m: 18, l: 21 }
const SIZE_ORDER = ["s", "m", "l"]
const LINE_HEIGHT_FACTOR = 1.9
const MAX_LINES_PER_PAGE = 24
const MAX_CHARS_PER_LINE = 38
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
  toc: document.getElementById("toc"),
  tocList: document.getElementById("toc-list"),
  tocMeta: document.getElementById("toc-meta"),
  tocToggle: document.getElementById("toc-toggle"),
}

let slug = ""
let data = null
let sections = []
let paragraphs = [] // {el, page} 組み直しのたびに作る、段落とページの対応表
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

function render() {
  els.flow.textContent = ""
  let index = 0

  sections = data.sections.map((source) => {
    const el = document.createElement("section")

    if (source.heading) {
      const heading = document.createElement("h2")
      heading.textContent = source.heading
      el.append(heading)
    }

    for (const block of source.blocks) {
      if (block.type === "gap") {
        const gap = document.createElement("p")
        gap.className = "gap"
        gap.setAttribute("aria-hidden", "true")
        gap.textContent = "　"
        el.append(gap)
        continue
      }
      const node = document.createElement(block.type === "h3" ? "h3" : "p")
      node.innerHTML = block.html
      if (block.kind) node.className = block.kind
      if (block.type !== "h3") node.dataset.i = String(index++)
      el.append(node)
    }

    // 本文の終端を測るための目印。max-content の解釈がずれる環境への保険
    const tail = document.createElement("span")
    tail.textContent = "​"
    el.append(tail)

    els.flow.append(el)
    return { el, tail, heading: source.heading, startPage: 0, pageCount: 1 }
  })
}

function measureSection(section) {
  const box = section.el.getBoundingClientRect()
  const tail = section.tail.getBoundingClientRect()
  return Math.max(box.width, box.right - tail.left)
}

// 組み付け

function layout(keep) {
  const anchor = keep || currentParagraph()
  const fontSize = SIZES[size]
  const advance = Math.round(fontSize * LINE_HEIGHT_FACTOR)

  els.flow.style.fontSize = `${fontSize}px`
  els.flow.style.lineHeight = `${advance}px`

  if (mode === "horizontal") {
    for (const section of sections) section.el.style.right = ""
    els.viewport.style.width = ""
    els.viewport.style.height = ""
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

  const lineLength = Math.max(advance * 4, Math.min(availableHeight, fontSize * MAX_CHARS_PER_LINE))
  const linesPerPage = Math.max(
    1,
    Math.min(MAX_LINES_PER_PAGE, Math.floor(availableWidth / advance)),
  )
  pageWidth = linesPerPage * advance

  els.viewport.style.width = `${pageWidth}px`
  els.viewport.style.height = `${Math.floor(lineLength)}px`

  let offset = 0
  for (const section of sections) {
    section.el.style.right = "0px"
    const width = measureSection(section)
    section.pageCount = Math.max(1, Math.ceil((width - 2) / pageWidth))
    section.startPage = offset / pageWidth
    section.el.style.right = `${offset}px`
    offset += section.pageCount * pageWidth
  }
  pages = Math.max(1, offset / pageWidth)

  indexParagraphs()
  buildToc()
  goto(anchor ? pageOf(anchor) : page, false)
}

// 段落がどのページに載るかを組み付け時に控えておく。
// ページ送りのアニメーション中に座標を読むと途中の値を拾ってしまうため、
// 栞や組み直しではこの表だけを使う
function indexParagraphs() {
  const flowRight = els.flow.getBoundingClientRect().right
  paragraphs = Array.from(els.flow.querySelectorAll("p[data-i]"), (el) => ({
    el,
    page: Math.max(0, Math.floor((flowRight - el.getBoundingClientRect().right + 2) / pageWidth)),
  }))
}

function pageOf(el) {
  if (mode === "horizontal") return 0
  const hit = paragraphs.find((entry) => entry.el === el)
  return hit ? hit.page : 0
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
  const el = els.flow.querySelector(`p[data-i="${CSS.escape(mark)}"]`)
  if (!el) return
  if (mode === "horizontal") el.scrollIntoView({ block: "start" })
  else goto(pageOf(el), false)
}

// 目次

function buildToc() {
  els.tocMeta.textContent = [data.issue, `全${data.chars}字`].filter(Boolean).join("　/　")
  els.tocList.textContent = ""

  sections.forEach((section, i) => {
    const item = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"

    const label = document.createElement("span")
    label.textContent = section.heading || (i === 0 ? "本文" : `第${i + 1}節`)
    const number = document.createElement("span")
    number.textContent = mode === "vertical" ? `${section.startPage + 1}` : ""

    button.append(label, number)
    button.addEventListener("click", () => {
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

  document.getElementById("mode-toggle").addEventListener("click", () => {
    setMode(mode === "vertical" ? "horizontal" : "vertical")
  })

  document.getElementById("theme-toggle").addEventListener("click", () => {
    document.documentElement.dataset.theme = isDark() ? "light" : "dark"
    refreshControls()
    saveSettings()
  })

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return toggleToc(false)
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
      if (mode !== "vertical" || !els.toc.hidden) return
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
    const response = await fetch(`/works/data/${slug}.json`)
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
  render()
  layout()
  restoreMark(mark)
  els.message.hidden = true

  // 明朝体の読み込み完了で字幅が変わるので、組み直す
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => layout())
  }
}

main()
