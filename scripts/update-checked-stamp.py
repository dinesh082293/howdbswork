#!/usr/bin/env python3
"""Update the site's "Checked against" stamp month after a passing CI run.

Reads the current month from the system clock, compares it with
assets/data/engines.json, and if the month has rolled over, updates the
stamp month in engines.json and rewrites the footer stamp on every HTML
page. Prints the files changed, or that the stamp is already current.

This script only edits files. The CI workflow decides whether to commit
and push, and only runs this on pushes to main.
Run from the site root: python3 scripts/update-checked-stamp.py
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    data_path = ROOT / "assets/data/engines.json"
    data = json.loads(data_path.read_text())
    new_month = datetime.now().strftime("%b %Y")
    old_month = data["stamp_month"]
    if new_month == old_month:
        print(f"stamp is current ({old_month}); nothing to do")
        return 0

    versions = data["versions"]
    old_stamp = (
        f"Checked against PostgreSQL {versions['postgresql']}, "
        f"MySQL {versions['mysql']}, MongoDB {versions['mongodb']}, "
        f"{old_month}."
    )
    new_stamp = (
        f"Checked against PostgreSQL {versions['postgresql']}, "
        f"MySQL {versions['mysql']}, MongoDB {versions['mongodb']}, "
        f"{new_month}."
    )

    data["stamp_month"] = new_month
    data_path.write_text(json.dumps(data, indent=2) + "\n")

    changed = [str(data_path.relative_to(ROOT))]
    for page in sorted(ROOT.rglob("*.html")):
        text = page.read_text()
        if old_stamp in text:
            page.write_text(text.replace(old_stamp, new_stamp))
            changed.append(str(page.relative_to(ROOT)))
        else:
            m = re.search(r"Checked against [^<]*\.", text)
            if m:
                print(f"WARNING: {page} has an unexpected stamp: {m.group(0)!r}",
                      file=sys.stderr)
    print(f"stamp updated {old_month} -> {new_month}; changed {len(changed)} files:")
    for f in changed:
        print(f"  {f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
