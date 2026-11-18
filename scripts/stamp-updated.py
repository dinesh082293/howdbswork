#!/usr/bin/env python3
"""Record the "Last updated" date of each page in assets/data/updated.json.

Run before committing a change: every page that git reports as modified or
new gets today's date (UTC); every other page keeps its recorded date, or the
date of its last commit if it has none yet. build-nav-footer.py reads the file,
so the footer date never depends on git history being present (CI clones are
shallow).
Run from the site root: python3 scripts/stamp-updated.py
"""
import json, re, subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "assets/data/updated.json"


def git(*a):
    return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True).stdout


def main():
    data = json.loads(DATA.read_text()) if DATA.exists() else {}
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    changed = set()
    def body(text):
        # The nav and footer are rebuilt on every page by build-nav-footer.py,
        # so a change there does not count as an update to the page.
        return re.sub(r"<(nav|footer)>.*?</\1>", "", text, flags=re.S)

    for line in git("status", "--porcelain", "--untracked-files=all").splitlines():
        path = line[3:].strip().strip('"')
        if not path.endswith(".html"):
            continue
        before = git("show", "HEAD:" + path)
        now = (ROOT / path).read_text() if (ROOT / path).exists() else ""
        if not before or body(before) != body(now):
            changed.add(path)
    pages = sorted(str(p.relative_to(ROOT)) for p in ROOT.rglob("index.html")
                   if p.relative_to(ROOT).parts[0] != "assets")
    for page in pages:
        if page in changed:
            data[page] = today
        elif page not in data:
            data[page] = git("log", "-1", "--format=%cs", "--", page).strip() or today
    DATA.write_text(json.dumps(dict(sorted(data.items())), indent=2) + "\n")
    print(f"updated.json: {len(pages)} pages, {len(changed & set(pages))} stamped {today}")


if __name__ == "__main__":
    main()
