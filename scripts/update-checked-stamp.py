#!/usr/bin/env python3
"""Update the site's "Checked against docs" stamp month after a passing CI run.

Reads the current month from the system clock, compares it with
assets/data/engines.json, and if the month has rolled over, updates the
stamp month in engines.json and re-runs scripts/build-nav-footer.py so
every page's footer stamp picks up the new month from the template.
There is no "Measured on" line in the shared footer: that claim lives
only on the Decisions page, where it is true for that page's benchmarks.

This script only edits files. The CI workflow decides whether to commit
and push, and only runs this on pushes to main.
Run from the site root: python3 scripts/update-checked-stamp.py
"""
import json
import subprocess
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

    data["stamp_month"] = new_month
    data_path.write_text(json.dumps(data, indent=2) + "\n")

    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/build-nav-footer.py")],
        check=False,
    )
    if result.returncode != 0:
        print("build-nav-footer.py failed after updating engines.json",
              file=sys.stderr)
        return result.returncode
    print(f"stamp updated {old_month} -> {new_month}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
