#!/usr/bin/env python3
"""Inline the shared nav and footer into every HTML page.

Single source of truth: assets/templates/nav-footer.html. The template
holds the nav (11 links, Decisions points at decisions/index.html) and
the footer (the "one invariant" paragraph, the site description, the
"Checked against docs" stamp, the "Measured on" line, and the References
link). This script rewrites only the <nav>...</nav> and
<footer>...</footer> blocks of each page, adjusting relative links for
the page's depth, and changes nothing else.

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


def main():
    template = (ROOT / "assets/templates/nav-footer.html").read_text()
    nav_src = template.split(NAV_MARKER, 1)[1].split(FOOTER_MARKER, 1)[0].strip()
    footer_src = template.split(FOOTER_MARKER, 1)[1].strip()
    if "<nav>" not in nav_src or "<footer>" not in footer_src:
        print("template is missing the nav or footer block", file=sys.stderr)
        return 1
    if "{{ROOT}}" not in nav_src or "{{ROOT}}" not in footer_src:
        print("template is missing the {{ROOT}} placeholder", file=sys.stderr)
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

    changed = []
    # The template itself is not a page: never rewrite it.
    pages = sorted(
        p for p in ROOT.rglob("*.html")
        if p.relative_to(ROOT).parts[:2] != ("assets", "templates")
    )
    for page in pages:
        depth = len(page.relative_to(ROOT).parts) - 1
        prefix = "../" * depth
        nav = nav_src.replace("{{ROOT}}", prefix)
        if page.relative_to(ROOT) == Path("index.html"):
            back_home = ""
        else:
            back_home = (
                f'  <p style="margin-bottom:16px">'
                f'<a href="{prefix}index.html">\u2190 Back to home</a></p>\n'
            )
        footer = (
            footer_src.replace("{{ROOT}}", prefix)
            .replace("{{BACK_HOME}}", back_home)
            .replace("{{STAMP_DOCS}}", stamp)
        )
        rel = str(page.relative_to(ROOT))
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
