#!/usr/bin/env python3
"""Check the site stays consistent with assets/data/engines.json.

Verifies three things, and nothing else:
1. Every HTML page's footer "Checked against" stamp matches the versions
   and month in engines.json.
2. Each shared number in engines.json appears verbatim on its page.
3. Each engine page names its own version from engines.json.

Exit 0 when everything matches, 1 with a list of mismatches otherwise.
Run from the site root: python3 scripts/check-engines.py --root .
"""
import argparse
import json
import re
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    args = ap.parse_args()
    root = Path(args.root)
    data = json.loads((root / "assets/data/engines.json").read_text())
    versions = data["versions"]
    stamp = (
        f"Checked against PostgreSQL {versions['postgresql']}, "
        f"MySQL {versions['mysql']}, MongoDB {versions['mongodb']}, "
        f"{data['stamp_month']}."
    )
    errors = []

    pages = sorted(root.rglob("*.html"))
    for page in pages:
        text = page.read_text()
        m = re.search(r"Checked against [^<]*\.", text)
        if not m:
            errors.append(f"{page}: no Checked against stamp found")
        elif m.group(0) != stamp:
            errors.append(f"{page}: stamp is {m.group(0)!r}, expected {stamp!r}")

    for item in data.get("shared_numbers", []):
        text = (root / item["page"]).read_text()
        if item["text"] not in text:
            errors.append(
                f"{item['page']}: missing {item['label']} {item['text']!r}"
            )

    for page, version in data.get("engine_pages", {}).items():
        text = (root / page).read_text()
        if version not in text:
            errors.append(f"{page}: missing version string {version!r}")

    if errors:
        print("engines.json consistency check FAILED:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"engines.json consistency check passed ({len(pages)} pages, "
          f"{len(data.get('shared_numbers', []))} shared numbers)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
