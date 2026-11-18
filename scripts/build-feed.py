#!/usr/bin/env python3
"""Build feed.xml (RSS 2.0) from the "What's new" list on the home page.

Each <li> in the #whats-new section becomes one item. The date comes from
the bold "Mon DD, YYYY:" prefix. Run from the site root after editing the
list: python3 scripts/build-feed.py
"""
import hashlib, html, re
from datetime import datetime
from email.utils import format_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://howdbswork.com/"


def main():
    s = (ROOT / "index.html").read_text()
    sec = s.split('id="whats-new"', 1)[1].split("</section>", 1)[0]
    items = []
    for n, li in enumerate(re.findall(r"<li>(.*?)</li>", sec, re.S)):
        m = re.match(r"\s*<b>([A-Z][a-z]{2} \d{1,2}, \d{4}):</b>\s*(.*)", li, re.S)
        if not m:
            continue
        when = datetime.strptime(m.group(1), "%b %d, %Y").replace(hour=12)
        text = html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
        title = text.split(":")[0] if ":" in text[:90] else text[:90].rsplit(" ", 1)[0] + "..."
        items.append(
            "  <item>\n"
            f"    <title>{html.escape(title[:1].upper() + title[1:])}</title>\n"
            f"    <link>{SITE}#whats-new</link>\n"
            f"    <guid isPermaLink=\"false\">howdbswork-{hashlib.sha1(text.encode()).hexdigest()[:12]}</guid>\n"
            f"    <pubDate>{format_datetime(when.astimezone())}</pubDate>\n"
            f"    <description>{html.escape(text)}</description>\n"
            "  </item>")
    feed = ('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n'
            "  <title>Real Databases, Simply: what's new</title>\n"
            f"  <link>{SITE}</link>\n"
            "  <description>New pages and changes on howdbswork.com, by Dinesh.</description>\n"
            "  <language>en</language>\n" + "\n".join(items) + "\n</channel>\n</rss>\n")
    (ROOT / "feed.xml").write_text(feed)
    print(f"feed.xml: {len(items)} items")


if __name__ == "__main__":
    main()
