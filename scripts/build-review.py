#!/usr/bin/env python3
"""Collect review cards from the pages into assets/data/review.json, for the
review deck on the home page: quiz questions (with the right answer and why),
Your turn questions (with my answer) and Predict first questions."""
import json, re, html, hashlib, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def text(s):
    s = re.sub(r"<(script|style|svg)\b.*?</\1>", " ", s, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()

def keep(s):
    """Answer HTML with only simple inline tags, and links made site-absolute."""
    s = re.sub(r"<(?!/?(p|b|i|code|a)\b)[^>]+>", "", s)
    return re.sub(r'href="(?:\.\./)+', 'href="/', s).strip()

def cid(page, q):
    return hashlib.sha1((page + "|" + q).encode()).hexdigest()[:10]

def main():
    sm = json.load(open(os.path.join(ROOT, "assets/data/sitemap.json")))
    cards = []
    for sec in sm["sections"]:
        if sec["id"] == "about":
            continue
        for href, title in sec["pages"]:
            p = os.path.join(ROOT, href)
            if not os.path.exists(p):
                continue
            s = open(p).read()
            for qz in re.findall(r'<div class="qz" data-answer="(\d+)">(.*?)<p class="qe" hidden>(.*?)</p></div>', s, flags=re.S):
                ans, body, why = qz
                q = re.sub(r"^\d+\.\s*", "", text(re.search(r'<p class="qq">(.*?)</p>', body, flags=re.S).group(1)))
                opts = [text(o) for o in re.findall(r'<button[^>]*class="qopt"[^>]*>(.*?)</button>', body, flags=re.S)]
                if not opts:
                    continue
                cards.append({"id": cid(href, q), "page": href, "title": title, "kind": "mc", "q": q, "opts": opts, "a": int(ans), "why": text(why)})
            for m in re.finditer(r'<section id="your-turn">.*?<p class="es-q">(.*?)</p>.*?<div class="es-a">(.*?)</div></details>', s, flags=re.S):
                q = text(m.group(1))
                cards.append({"id": cid(href, q), "page": href, "title": title, "kind": "open", "q": q, "ans": keep(m.group(2))})
            for m in re.finditer(r'<details class="predict[^"]*"><summary>(.*?)</summary>\s*<p>(.*?)</p>', s, flags=re.S):
                q = re.sub(r"^Predict first:\s*", "", text(m.group(1)))
                cards.append({"id": cid(href, q), "page": href, "title": title, "kind": "open", "q": q, "ans": "<p>" + keep(m.group(2)) + "</p>"})
    # The design docs' Your turn questions live in estimate.js; work them with the default numbers.
    js = r"""
const vm=require('vm'),fs=require('fs');const c={window:{},document:{querySelectorAll:()=>[],getElementById:()=>null},location:{hash:''},history:{},navigator:{},setTimeout,clearTimeout};
vm.createContext(c);vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),c);const S=c.window.HDW_ESTIMATES;const out={};
for(const k of Object.keys(S)){const v={};S[k].inputs.forEach(i=>v[i[0]]=i[5]);
 const q=S[k].q.replace(/\{(\w+)\}/g,(_,x)=>Math.round(v[x]).toLocaleString('en-US'));out[k]={q:q,a:S[k].a(v)};}
process.stdout.write(JSON.stringify(out));"""
    import subprocess
    est = json.loads(subprocess.run(["node", "-e", js, os.path.join(ROOT, "assets/js/estimate.js")], capture_output=True, text=True, check=True).stdout)
    for sec in sm["sections"]:
        for href, title in sec["pages"]:
            m = re.match(r"designs/([a-z-]+)/index.html", href)
            if m and m.group(1) in est:
                e = est[m.group(1)]
                q = text(e["q"])
                cards.append({"id": cid(href, q), "page": href, "title": title, "kind": "open", "q": q,
                              "ans": keep(e["a"]) + '<p><a href="/' + href.replace("index.html", "") + '#estimate">Try other numbers →</a></p>'})
    json.dump(cards, open(os.path.join(ROOT, "assets/data/review.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    kinds = {}
    for c in cards:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
    print("review.json: %d cards from %d pages %s" % (len(cards), len({c['page'] for c in cards}), kinds))

if __name__ == "__main__":
    main()
