#!/usr/bin/env python3
"""Export the site's design docs and lessons for the MCP server in mcp/.
Writes mcp/data.json and copies assets/js/estimate.js and querycoach.js into mcp/,
so the server answers from the same text and formulas as the pages."""
import json, re, html, shutil, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://howdbswork.com/"

def text(s):
    s = re.sub(r"<(script|style|svg)\b.*?</\1>", " ", s, flags=re.S)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()

def rows(sec):
    out = []
    for tr in re.findall(r"<tr>(.*?)</tr>", sec, flags=re.S):
        cells = [text(c) for c in re.findall(r"<td>(.*?)</td>", tr, flags=re.S)]
        if cells: out.append(cells)
    return out

def section(s, sid):
    m = re.search(r'<section id="%s">(.*?)</section>' % sid, s, flags=re.S)
    return m.group(1) if m else ""

# Words a developer would use about each kind of application, for matching.
KEYWORDS = {
 "store-orders": "shop store ecommerce e-commerce orders cart checkout inventory stock sku oversell flash sale",
 "payments-ledger": "payments ledger money balance wallet transfer accounting double entry fintech billing invoice refund",
 "booking-reservations": "booking reservation seats tickets hotel appointment calendar slots double booking on-sale availability",
 "accounts-sessions": "users accounts login auth authentication sessions tokens identity passwords sso",
 "multi-tenant-saas": "saas multi-tenant tenants customers b2b organizations workspace isolation noisy neighbour",
 "product-catalog": "catalog products attributes facets filters prices variants pim",
 "social-feed": "feed timeline followers posts social fan-out likes news feed",
 "search-ai-retrieval": "search full-text rag retrieval embeddings vector semantic pgvector documents chunks similarity",
 "chat-messaging": "chat messages messaging conversations channels inbox websocket presence",
 "iot-telemetry": "iot telemetry sensors devices metrics time series readings timeseries monitoring",
 "audit-event-log": "audit log events history compliance append-only trail gdpr who changed",
 "leaderboards-counters": "leaderboard counters scores ranking likes views rate limit top n",
 "analytics-reporting": "analytics reporting dashboards bi warehouse olap aggregates reports metrics",
 "agent-memory": "agent agents ai llm memory long-term memory conversation history checkpoints state tool calls langgraph assistant copilot",
}

def main():
    sm = json.load(open(os.path.join(ROOT, "assets/data/sitemap.json")))
    lessons, designs = [], []
    for sec in sm["sections"]:
        for href, title in sec["pages"]:
            p = os.path.join(ROOT, href)
            if not os.path.exists(p): continue
            s = open(p).read()
            desc = re.search(r'<meta name="description" content="([^"]*)"', s)
            heads = [text(h) for h in re.findall(r"<h[23][^>]*>(.*?)</h[23]>", s, flags=re.S)]
            url = SITE + href.replace("index.html", "")
            lessons.append({"title": title, "section": sec["name"], "url": url,
                            "description": html.unescape(desc.group(1)) if desc else "", "headings": heads[:30]})
            m = re.match(r"designs/([a-z-]+)/index.html", href)
            if m and m.group(1) in KEYWORDS:
                slug = m.group(1)
                q = re.search(r'<p class="qline">(.*?)</p>', s, flags=re.S)
                v = re.search(r'<div class="verdict"><b class="dt">The short answer</b>(.*?)</div>', s, flags=re.S)
                designs.append({
                    "slug": slug, "title": title, "url": url,
                    "question": text(q.group(1)) if q else "",
                    "short_answer": text(v.group(1)) if v else "",
                    "workload": rows(section(s, "workload")),
                    "placement": rows(section(s, "placement")),
                    "breaks": rows(section(s, "breaks")),
                    "where_to_run": rows(section(s, "where")),
                    "keywords": KEYWORDS[slug],
                })
    out = {"site": SITE, "designs": designs, "lessons": lessons}
    json.dump(out, open(os.path.join(ROOT, "mcp/data.json"), "w"), indent=1, ensure_ascii=False)
    shutil.copy(os.path.join(ROOT, "assets/js/estimate.js"), os.path.join(ROOT, "mcp/estimate.js"))
    shutil.copy(os.path.join(ROOT, "assets/js/querycoach.js"), os.path.join(ROOT, "mcp/querycoach.js"))
    # llms.txt: the same list, for assistants that read the web.
    L = ["# Real Databases, Simply (howdbswork.com)", "",
         "> How PostgreSQL, MySQL and MongoDB work in real systems: internals, side-by-side comparisons, measured lab",
         "> notebooks, and design docs that say which database each kind of application data belongs in, and why.", "",
         "Written by a database engineer. An MCP server for AI assistants: " + SITE + "assistant/", ""]
    sec = None
    for l in lessons:
        if l["section"] != sec:
            sec = l["section"]; L += ["", "## " + sec, ""]
        L.append("- [%s](%s): %s" % (l["title"], l["url"], l["description"]))
    open(os.path.join(ROOT, "llms.txt"), "w").write("\n".join(L).replace("\n\n\n", "\n\n") + "\n")
    print("mcp/data.json: %d design docs, %d lessons; llms.txt written" % (len(designs), len(lessons)))

if __name__ == "__main__":
    main()
