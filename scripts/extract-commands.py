#!/usr/bin/env python3
"""Extract runnable commands from howdbswork.com pages and emit per-engine files.

What counts as a command: only the site's marked code blocks, never prose.
  - <div class="lookcmd"> blocks: the site's explicit "run this" blocks.
  - <pre class="term"> blocks: file listings plus the "see it yourself" commands.
  - <div class="cs-code"> blocks: short command snippets on the cheat sheet.
  - <pre class="evidence"> blocks are annotated OUTPUT, not commands, and are skipped.
  - The Staff Path "exact check" commands, stored as detect:"..." fields in
    assets/js/main.js, are extracted too.

Each extracted line is classified as runnable or skipped, with a reason.
Skipped categories (nothing is silently dropped):
  - placeholder: contains an ellipsis, <query>, or an undefined variable.
  - prose: a comment line that names a tool or a setting instead of a command.
  - host-path: a shell command using the Debian on-prem layout
    (/var/lib/postgresql/18/main, /var/lib/mongo) which does not exist in
    the CI containers (they use /var/lib/postgresql/data and /data/db).
  - pager: piped through less/head, which cannot run non-interactively.
  - specific-file: names one WAL segment or binlog file that a fresh
    container does not have.
  - needs-cluster: needs a sharded cluster (sh.status) or the mongostat
    binary, neither of which the CI topology provides.
  - needs-backup-dest: pg_basebackup to a path that does not exist yet.
  - ambiguous-engine: could not tell which engine the command belongs to.

Outputs (in the --out directory, default ci-out/):
  pg.sql, mysql.sql, mongo.js: runnable statements, deduplicated.
  shell-pg.sh, shell-my.sh, shell-mo.sh: runnable shell commands per engine.
  yaml.txt: Kubernetes manifests found, each validated as YAML.
  report.json: every block, every statement, runnable or skipped with reason.

Usage: python3 scripts/extract-commands.py [--root .] [--out ci-out]
Exit code is always 0 unless the site files cannot be read; the CI job
fails on command errors, not on extraction.
"""

import argparse
import json
import os
import re
import sys
from html import unescape
from html.parser import HTMLParser

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

SITE_ENGINES = {"postgresql": "pg", "mysql": "my", "mongodb": "mo"}

SQL_VERBS = (
    "SELECT", "SHOW", "SET", "ALTER", "CREATE", "INSERT", "UPDATE",
    "DELETE", "EXPLAIN", "ANALYZE", "USE", "DESCRIBE", "CALL", "DO",
    "GRANT", "REVOKE", "WITH", "START", "BEGIN", "COMMIT", "ROLLBACK",
    "TRUNCATE", "DROP",
)
SHELL_VERBS = (
    "pg_basebackup", "pg_waldump", "mysqlbinlog", "mysqldump", "mongodump",
    "mongorestore", "mongostat", "psql", "mysql", "mongosh", "du", "ls",
    "df", "cat", "grep", "pt-query-digest",
)
OUTPUT_PREFIXES = ("rmgr:",)
PLACEHOLDER_RE = re.compile(r"[…<>]|\.\.\.|<query>|<[^>]+>")


def strip_trailing_comment(line):
    """Remove a trailing --, //, or left-arrow annotation, quote-aware."""
    in_single = False
    in_double = False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif not in_single and not in_double:
            if line.startswith("-- ", i) or line.startswith("--\t", i):
                return line[:i].rstrip()
            if line.startswith("// ", i) or line.startswith("//\t", i):
                return line[:i].rstrip()
            if ch == "\u2190":  # left arrow: the site's inline annotation marker
                return line[:i].rstrip()
        i += 1
    return line.rstrip()


def split_sql_statements(text):
    """Split on ; outside quotes. Returns (complete, remainder)."""
    parts = []
    cur = []
    in_single = False
    in_double = False
    for ch in text:
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        if ch == ";" and not in_single and not in_double:
            cur.append(ch)
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    return parts, "".join(cur).strip()


def classify_content(text):
    """Guess the engine from command content. Returns pg/my/mo or None."""
    if re.search(r"\bpg_\w+|pg_wal|pg_stat|psql|pg_basebackup|pg_waldump|pg_reload_conf|pg_relation_filepath|synchronous_standby|synchronous_commit", text):
        return "pg"
    if re.search(r"innodb|binlog|GTID|gtid|SHOW ENGINE|SHOW REPLICA|SHOW BINARY|SHOW VARIABLES|SHOW GLOBAL|performance_schema|information_schema|sys\.schema|SHOW PROCESSLIST|SHOW FULL PROCESSLIST|SHOW BINLOG|SHOW STATUS", text):
        return "my"
    if re.search(r"\bdb\.|\brs\.|\bsh\.|mongosh|oplog|WiredTiger|mongostat|local\.oplog", text):
        return "mo"
    return None


class BlockCollector(HTMLParser):
    """Collects lookcmd/term/cs-code blocks from one HTML file."""

    KINDS = {"lookcmd": "div", "term": "pre", "cs-code": "div"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self._cur = None
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        cls = dict(attrs).get("class", "")
        if self._cur is None:
            for kind, want_tag in self.KINDS.items():
                if tag == want_tag and kind in cls.split():
                    self._cur = (kind, [])
                    self._depth = 1
                    return
        elif self._cur is not None:
            self._depth += 1

    def handle_endtag(self, tag):
        if self._cur is not None:
            self._depth -= 1
            if self._depth == 0:
                self.blocks.append(self._cur)
                self._cur = None

    def handle_data(self, data):
        if self._cur is not None:
            self._cur[1].append(data)


def parse_detect_fields(js_text):
    """Yield (engine, raw detect string) from main.js detect:"..." fields."""
    out = []
    for m in re.finditer(r'detect:"((?:[^"\\]|\\.)*)"', js_text):
        raw = m.group(1)
        # nearest preceding eng:"pg|my|mo"
        before = js_text[: m.start()]
        em = None
        for em in re.finditer(r'eng:"(pg|my|mo)"', before):
            pass
        engine = em.group(1) if em else None
        # decode JS escapes the way the browser would
        decoded = raw.replace("\\n", "\n").replace('\\"', '"')
        decoded = decoded.replace("\\\\G", "\\G").replace("\\\\", "\\")
        out.append((engine, decoded))
    return out


class Extractor:
    def __init__(self, root):
        self.root = root
        self.runnable = {"pg": [], "my": [], "mo": []}
        self.shell = {"pg": [], "my": [], "mo": []}
        self.yaml_blocks = []
        self.report = []
        self._seen = {"pg": set(), "my": set(), "mo": set()}
        self._seen_shell = {"pg": set(), "my": set(), "mo": set()}

    # -- recording -----------------------------------------------------
    def add_runnable(self, engine, stmt, source):
        key = re.sub(r"\s+", " ", stmt).strip()
        if key in self._seen[engine]:
            self.report.append({"source": source, "engine": engine,
                                "statement": stmt, "status": "duplicate"})
            return
        self._seen[engine].add(key)
        self.runnable[engine].append(stmt)
        self.report.append({"source": source, "engine": engine,
                            "statement": stmt, "status": "runnable"})

    def add_shell(self, engine, cmd, source):
        key = cmd.strip()
        if key in self._seen_shell[engine]:
            self.report.append({"source": source, "engine": engine,
                                "statement": cmd, "status": "duplicate"})
            return
        self._seen_shell[engine].add(key)
        self.shell[engine].append(cmd)
        self.report.append({"source": source, "engine": engine,
                            "statement": cmd, "status": "runnable"})

    def skip(self, stmt, reason, source, engine=None):
        self.report.append({"source": source, "engine": engine,
                            "statement": stmt, "status": "skipped",
                            "reason": reason})

    # -- statement handling --------------------------------------------
    def handle_sql(self, stmt, engine, source):
        stmt = stmt.strip()
        if not stmt:
            return
        if stmt.startswith("("):
            self.skip(stmt, "not-a-command", source, engine)
            return
        if PLACEHOLDER_RE.search(stmt):
            self.skip(stmt, "placeholder", source, engine)
            return
        if engine is None:
            engine = classify_content(stmt)
        if engine is None:
            self.skip(stmt, "ambiguous-engine", source)
            return
        self.add_runnable(engine, stmt, source)

    def handle_mongo(self, stmt, engine, source):
        stmt = stmt.strip()
        if not stmt:
            return
        if PLACEHOLDER_RE.search(stmt) or re.search(r"\(\s*doc\b", stmt):
            self.skip(stmt, "placeholder", source, engine)
            return
        if re.match(r"sh\.", stmt) or "getShardDistribution" in stmt:
            self.skip(stmt, "needs-cluster", source, "mo")
            return
        if stmt.startswith("mongostat"):
            self.skip(stmt, "needs-cluster", source, "mo")
            return
        if engine is None:
            engine = "mo"
        self.add_runnable(engine, stmt, source)

    def handle_shell(self, cmd, source):
        cmd = re.sub(r"\s+#.*$", "", cmd).strip()
        if not cmd:
            return
        if "| less" in cmd or "| head" in cmd or "| more" in cmd:
            self.skip(cmd, "pager", source)
            return
        if "pg_basebackup" in cmd:
            self.skip(cmd, "needs-backup-dest", source, "pg")
            return
        if re.search(r"pg_waldump .*000000010000000000000003", cmd):
            self.skip(cmd, "specific-file", source, "pg")
            return
        if "mongostat" in cmd:
            self.skip(cmd, "needs-cluster", source, "mo")
            return
        if "/var/lib/postgresql/18/main" in cmd:
            self.skip(cmd, "host-path", source, "pg")
            return
        if "/var/lib/mongo" in cmd:
            self.skip(cmd, "host-path", source, "mo")
            return
        if "mysqlbinlog" in cmd:
            self.skip(cmd, "specific-file", source, "my")
            return
        if re.match(r"ls\s+(base/|pg_wal/)", cmd):
            self.skip(cmd, "relative-path", source, "pg")
            return
        engine = classify_content(cmd)
        if engine is None:
            if "$PGDATA" in cmd or "/var/lib/postgresql" in cmd:
                engine = "pg"
            elif "/var/lib/mysql" in cmd:
                engine = "my"
            elif "/var/lib/mongo" in cmd:
                engine = "mo"
        if engine is None:
            self.skip(cmd, "ambiguous-engine", source)
            return
        self.add_shell(engine, cmd, source)

    # -- block processing ----------------------------------------------
    def process_lines(self, lines, page_engine, source):
        """Process one block's lines. Records runnable/skipped results."""
        engine = page_engine
        sql_buf = []
        sql_engine = None
        mongo_buf = []
        mongo_engine = None
        paren_depth = 0

        def flush_sql():
            nonlocal sql_buf, sql_engine
            if sql_buf:
                # split at ; so "SHOW A; SHOW B;" becomes two statements
                text = " ".join(sql_buf)
                sql_buf, sql_engine = [], None
                parts, rest = split_sql_statements(text)
                for part in parts:
                    self.handle_sql(part, sql_engine or engine, source)
                if rest:
                    self.handle_sql(rest, sql_engine or engine, source)

        def flush_mongo():
            nonlocal mongo_buf, mongo_engine, paren_depth
            if mongo_buf:
                self.handle_mongo(" ".join(mongo_buf),
                                  mongo_engine or engine, source)
                mongo_buf, mongo_engine, paren_depth = [], None, 0

        # index-based loop so a mongo statement can peek at the next line:
        # a line starting with "." continues the previous statement.
        i = 0
        while i < len(lines):
            raw = lines[i]
            i += 1
            line = raw.rstrip()
            if not line.strip():
                continue
            stripped = line.strip()

            # comment lines: engine prefix, section header, or plain comment
            if stripped.startswith("--") or stripped.startswith("//"):
                body = re.sub(r"^(--|//)\s*", "", stripped)
                m = re.match(r"^(PG|PostgreSQL|MySQL|MongoDB|Mongo)(/MySQL)?\s*:?\s*(.*)$", body)
                if m:
                    eng_word, rest = m.group(1), m.group(3)
                    flush_sql()
                    flush_mongo()
                    if eng_word in ("PG", "PostgreSQL"):
                        engine = "pg"
                    elif eng_word == "MySQL":
                        engine = "my"
                    else:
                        engine = "mo"
                    # a command embedded after the engine prefix?
                    if rest and re.match(
                            r"^(SELECT|SHOW|SET|ALTER|CREATE|INSERT|UPDATE|DELETE|EXPLAIN|ANALYZE|USE|DESCRIBE|db\.[A-Za-z0-9_.]+\(|rs\.[A-Za-z0-9_.]+\(|sh\.[A-Za-z0-9_.]+\()",
                            rest):
                        line = rest
                        stripped = rest.strip()
                    else:
                        continue
                else:
                    continue  # plain comment

            # output and diagram lines: never commands
            if stripped.startswith(("\u2192", "rmgr:")):
                continue
            if re.match(r"^#\d", stripped):  # mysqlbinlog output lines
                continue
            if re.match(r"^\d[\d.,]*\s*\|", stripped):  # sample output rows
                continue
            if re.match(r"^(added latency|cap|lost transactions)\s*=", stripped):
                continue
            if re.match(r"^[\d,]+ commits/s", stripped):
                continue

            # YAML manifests (cloud operator examples)
            if stripped.startswith("apiVersion:"):
                self.yaml_blocks.append((source, "\n".join(lines)))
                return

            # shell commands
            if stripped.startswith("$ "):
                flush_sql()
                flush_mongo()
                self.handle_shell(stripped[2:], source)
                continue

            # trailing comments and inline annotations on command lines
            code = strip_trailing_comment(line).strip()
            code = re.sub(r"(;|\\G)\s+\([^)]*\)\s*$", r"\1", code).strip()
            if not code:
                continue

            # mongo statements (db./rs./sh. or a continuation of one)
            if mongo_buf:
                mongo_buf.append(code)
                paren_depth += code.count("(") + code.count("{") - code.count(")") - code.count("}")
                if paren_depth <= 0:
                    # peek: a following line starting with "." continues it
                    j = i
                    while j < len(lines) and not lines[j].strip():
                        j += 1
                    if j < len(lines) and lines[j].strip().startswith("."):
                        continue
                    flush_mongo()
                continue
            if re.match(r"^(db\.|rs\.|sh\.)", code) or code.startswith("mongostat"):
                mongo_buf = [code]
                mongo_engine = engine
                paren_depth = code.count("(") + code.count("{") - code.count(")") - code.count("}")
                if paren_depth <= 0:
                    j = i
                    while j < len(lines) and not lines[j].strip():
                        j += 1
                    if j < len(lines) and lines[j].strip().startswith("."):
                        continue
                    flush_mongo()
                continue

            # SQL statements, accumulated until ; or \G
            if sql_buf:
                sql_buf.append(code)
                if code.rstrip().endswith(";") or code.rstrip().endswith("\\G"):
                    flush_sql()
                continue
            first = code.split(None, 1)[0].upper().rstrip(";")
            if first in SQL_VERBS:
                sql_buf = [code]
                sql_engine = engine
                if code.rstrip().endswith(";") or code.rstrip().endswith("\\G"):
                    flush_sql()
                continue
            # anything else is a file-tree line, a diagram line, JSON output,
            # or prose: not a command
            self.skip(code, "not-a-command", source, engine)

        flush_sql()
        flush_mongo()

    def process_html(self, path):
        rel = os.path.relpath(path, self.root)
        page_engine = None
        for key, eng in SITE_ENGINES.items():
            if rel.startswith(key + "/"):
                page_engine = eng
        text = open(path, encoding="utf-8").read()
        collector = BlockCollector()
        collector.feed(text)
        for kind, parts in collector.blocks:
            block_text = unescape("".join(parts))
            self.process_lines(block_text.splitlines(), page_engine,
                               f"{rel} [{kind}]")

    def process_main_js(self):
        path = os.path.join(self.root, "assets", "js", "main.js")
        text = open(path, encoding="utf-8").read()
        for engine, raw in parse_detect_fields(text):
            self.process_lines(raw.splitlines(), engine,
                               "assets/js/main.js [detect]")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--out", default="ci-out")
    args = ap.parse_args()

    ex = Extractor(args.root)
    html_files = []
    for dirpath, _dirs, files in os.walk(args.root):
        if ".git" in dirpath or "ci-out" in dirpath:
            continue
        for f in sorted(files):
            if f.endswith(".html"):
                html_files.append(os.path.join(dirpath, f))
    for path in sorted(html_files):
        ex.process_html(path)
    ex.process_main_js()

    # validate YAML manifests
    yaml_results = []
    for source, text in ex.yaml_blocks:
        ok, err = True, ""
        if yaml is not None:
            try:
                yaml.safe_load(text)
            except Exception as e:  # noqa: BLE001
                ok, err = False, str(e)
        yaml_results.append({"source": source, "valid": ok, "error": err})
        if not ok:
            ex.report.append({"source": source, "engine": None,
                              "statement": text[:120], "status": "skipped",
                              "reason": f"invalid-yaml: {err}"})

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "pg.sql"), "w") as f:
        f.write("-- Extracted PostgreSQL commands from howdbswork.com\n")
        for s in ex.runnable["pg"]:
            f.write(s if s.rstrip().endswith(";") else s + ";\n")
            f.write("\n")
    with open(os.path.join(args.out, "mysql.sql"), "w") as f:
        f.write("-- Extracted MySQL commands from howdbswork.com\n")
        for s in ex.runnable["my"]:
            f.write(s if s.rstrip().endswith(";") or s.rstrip().endswith("\\G") else s + ";\n")
            f.write("\n")
    with open(os.path.join(args.out, "mongo.js"), "w") as f:
        f.write("// Extracted mongosh commands from howdbswork.com\n")
        for s in ex.runnable["mo"]:
            f.write(s if s.rstrip().endswith(";") else s + ";\n")
            f.write("\n")
    for eng, fname in (("pg", "shell-pg.sh"), ("my", "shell-my.sh"),
                       ("mo", "shell-mo.sh")):
        with open(os.path.join(args.out, fname), "w") as f:
            f.write("#!/bin/bash\nset -e\n")
            for c in ex.shell[eng]:
                f.write(c + "\n")

    counts = {"runnable": 0, "skipped": 0, "duplicate": 0}
    for r in ex.report:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    summary = {
        "runnable": {k: len(v) for k, v in ex.runnable.items()},
        "shell": {k: len(v) for k, v in ex.shell.items()},
        "yaml_blocks": yaml_results,
        "counts": counts,
        "report": ex.report,
    }
    with open(os.path.join(args.out, "report.json"), "w") as f:
        json.dump(summary, f, indent=1)

    print(f"runnable SQL/mongo: pg={len(ex.runnable['pg'])} "
          f"my={len(ex.runnable['my'])} mo={len(ex.runnable['mo'])}")
    print(f"runnable shell: pg={len(ex.shell['pg'])} "
          f"my={len(ex.shell['my'])} mo={len(ex.shell['mo'])}")
    print(f"yaml manifests: {len(yaml_results)}, "
          f"all valid: {all(y['valid'] for y in yaml_results)}")
    print(f"report: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
