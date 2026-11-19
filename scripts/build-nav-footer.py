#!/usr/bin/env python3
"""Inline the shared nav and footer into every HTML page.

Single source of truth: assets/templates/nav-footer.html for the nav
shell and the footer, and assets/data/sitemap.json for the order of the
site. From the sitemap this script builds, per page: the grouped nav
menus, the breadcrumb under the nav, the section index with previous and
next links above the footer, the site map on the home page, and the
sitemap page itself.
The template holds the footer (the site description, the "Checked against
docs" stamp and the footer links). This script rewrites only the <nav>...</nav> and
<footer>...</footer> blocks of each page, adjusting relative links for
the page's depth, and changes nothing else outside the marked regions
(<!-- CRUMBS:BEGIN/END -->, <!-- SECTION:BEGIN/END -->,
<!-- SITEMAP:BEGIN/END -->, <!-- CONTINUE:BEGIN/END -->).

The stamp line is built from assets/data/engines.json, so a version or
month change flows through here instead of being edited per page.
Run from the site root: python3 scripts/build-nav-footer.py
"""
import json
from datetime import datetime
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAV_MARKER = "<!-- NAV -->"
FOOTER_MARKER = "<!-- FOOTER -->"

import html as _html


def _esc(t):
    return _html.escape(t, quote=True)


def load_sitemap():
    sm = json.loads((ROOT / "assets/data/sitemap.json").read_text())
    order = []
    where = {}
    for sec in sm["sections"]:
        for i, (path, title) in enumerate(sec["pages"]):
            where[path] = (sec, i)
            order.append((path, title, sec))
    return sm, order, where


_DESC = {}


def page_desc(path):
    """One-line summary of a page, from its meta description, for the next/previous cards."""
    if path not in _DESC:
        p = ROOT / path
        m = re.search(r'<meta name="description" content="([^"]*)"', p.read_text()) if p.exists() else None
        d = _html.unescape(m.group(1)) if m else ""
        if len(d) > 120:
            d = d[:120].rsplit(" ", 1)[0].rstrip(",;:") + "…"
        _DESC[path] = d
    return _DESC[path]


def parts(sm):
    return [s for s in sm["sections"] if s["id"] != "about"]


def lessons(order):
    """Lesson numbers: every page in reading order, except the About section."""
    out, n = {}, 0
    for path, title, sec in order:
        if sec["id"] == "about":
            continue
        n += 1
        out[path] = n
    return out, n


def build_continue(order, prefix):
    nums, total = lessons(order)
    data = [[prefix + p, t, sec["name"], nums[p]] for p, t, sec in order if p in nums]
    blob = _esc(json.dumps(data, ensure_ascii=False))
    return (f'<section class="continue"><div class="wrap"><div id="continue" data-total="{total}" data-order="{blob}">'
            f'<a class="contcard" href="{prefix}{order[0][0]}"><span class="ck">Start the course</span>'
            f'<b>Lesson 1 · {_esc(order[0][1])}</b><span class="cs">{total} lessons in {_PARTS_WORD[0]} parts, in reading order.</span>'
            f'<i>Start →</i></a></div></div></section>')


def build_navlinks(sm, prefix, rel):
    out = [f'<a href="{prefix}index.html"{" aria-current=\"page\"" if rel == "index.html" else ""}>Home</a>']
    for sec in sm["sections"]:
        here = any(p == rel for p, _ in sec["pages"])
        cols = " cols2" if len(sec["pages"]) > 8 else ""
        items = "".join(
            f'<a href="{prefix}{p}"{" aria-current=\"page\"" if p == rel else ""}>{_esc(t)}</a>'
            for p, t in sec["pages"])
        out.append(f'<details class="navgrp{" here" if here else ""}"><summary>{_esc(sec["name"])}</summary>'
                   f'<div class="navmenu{cols}"><p class="navblurb">{_esc(sec["blurb"])}</p>{items}</div></details>')
    return "".join(out)


_LESSONS = {}
_TOTAL = [0]
_PARTS_WORD = ["four"]


def _lesson_label(rel, i, sec):
    if rel in _LESSONS:
        return f"Lesson {_LESSONS[rel]} of {_TOTAL[0]}"
    return f"{i + 1} of {len(sec['pages'])}"


def build_crumbs(sm, where, prefix, rel):
    if rel not in where:
        return ""
    sec, i = where[rel]
    title = sec["pages"][i][1]
    return (f'<div class="crumbs"><div class="wrap"><a href="{prefix}index.html">Home</a><span>›</span>'
            f'<a href="{prefix}{sec["pages"][0][0]}">{_esc(sec["name"])}</a><span>›</span>'
            f'<b aria-current="page">{_esc(title)}</b>'
            f'<em>{_lesson_label(rel, i, sec)}</em></div></div>')


def build_section(sm, order, where, prefix, rel):
    paths = [p for p, _, _ in order]
    P = parts(sm)
    if rel == "index.html":
        cards = []
        for k, s in enumerate(P):
            lis = "".join(f'<li><a href="{prefix}{p}">{_esc(t)}</a></li>' for p, t in s["pages"][:6])
            more = len(s["pages"]) - 6
            more_html = f'<a class="pmore" href="{prefix}sitemap/index.html#{s["id"]}">and {more} more →</a>' if more > 0 else ""
            cards.append(
                f'<div class="partcard"><span class="kicker">Part {k + 1} · {_esc(s["name"])}</span>'
                f'<h3><a href="{prefix}{s["pages"][0][0]}">{_esc(s["question"])}</a></h3>'
                f'<p>{_esc(s["blurb"])}</p>'
                f'<ol start="{_LESSONS[s["pages"][0][0]]}">{lis}</ol>{more_html}'
                f'<a class="pgo" href="{prefix}{s["pages"][0][0]}">Start with {_esc(s["pages"][0][1])} →</a></div>')
        return (f'<section class="secnav" id="map"><div class="wrap"><div class="kicker">The whole site</div>'
                f'<h2>Four parts, one question each</h2>'
                f'<p class="sub">Read them in order as a course, or go straight to the part that matches your question.</p>'
                f'<div class="partgrid">{"".join(cards)}</div>'
                f'<p class="sub" style="margin-top:14px">Not sure where to begin? <a href="{prefix}paths/index.html">Pick a reading path for your goal</a>, '
                f'or open <a href="{prefix}sitemap/index.html">your map of every lesson</a>, with the ones you have read ticked.</p></div></section>')
    if rel not in where:
        return ""
    sec, i = where[rel]
    k = paths.index(rel)
    chips = "".join(
        f'<a href="{prefix}{p}"{" aria-current=\"page\" class=\"on\"" if p == rel else ""}>{_esc(t)}</a>'
        for p, t in sec["pages"])
    def card(cls, j, arrow_left):
        pp, pt, ps = order[j]
        if ps is sec:
            lab = "Previous" if arrow_left else "Next"
        else:
            num = next((n + 1 for n, s in enumerate(P) if s is ps), None)
            lab = (f"Previous part: {ps['name']}" if arrow_left else f"Next part{f' ({num} of {len(P)})' if num else ''}: {ps['name']}") if ps["id"] != "about" else ("Previous: " if arrow_left else "Next: ") + ps["name"]
        d = page_desc(pp)
        lab_html = f'← {_esc(lab)}' if arrow_left else f'{_esc(lab)} →'
        return (f'<a class="pn {cls}" href="{prefix}{pp}"><span>{lab_html}</span>{_esc(pt)}'
                + (f'<em>{_esc(d)}</em>' if d else '') + '</a>')
    prev_html = card("prev", k - 1, True) if k > 0 else f'<a class="pn prev" href="{prefix}index.html"><span>← Home</span>Real databases, simply</a>'
    next_html = card("next", k + 1, False) if k < len(order) - 1 else ""
    if sec["id"] == "about":
        head = f'{_esc(sec["name"])}'
    else:
        num = next(n + 1 for n, s in enumerate(P) if s is sec)
        first, last = _LESSONS[sec["pages"][0][0]], _LESSONS[sec["pages"][-1][0]]
        head = f'Part {num} of {len(P)} · {_esc(sec["name"])} · lessons {first} to {last}'
    return (f'<section class="secnav"><div class="wrap">'
            f'<div class="secnav-head"><span class="kicker">{head}</span>'
            f'<a href="{prefix}sitemap/index.html">All pages</a></div>'
            f'<p class="sub" style="margin:0 0 10px"><b>{_esc(sec["question"])}</b> {_esc(sec["blurb"])}</p>'
            f'<div class="secnav-list">{chips}</div>'
            f'<div class="secnav-pn">{prev_html}{next_html}</div></div></section>')


def build_sitemap_body(sm, prefix):
    blocks = []
    part = 0
    for s in sm["sections"]:
        lis = "".join(f'<li><a href="{prefix}{p}">{_esc(t)}</a></li>' for p, t in s["pages"])
        start = _LESSONS.get(s["pages"][0][0])
        if start:
            part += 1
            label = f"Part {part} · {_esc(s['name'])}"
            ol = f'<ol start="{start}">{lis}</ol>'
        else:
            label = _esc(s["name"])
            ol = f'<ul>{lis}</ul>'
        blocks.append(f'<div class="mapsec" id="{s["id"]}"><h2>{label}</h2>'
                      f'<p class="sub"><b>{_esc(s["question"])}</b> {_esc(s["blurb"])}</p>{ol}</div>')
    return '<div class="mapsecs">' + "".join(blocks) + "</div>"


def put(text, name, html, anchor_before=None, anchor_after=None):
    begin, end = f"<!-- {name}:BEGIN -->", f"<!-- {name}:END -->"
    block = f"{begin}{html}{end}"
    if begin in text:
        return re.sub(re.escape(begin) + r".*?" + re.escape(end), lambda m: block, text, count=1, flags=re.S)
    if anchor_before:
        return text.replace(anchor_before, block + "\n" + anchor_before, 1)
    if anchor_after:
        return text.replace(anchor_after, anchor_after + "\n" + block, 1)
    return text


def main():
    template = (ROOT / "assets/templates/nav-footer.html").read_text()
    nav_src = template.split(NAV_MARKER, 1)[1].split(FOOTER_MARKER, 1)[0].strip()
    footer_src = template.split(FOOTER_MARKER, 1)[1].strip()
    if "<nav>" not in nav_src or "<footer>" not in footer_src:
        print("template is missing the nav or footer block", file=sys.stderr)
        return 1
    if "{{NAVLINKS}}" not in nav_src or "{{ROOT}}" not in footer_src:
        print("template is missing the {{NAVLINKS}} or {{ROOT}} placeholder", file=sys.stderr)
        return 1

    data = json.loads((ROOT / "assets/data/engines.json").read_text())
    upd_path = ROOT / "assets/data/updated.json"
    updated = json.loads(upd_path.read_text()) if upd_path.exists() else {}
    versions = data["versions"]
    stamp = (
        f"Checked against docs: PostgreSQL {versions['postgresql']}, "
        f"MySQL {versions['mysql']}, MongoDB {versions['mongodb']}, "
        f"{data['stamp_month']}."
    )

    sm, order, where = load_sitemap()
    nums, total = lessons(order)
    _LESSONS.update(nums)
    _TOTAL[0] = total
    _PARTS_WORD[0] = {3: "three", 4: "four", 5: "five", 6: "six"}.get(len(parts(sm)), str(len(parts(sm))))
    changed = []
    # The template itself is not a page: never rewrite it.
    pages = sorted(
        p for p in ROOT.rglob("*.html")
        if p.relative_to(ROOT).parts[:2] != ("assets", "templates")
    )
    for page in pages:
        depth = len(page.relative_to(ROOT).parts) - 1
        prefix = "../" * depth
        rel = str(page.relative_to(ROOT))
        nav = nav_src.replace("{{NAVLINKS}}", build_navlinks(sm, prefix, rel)).replace("{{ROOT}}", prefix)
        back_home = ""
        footer = (
            footer_src.replace("{{ROOT}}", prefix)
            .replace("{{BACK_HOME}}", back_home)
            .replace("{{STAMP_DOCS}}", stamp)
        )
        upd = updated.get(rel)
        upd_text = (datetime.strptime(upd, "%Y-%m-%d").strftime("%b %d, %Y").replace(" 0", " ")
                    if upd else data["stamp_month"])
        footer = footer.replace("{{UPDATED}}", upd_text)
        if "{{" in nav or "{{" in footer:
            print(f"{page}: unreplaced placeholder", file=sys.stderr)
            return 1

        text = page.read_text()
        if len(re.findall(r"<nav>", text)) != 1:
            print(f"{page}: expected exactly one <nav>", file=sys.stderr)
            return 1
        if len(re.findall(r"<footer>", text)) != 1:
            print(f"{page}: expected exactly one <footer>", file=sys.stderr)
            return 1
        new_text = re.sub(r"<nav>.*?</nav>", nav, text, count=1, flags=re.S)
        new_text = re.sub(
            r"<footer>.*?</footer>", footer, new_text, count=1, flags=re.S
        )
        # Old hand-made "next page" blocks give way to the generated section index.
        new_text = re.sub(r'<section class="nextpage">.*?</section>\s*', '', new_text, flags=re.S)
        if rel != "index.html" and rel not in where:
            print(f"{page}: not in assets/data/sitemap.json", file=sys.stderr)
            return 1
        new_text = put(new_text, "CRUMBS", build_crumbs(sm, where, prefix, rel), anchor_after="</nav>")
        new_text = put(new_text, "SECTION", build_section(sm, order, where, prefix, rel), anchor_before="<footer>")
        if rel == "sitemap/index.html":
            new_text = put(new_text, "SITEMAP", build_sitemap_body(sm, prefix))
        if rel in ("index.html", "sitemap/index.html"):
            anchor = "</div></header>"
            new_text = put(new_text, "CONTINUE", build_continue(order, prefix), anchor_after=anchor)
        if new_text != text:
            page.write_text(new_text)
            changed.append(str(page.relative_to(ROOT)))

    print(f"nav and footer inlined into {len(pages)} pages; "
          f"changed {len(changed)} files:")
    for f in changed:
        print(f"  {f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
