#!/usr/bin/env python3
"""Search and sharing metadata for every page.

Writes, between <!-- SEO:BEGIN --> and <!-- SEO:END --> in each page's head:
a canonical link and Open Graph / Twitter card tags (title, description,
image). The image is assets/og/<slug>.png when scripts/build-og.mjs has made
one for the page, otherwise assets/og/index.png.
Also writes sitemap.xml (with lastmod from assets/data/updated.json) and
robots.txt. Run from the site root: python3 scripts/build-seo.py
"""
import html, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://" + (ROOT / "CNAME").read_text().strip() + "/"
SKIP_DIRS = {"assets", "ci-out", "mcp", "node_modules", "scripts"}


def pages():
    out = []
    for p in sorted(ROOT.rglob("*.html")):
        rel = p.relative_to(ROOT)
        if rel.parts[0] in SKIP_DIRS:
            continue
        out.append(p)
    return out


def url_of(rel):
    if rel == "index.html":
        return SITE
    if rel == "404.html":
        return SITE + "404.html"
    return SITE + rel[: -len("index.html")]


def slug_of(rel):
    return "index" if rel in ("index.html", "404.html") else rel[: -len("/index.html")].replace("/", "-")


def main():
    updated = json.loads((ROOT / "assets/data/updated.json").read_text())
    urls = []
    for p in pages():
        rel = str(p.relative_to(ROOT))
        text = p.read_text()
        head = text.split("</head>", 1)[0]
        m = re.search(r"<title>(.*?)</title>", head, re.S)
        title = html.unescape(m.group(1)).strip() if m else "Real databases, simply"
        title = re.sub(r"\s*·\s*Real Databases, Simply$", "", title)
        m = re.search(r'<meta name="description" content="([^"]*)"', head)
        desc = html.unescape(m.group(1)) if m else ""
        slug = slug_of(rel)
        img = f"assets/og/{slug}.png" if (ROOT / f"assets/og/{slug}.png").exists() else "assets/og/index.png"
        u = url_of(rel)
        e = lambda s: html.escape(s, quote=True)
        tags = []
        if rel == "404.html":
            tags.append('<meta name="robots" content="noindex"/>')
        else:
            tags.append(f'<link rel="canonical" href="{u}"/>')
        tags += [
            '<meta property="og:site_name" content="Real databases, simply"/>',
            f'<meta property="og:type" content="{"website" if rel == "index.html" else "article"}"/>',
            f'<meta property="og:title" content="{e(title)}"/>',
            f'<meta property="og:description" content="{e(desc)}"/>',
            f'<meta property="og:url" content="{u}"/>',
            f'<meta property="og:image" content="{SITE}{img}"/>',
            '<meta property="og:image:width" content="1200"/>',
            '<meta property="og:image:height" content="630"/>',
            '<meta name="twitter:card" content="summary_large_image"/>',
        ]
        block = "<!-- SEO:BEGIN -->\n" + "\n".join(tags) + "\n<!-- SEO:END -->"
        if "<!-- SEO:BEGIN -->" in text:
            new = re.sub(r"<!-- SEO:BEGIN -->.*?<!-- SEO:END -->", lambda _: block, text, count=1, flags=re.S)
        else:
            new = re.sub(r"(</title>\n?)", lambda m: m.group(1) + block + "\n", text, count=1)
        if new != text:
            p.write_text(new)
        if rel != "404.html":
            urls.append((u, updated.get(rel)))
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u, d in urls:
        xml.append(f"  <url><loc>{u}</loc>" + (f"<lastmod>{d}</lastmod>" if d else "") + "</url>")
    xml.append("</urlset>")
    (ROOT / "sitemap.xml").write_text("\n".join(xml) + "\n")
    (ROOT / "robots.txt").write_text(f"User-agent: *\nAllow: /\n\nSitemap: {SITE}sitemap.xml\n")
    print(f"seo tags on {len(urls) + 1} pages; sitemap.xml has {len(urls)} urls")


if __name__ == "__main__":
    main()
