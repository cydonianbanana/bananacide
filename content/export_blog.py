# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "feedparser",
#     "markdownify",
#     "requests",
# ]
# ///

import feedparser
from markdownify import markdownify as md
import os
from datetime import datetime

feed = feedparser.parse('https://cydonianbanana.net/feed/')
output_dir = '/Users/cydonianbanana/md/50_Publish/blog'

os.makedirs(output_dir, exist_ok=True)

for entry in feed.entries:
    title = entry.title
    # feedparser usually puts full content in content[0].value for content:encoded
    if 'content' in entry:
        content_html = entry.content[0].value
    else:
        content_html = entry.summary
    
    content_md = md(content_html)
    
    pub_tuple = entry.published_parsed
    pub_date = datetime(*pub_tuple[:6])
    date_str = pub_date.strftime('%Y-%m-%d')
    
    # Simple sanitize
    safe_title = "".join([c for c in title if c not in ['/', '\\', ':', '*', '?', '"', '<', '>', '|']]).strip()
    filename = f"{date_str}-{safe_title}.md".replace(' ', '_')
    
    filepath = os.path.join(output_dir, filename)
    
    frontmatter = f"---\ntitle: {title}\ndate: {date_str}\n---\n\n"
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(frontmatter + content_md)

print(f"Exported {len(feed.entries)} articles to {output_dir}")
