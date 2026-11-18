#!/usr/bin/env python3
"""Lab notebooks: real experiments against PostgreSQL 18, MySQL 8.4 and
MongoDB 8.0, run by .github/workflows/lab-notebooks.yml on a GitHub
Actions runner. Each notebook writes a plain-text transcript to the output
directory. The site pastes these transcripts as they are, with the run date.

Usage: python3 scripts/notebooks/run_all.py OUTDIR
Expects the three containers from the workflow on localhost:5432, 3306, 27017.
"""
import os, re, sys, time, json, datetime, traceback, platform

import psycopg2
import pymysql
from pymongo import MongoClient, WriteConcern
from pymongo.errors import PyMongoError

OUT = sys.argv[1] if len(sys.argv) > 1 else "lab-output"
os.makedirs(OUT, exist_ok=True)


class Log:
    def __init__(self, name):
        self.name, self.lines = name, []
    def __call__(self, *a):
        line = " ".join(str(x) for x in a)
        print(line, flush=True)
        self.lines.append(line)
    def save(self):
        with open(os.path.join(OUT, self.name + ".txt"), "w") as f:
            f.write("\n".join(self.lines) + "\n")


def pg(autocommit=True):
    c = psycopg2.connect(host="127.0.0.1", port=5432, user="postgres", password="ci", dbname="shop")
    c.autocommit = autocommit
    return c


def my(autocommit=True):
    return pymysql.connect(host="127.0.0.1", port=3306, user="root", password="rootpass",
                           database="shop", autocommit=autocommit)


def mo():
    return MongoClient("mongodb://127.0.0.1:27017/?directConnection=true")


def q1(conn, sql, args=None):
    with conn.cursor() as cur:
        cur.execute(sql, args)
        try:
            return cur.fetchall()
        except Exception:
            return None


def header(log, title):
    log("# " + title)
    log("# run at:", datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"))
    log("# runner:", platform.platform(), "|", os.cpu_count(), "vCPU")
    try:
        log("# PostgreSQL:", q1(pg(), "SHOW server_version")[0][0])
    except Exception as e:
        log("# PostgreSQL: unavailable", e)
    try:
        log("# MySQL:", q1(my(), "SELECT VERSION()")[0][0])
    except Exception as e:
        log("# MySQL: unavailable", e)
    try:
        log("# MongoDB:", mo().admin.command("buildInfo")["version"])
    except Exception as e:
        log("# MongoDB: unavailable", e)
    log("")


def hll(conn):
    s = q1(conn, "SHOW ENGINE INNODB STATUS")[0][2]
    m = re.search(r"History list length (\d+)", s)
    return int(m.group(1)) if m else -1


def mongo_plan_stages(p):
    out = []
    while p:
        out.append(p.get("stage"))
        p = p.get("inputStage") or (p.get("inputStages") or [None])[0]
    return " <- ".join(out)


def mongo_explain(log, cursor_or_cmd):
    ex = cursor_or_cmd
    es = ex["executionStats"]
    log("  plan:", mongo_plan_stages(ex["queryPlanner"]["winningPlan"].get("queryPlan", ex["queryPlanner"]["winningPlan"])))
    log("  nReturned:", es["nReturned"], "| totalKeysExamined:", es["totalKeysExamined"],
        "| totalDocsExamined:", es["totalDocsExamined"], "| executionTimeMillis:", es["executionTimeMillis"])


# ---------------------------------------------------------------- notebook 1
def nb_long_transaction():
    log = Log("long-transaction")
    header(log, "Notebook 1: what one open transaction costs")
    # PostgreSQL
    log("## PostgreSQL 18: a REPEATABLE READ snapshot held open while 5 x 100,000 rows are updated")
    b = pg()
    q1(b, "DROP TABLE IF EXISTS nb_accounts")
    q1(b, "CREATE TABLE nb_accounts (id int PRIMARY KEY, balance int) WITH (autovacuum_enabled = off)")
    q1(b, "INSERT INTO nb_accounts SELECT g, 100 FROM generate_series(1, 100000) g")
    q1(b, "VACUUM ANALYZE nb_accounts")
    size = lambda: q1(b, "SELECT pg_size_pretty(pg_total_relation_size('nb_accounts'))")[0][0]
    log("table size at start:", size())
    a = pg(autocommit=False)
    q1(a, "BEGIN ISOLATION LEVEL REPEATABLE READ")
    log("session A: BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) ->", q1(a, "SELECT count(*) FROM nb_accounts")[0][0])
    for i in range(5):
        q1(b, "UPDATE nb_accounts SET balance = balance + 1")
    log("session B: 5 x UPDATE nb_accounts SET balance = balance + 1  (500,000 new row versions)")
    log("table size now:", size())
    b.notices.clear()
    q1(b, "VACUUM (VERBOSE) nb_accounts")
    log("session B: VACUUM (VERBOSE) nb_accounts while A is still open:")
    for n in b.notices:
        for line in n.strip().splitlines():
            if re.search(r"tuples:|removable cutoff|pages:|dead but not yet", line):
                log("  " + line.strip())
    log("dead tuples (pg_stat_user_tables):", q1(b, "SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname='nb_accounts'")[0][0])
    a.rollback()
    log("session A: ROLLBACK  (the snapshot is released)")
    b.notices.clear()
    q1(b, "VACUUM (VERBOSE) nb_accounts")
    log("session B: VACUUM (VERBOSE) nb_accounts again:")
    for n in b.notices:
        for line in n.strip().splitlines():
            if re.search(r"tuples:|removable cutoff|pages:|dead but not yet", line):
                log("  " + line.strip())
    log("table size after VACUUM:", size(), " <- VACUUM made the space reusable; the file did not shrink")
    log("")
    # MySQL
    log("## MySQL 8.4: a consistent snapshot held open while 5 x 100,000 rows are updated")
    b = my()
    q1(b, "DROP TABLE IF EXISTS nb_accounts")
    q1(b, "CREATE TABLE nb_accounts (id int PRIMARY KEY, balance int)")
    q1(b, "SET SESSION cte_max_recursion_depth = 1000000")
    q1(b, "INSERT INTO nb_accounts WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 100000) SELECT n, 100 FROM s")
    time.sleep(3)
    log("History list length at start:", hll(b))
    a = my(autocommit=False)
    q1(a, "START TRANSACTION WITH CONSISTENT SNAPSHOT")
    log("session A: START TRANSACTION WITH CONSISTENT SNAPSHOT; SELECT COUNT(*) ->", q1(a, "SELECT COUNT(*) FROM nb_accounts")[0][0])
    for i in range(5):
        q1(b, "UPDATE nb_accounts SET balance = balance + 1")
    log("session B: 5 x UPDATE nb_accounts SET balance = balance + 1")
    time.sleep(3)
    log("History list length while A is open:", hll(b))
    a.commit()
    log("session A: COMMIT")
    t0 = time.time()
    while True:
        time.sleep(2)
        h = hll(b)
        log("  %2ds after COMMIT, History list length: %d" % (time.time() - t0, h))
        if h < 1000 or time.time() - t0 > 40:
            break
    log("")
    # MongoDB
    log("## MongoDB 8.0: a multi-document transaction left open past the lifetime limit")
    c = mo()
    adm = c.admin
    old = adm.command({"getParameter": 1, "transactionLifetimeLimitSeconds": 1})["transactionLifetimeLimitSeconds"]
    log("transactionLifetimeLimitSeconds default:", old, "| set to 10 for this run")
    adm.command({"setParameter": 1, "transactionLifetimeLimitSeconds": 10})
    db = c.shop
    db.nb_tx.drop(); db.nb_tx.insert_one({"_id": 1, "balance": 100})
    before = adm.command("serverStatus")["transactions"]["totalAborted"]
    s = c.start_session()
    s.start_transaction()
    db.nb_tx.update_one({"_id": 1}, {"$inc": {"balance": 10}}, session=s)
    log("session A: startTransaction; updateOne({_id: 1}, {$inc: {balance: 10}})")
    log("session A: waits 25 s without committing")
    time.sleep(25)
    try:
        s.commit_transaction()
        log("session A: commitTransaction -> committed")
    except PyMongoError as e:
        log("session A: commitTransaction ->", type(e).__name__ + ":", str(e).split(", full error")[0][:200])
    after = adm.command("serverStatus")["transactions"]["totalAborted"]
    log("serverStatus().transactions.totalAborted: before", before, "after", after)
    log("balance now:", db.nb_tx.find_one({"_id": 1})["balance"])
    adm.command({"setParameter": 1, "transactionLifetimeLimitSeconds": old})
    log.save()


# ---------------------------------------------------------------- notebook 2
def nb_commit_cost():
    log = Log("commit-cost")
    header(log, "Notebook 2: what waiting for the log costs per commit")
    N = 2000
    log("Each run: %d single-row INSERTs, one commit each, from one client on the same machine." % N)
    log("The runner disk is a cloud VM disk. Absolute numbers will differ on your hardware; the ratio is the point.")
    log("")
    log("## PostgreSQL 18: synchronous_commit on vs off")
    c = pg()
    q1(c, "DROP TABLE IF EXISTS nb_log"); q1(c, "CREATE TABLE nb_log (id bigserial PRIMARY KEY, v int)")
    for mode in ("on", "off", "on"):
        q1(c, "SET synchronous_commit = " + mode)
        t = time.perf_counter()
        for i in range(N):
            q1(c, "INSERT INTO nb_log (v) VALUES (%s)", (i,))
        dt = time.perf_counter() - t
        log("  synchronous_commit = %-3s  %6.0f commits/s  %.3f ms per commit" % (mode, N / dt, 1000 * dt / N))
    log("")
    log("## MySQL 8.4: innodb_flush_log_at_trx_commit and sync_binlog")
    c = my()
    q1(c, "DROP TABLE IF EXISTS nb_log"); q1(c, "CREATE TABLE nb_log (id bigint AUTO_INCREMENT PRIMARY KEY, v int)")
    for flush, sb in ((1, 1), (2, 0), (1, 1)):
        q1(c, "SET GLOBAL innodb_flush_log_at_trx_commit = %d" % flush)
        q1(c, "SET GLOBAL sync_binlog = %d" % sb)
        t = time.perf_counter()
        for i in range(N):
            q1(c, "INSERT INTO nb_log (v) VALUES (%s)", (i,))
        dt = time.perf_counter() - t
        log("  innodb_flush_log_at_trx_commit = %d, sync_binlog = %d  %6.0f commits/s  %.3f ms per commit" % (flush, sb, N / dt, 1000 * dt / N))
    q1(c, "SET GLOBAL innodb_flush_log_at_trx_commit = 1"); q1(c, "SET GLOBAL sync_binlog = 1")
    log("")
    log("## MongoDB 8.0 (single-node replica set): write concern j: true vs j: false")
    db = mo().shop
    db.nb_log.drop()
    for j in (True, False, True):
        coll = db.get_collection("nb_log", write_concern=WriteConcern(w=1, j=j))
        t = time.perf_counter()
        for i in range(N):
            coll.insert_one({"v": i})
        dt = time.perf_counter() - t
        log("  w: 1, j: %-5s  %6.0f commits/s  %.3f ms per commit" % (str(j).lower(), N / dt, 1000 * dt / N))
    log.save()


# ---------------------------------------------------------------- notebook 3
def nb_scan_vs_index():
    log = Log("scan-vs-index")
    header(log, "Notebook 3: one lookup in 1,000,000 rows, without and with an index")
    log("## PostgreSQL 18")
    c = pg()
    q1(c, "DROP TABLE IF EXISTS nb_users")
    q1(c, "CREATE TABLE nb_users (id int PRIMARY KEY, email text, pad text)")
    q1(c, "INSERT INTO nb_users SELECT g, 'user' || g || '@example.com', repeat('x', 100) FROM generate_series(1, 1000000) g")
    q1(c, "VACUUM ANALYZE nb_users")
    q1(c, "SET max_parallel_workers_per_gather = 0")
    log("table size:", q1(c, "SELECT pg_size_pretty(pg_relation_size('nb_users'))")[0][0], "|",
        q1(c, "SELECT relpages FROM pg_class WHERE relname = 'nb_users'")[0][0], "pages of 8 KB")
    sql = "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT * FROM nb_users WHERE email = 'user500000@example.com'"
    log("-- no index on email (parallel query off, to show one plain scan)")
    for r in q1(c, sql): log("  " + r[0])
    q1(c, "CREATE INDEX nb_users_email ON nb_users (email)")
    log("-- after CREATE INDEX nb_users_email ON nb_users (email)")
    for r in q1(c, sql): log("  " + r[0])
    log("")
    log("## MySQL 8.4")
    c = my()
    q1(c, "DROP TABLE IF EXISTS nb_users")
    q1(c, "CREATE TABLE nb_users (id int PRIMARY KEY, email varchar(64), pad varchar(100))")
    q1(c, "SET SESSION cte_max_recursion_depth = 2000000")
    q1(c, "INSERT INTO nb_users WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 1000000) SELECT n, CONCAT('user', n, '@example.com'), REPEAT('x', 100) FROM s")
    q1(c, "ANALYZE TABLE nb_users")
    sel = "SELECT * FROM nb_users WHERE email = 'user500000@example.com'"
    for label in ("no index on email", "after CREATE INDEX nb_users_email ON nb_users (email)"):
        if label.startswith("after"):
            q1(c, "CREATE INDEX nb_users_email ON nb_users (email)")
        log("--", label)
        for r in q1(c, "EXPLAIN ANALYZE " + sel): 
            for line in r[0].splitlines(): log("  " + line)
        q1(c, "FLUSH STATUS"); q1(c, sel)
        rows = dict((k, v) for k, v in q1(c, "SHOW SESSION STATUS LIKE 'Handler_read%'"))
        log("  Handler_read_rnd_next (rows read in a scan):", rows.get("Handler_read_rnd_next"),
            "| Handler_read_key (index lookups):", rows.get("Handler_read_key"),
            "| Handler_read_next:", rows.get("Handler_read_next"))
    log("")
    log("## MongoDB 8.0")
    db = mo().shop
    db.nb_users.drop()
    batch = []
    for i in range(1, 1000001):
        batch.append({"_id": i, "email": "user%d@example.com" % i, "pad": "x" * 100})
        if len(batch) == 10000:
            db.nb_users.insert_many(batch, ordered=False); batch = []
    f = {"email": "user500000@example.com"}
    log("-- no index on email")
    mongo_explain(log, db.command("explain", {"find": "nb_users", "filter": f}, verbosity="executionStats"))
    db.nb_users.create_index("email")
    log("-- after createIndex({email: 1})")
    mongo_explain(log, db.command("explain", {"find": "nb_users", "filter": f}, verbosity="executionStats"))
    log.save()


# ---------------------------------------------------------------- notebook 4
def nb_anomalies():
    log = Log("anomalies")
    header(log, "Notebook 4: two sessions, interleaved step by step")

    def pg_lost_update(level):
        s = pg(); q1(s, "DROP TABLE IF EXISTS nb_acct"); q1(s, "CREATE TABLE nb_acct (id int PRIMARY KEY, balance int)"); q1(s, "INSERT INTO nb_acct VALUES (1, 100)")
        a, b = pg(False), pg(False)
        q1(a, "BEGIN ISOLATION LEVEL " + level); q1(b, "BEGIN ISOLATION LEVEL " + level)
        ra = q1(a, "SELECT balance FROM nb_acct WHERE id = 1")[0][0]; log("  A: SELECT balance -> %d" % ra)
        rb = q1(b, "SELECT balance FROM nb_acct WHERE id = 1")[0][0]; log("  B: SELECT balance -> %d" % rb)
        q1(a, "UPDATE nb_acct SET balance = %s WHERE id = 1", (ra + 10,)); a.commit(); log("  A: UPDATE balance = %d; COMMIT" % (ra + 10))
        try:
            q1(b, "UPDATE nb_acct SET balance = %s WHERE id = 1", (rb + 20,)); b.commit(); log("  B: UPDATE balance = %d; COMMIT -> ok" % (rb + 20))
        except psycopg2.Error as e:
            b.rollback(); log("  B: UPDATE balance = %d -> ERROR: %s" % (rb + 20, e.pgerror.strip().splitlines()[0]))
        log("  final balance: %d  (expected 130 if both deposits count)" % q1(s, "SELECT balance FROM nb_acct WHERE id = 1")[0][0])

    def pg_write_skew(level):
        s = pg(); q1(s, "DROP TABLE IF EXISTS nb_doctors"); q1(s, "CREATE TABLE nb_doctors (name text PRIMARY KEY, on_call bool)"); q1(s, "INSERT INTO nb_doctors VALUES ('alice', true), ('bob', true)")
        a, b = pg(False), pg(False)
        q1(a, "BEGIN ISOLATION LEVEL " + level); q1(b, "BEGIN ISOLATION LEVEL " + level)
        log("  A: SELECT count(*) WHERE on_call -> %d" % q1(a, "SELECT count(*) FROM nb_doctors WHERE on_call")[0][0])
        log("  B: SELECT count(*) WHERE on_call -> %d" % q1(b, "SELECT count(*) FROM nb_doctors WHERE on_call")[0][0])
        q1(a, "UPDATE nb_doctors SET on_call = false WHERE name = 'alice'"); log("  A: UPDATE alice off call")
        q1(b, "UPDATE nb_doctors SET on_call = false WHERE name = 'bob'"); log("  B: UPDATE bob off call")
        for n, x in (("A", a), ("B", b)):
            try:
                x.commit(); log("  %s: COMMIT -> ok" % n)
            except psycopg2.Error as e:
                x.rollback(); log("  %s: COMMIT -> ERROR: %s" % (n, e.pgerror.strip().splitlines()[0]))
        log("  doctors on call at the end: %d  (the rule was: at least 1)" % q1(s, "SELECT count(*) FROM nb_doctors WHERE on_call")[0][0])

    def my_lost_update(lock):
        s = my(); q1(s, "DROP TABLE IF EXISTS nb_acct"); q1(s, "CREATE TABLE nb_acct (id int PRIMARY KEY, balance int)"); q1(s, "INSERT INTO nb_acct VALUES (1, 100)")
        a, b = my(False), my(False)
        q1(a, "START TRANSACTION"); q1(b, "START TRANSACTION")
        suffix = " FOR UPDATE" if lock else ""
        ra = q1(a, "SELECT balance FROM nb_acct WHERE id = 1" + suffix)[0][0]; log("  A: SELECT balance%s -> %d" % (suffix, ra))
        if lock:
            import threading
            res = {}
            th = threading.Thread(target=lambda: res.update(v=q1(b, "SELECT balance FROM nb_acct WHERE id = 1 FOR UPDATE")[0][0]))
            th.start(); time.sleep(1.5)
            log("  B: SELECT balance FOR UPDATE -> still waiting after 1.5 s: %s" % th.is_alive())
            q1(a, "UPDATE nb_acct SET balance = %s WHERE id = 1", (ra + 10,)); a.commit(); log("  A: UPDATE balance = %d; COMMIT" % (ra + 10))
            th.join(30); rb = res["v"]; log("  B: ... the SELECT FOR UPDATE returns -> %d" % rb)
        else:
            rb = q1(b, "SELECT balance FROM nb_acct WHERE id = 1")[0][0]; log("  B: SELECT balance -> %d" % rb)
            q1(a, "UPDATE nb_acct SET balance = %s WHERE id = 1", (ra + 10,)); a.commit(); log("  A: UPDATE balance = %d; COMMIT" % (ra + 10))
        q1(b, "UPDATE nb_acct SET balance = %s WHERE id = 1", (rb + 20,)); b.commit(); log("  B: UPDATE balance = %d; COMMIT -> ok" % (rb + 20))
        log("  final balance: %d  (expected 130 if both deposits count)" % q1(s, "SELECT balance FROM nb_acct WHERE id = 1")[0][0])

    def my_write_skew():
        s = my(); q1(s, "DROP TABLE IF EXISTS nb_doctors"); q1(s, "CREATE TABLE nb_doctors (name varchar(16) PRIMARY KEY, on_call bool)"); q1(s, "INSERT INTO nb_doctors VALUES ('alice', true), ('bob', true)")
        a, b = my(False), my(False)
        q1(a, "START TRANSACTION"); q1(b, "START TRANSACTION")
        log("  A: SELECT COUNT(*) WHERE on_call -> %d" % q1(a, "SELECT COUNT(*) FROM nb_doctors WHERE on_call")[0][0])
        log("  B: SELECT COUNT(*) WHERE on_call -> %d" % q1(b, "SELECT COUNT(*) FROM nb_doctors WHERE on_call")[0][0])
        q1(a, "UPDATE nb_doctors SET on_call = false WHERE name = 'alice'"); log("  A: UPDATE alice off call")
        q1(b, "UPDATE nb_doctors SET on_call = false WHERE name = 'bob'"); log("  B: UPDATE bob off call")
        a.commit(); log("  A: COMMIT -> ok"); b.commit(); log("  B: COMMIT -> ok")
        log("  doctors on call at the end: %d  (the rule was: at least 1)" % q1(s, "SELECT COUNT(*) FROM nb_doctors WHERE on_call")[0][0])

    def mo_lost_update():
        c = mo(); db = c.shop; db.nb_acct.drop(); db.nb_acct.insert_one({"_id": 1, "balance": 100})
        sa, sb = c.start_session(), c.start_session()
        sa.start_transaction(); sb.start_transaction()
        ra = db.nb_acct.find_one({"_id": 1}, session=sa)["balance"]; log("  A: findOne -> balance %d" % ra)
        rb = db.nb_acct.find_one({"_id": 1}, session=sb)["balance"]; log("  B: findOne -> balance %d" % rb)
        db.nb_acct.update_one({"_id": 1}, {"$set": {"balance": ra + 10}}, session=sa); sa.commit_transaction(); log("  A: updateOne balance = %d; commitTransaction" % (ra + 10))
        try:
            db.nb_acct.update_one({"_id": 1}, {"$set": {"balance": rb + 20}}, session=sb); sb.commit_transaction(); log("  B: updateOne balance = %d; commitTransaction -> ok" % (rb + 20))
        except PyMongoError as e:
            log("  B: updateOne balance = %d -> %s: %s" % (rb + 20, type(e).__name__, str(e).split(", full error")[0][:160]))
            try: sb.abort_transaction()
            except Exception: pass
        log("  final balance: %d  (expected 130 if both deposits count)" % db.nb_acct.find_one({"_id": 1})["balance"])

    def mo_write_skew():
        c = mo(); db = c.shop; db.nb_doctors.drop(); db.nb_doctors.insert_many([{"_id": "alice", "on_call": True}, {"_id": "bob", "on_call": True}])
        sa, sb = c.start_session(), c.start_session()
        sa.start_transaction(); sb.start_transaction()
        log("  A: countDocuments({on_call: true}) -> %d" % db.nb_doctors.count_documents({"on_call": True}, session=sa))
        log("  B: countDocuments({on_call: true}) -> %d" % db.nb_doctors.count_documents({"on_call": True}, session=sb))
        db.nb_doctors.update_one({"_id": "alice"}, {"$set": {"on_call": False}}, session=sa); log("  A: updateOne alice off call")
        db.nb_doctors.update_one({"_id": "bob"}, {"$set": {"on_call": False}}, session=sb); log("  B: updateOne bob off call")
        for n, x in (("A", sa), ("B", sb)):
            try: x.commit_transaction(); log("  %s: commitTransaction -> ok" % n)
            except PyMongoError as e: log("  %s: commitTransaction -> %s" % (n, type(e).__name__))
        log("  doctors on call at the end: %d  (the rule was: at least 1)" % db.nb_doctors.count_documents({"on_call": True}))

    for title, fn in [
        ("PostgreSQL 18, lost update, READ COMMITTED (the default)", lambda: pg_lost_update("READ COMMITTED")),
        ("PostgreSQL 18, lost update, REPEATABLE READ", lambda: pg_lost_update("REPEATABLE READ")),
        ("MySQL 8.4, lost update, REPEATABLE READ (the default)", lambda: my_lost_update(False)),
        ("MySQL 8.4, lost update fixed with SELECT ... FOR UPDATE", lambda: my_lost_update(True)),
        ("MongoDB 8.0, lost update, inside two transactions", mo_lost_update),
        ("PostgreSQL 18, write skew, REPEATABLE READ", lambda: pg_write_skew("REPEATABLE READ")),
        ("PostgreSQL 18, write skew, SERIALIZABLE", lambda: pg_write_skew("SERIALIZABLE")),
        ("MySQL 8.4, write skew, REPEATABLE READ (the default)", my_write_skew),
        ("MongoDB 8.0, write skew, inside two transactions", mo_write_skew),
    ]:
        log("## " + title)
        try:
            fn()
        except Exception as e:
            log("  notebook error:", repr(e))
        log("")
    log.save()


# ---------------------------------------------------------------- notebook 5
def nb_queries():
    log = Log("queries")
    header(log, "Notebook 5: four query shapes on 1,000,000 orders")
    log("Table: orders(id, customer_id 1..10000, created_at over one year, status, total). Index on (customer_id, created_at).")
    log("")
    # PostgreSQL
    c = pg()
    q1(c, "DROP TABLE IF EXISTS nb_orders")
    q1(c, "CREATE TABLE nb_orders (id int PRIMARY KEY, customer_id int, created_at timestamp, status text, total numeric(10,2))")
    q1(c, "INSERT INTO nb_orders SELECT g, 1 + (g * 7919) % 10000, timestamp '2025-11-18' + (g % 525600) * interval '1 minute', CASE WHEN g % 10 = 0 THEN 'refunded' ELSE 'paid' END, (g % 500) + 0.99 FROM generate_series(1, 1000000) g")
    q1(c, "CREATE INDEX nb_orders_cust_created ON nb_orders (customer_id, created_at)")
    q1(c, "VACUUM ANALYZE nb_orders")
    q1(c, "SET max_parallel_workers_per_gather = 0")
    def pgx(title, sql):
        log("-- " + title); log("   " + sql)
        for r in q1(c, "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) " + sql): log("  " + r[0])
    log("## PostgreSQL 18")
    pgx("1. both columns of the index, in order", "SELECT * FROM nb_orders WHERE customer_id = 42 AND created_at >= '2026-06-01'")
    pgx("2. only the second column of the index", "SELECT * FROM nb_orders WHERE created_at >= '2026-11-17'")
    pgx("3. covering: every column needed is in the index", "SELECT customer_id, created_at FROM nb_orders WHERE customer_id = 42")
    pgx("4a. paging with OFFSET", "SELECT * FROM nb_orders ORDER BY id OFFSET 500000 LIMIT 20")
    pgx("4b. paging with a key (keyset)", "SELECT * FROM nb_orders WHERE id > 500000 ORDER BY id LIMIT 20")
    ids = [r[0] for r in q1(c, "SELECT DISTINCT customer_id FROM nb_orders WHERE customer_id <= 100")]
    t = time.perf_counter()
    for i in ids: q1(c, "SELECT max(created_at) FROM nb_orders WHERE customer_id = %s", (i,))
    n1 = time.perf_counter() - t
    t = time.perf_counter()
    q1(c, "SELECT customer_id, max(created_at) FROM nb_orders WHERE customer_id = ANY(%s) GROUP BY customer_id", (ids,))
    one = time.perf_counter() - t
    log("-- 5. N+1 from the application: latest order for 100 customers")
    log("  100 queries, one per customer: %.1f ms | 1 query with = ANY(list): %.1f ms" % (1000 * n1, 1000 * one))
    log("")
    # MySQL
    c2 = my()
    q1(c2, "DROP TABLE IF EXISTS nb_orders")
    q1(c2, "CREATE TABLE nb_orders (id int PRIMARY KEY, customer_id int, created_at datetime, status varchar(16), total decimal(10,2))")
    q1(c2, "SET SESSION cte_max_recursion_depth = 2000000")
    q1(c2, "INSERT INTO nb_orders WITH RECURSIVE s(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM s WHERE g < 1000000) SELECT g, 1 + (g * 7919) % 10000, TIMESTAMP('2025-11-18') + INTERVAL (g % 525600) MINUTE, IF(g % 10 = 0, 'refunded', 'paid'), (g % 500) + 0.99 FROM s")
    q1(c2, "CREATE INDEX nb_orders_cust_created ON nb_orders (customer_id, created_at)")
    q1(c2, "ANALYZE TABLE nb_orders")
    def myx(title, sql):
        log("-- " + title); log("   " + sql)
        for r in q1(c2, "EXPLAIN ANALYZE " + sql):
            for line in r[0].splitlines(): log("  " + line)
        q1(c2, "FLUSH STATUS"); q1(c2, sql)
        st = dict(q1(c2, "SHOW SESSION STATUS LIKE 'Handler_read%'"))
        log("  rows touched (Handler_read_next + Handler_read_rnd_next): %d" % (int(st["Handler_read_next"]) + int(st["Handler_read_rnd_next"])))
    log("## MySQL 8.4")
    myx("1. both columns of the index, in order", "SELECT * FROM nb_orders WHERE customer_id = 42 AND created_at >= '2026-06-01'")
    myx("2. only the second column of the index", "SELECT * FROM nb_orders WHERE created_at >= '2026-11-17'")
    myx("3. covering: every column needed is in the index", "SELECT customer_id, created_at FROM nb_orders WHERE customer_id = 42")
    myx("4a. paging with OFFSET", "SELECT * FROM nb_orders ORDER BY id LIMIT 20 OFFSET 500000")
    myx("4b. paging with a key (keyset)", "SELECT * FROM nb_orders WHERE id > 500000 ORDER BY id LIMIT 20")
    log("")
    # MongoDB
    db = mo().shop
    db.nb_orders.drop()
    base = datetime.datetime(2025, 11, 18)
    batch = []
    for g in range(1, 1000001):
        batch.append({"_id": g, "customer_id": 1 + (g * 7919) % 10000, "created_at": base + datetime.timedelta(minutes=g % 525600),
                      "status": "refunded" if g % 10 == 0 else "paid", "total": (g % 500) + 0.99})
        if len(batch) == 10000:
            db.nb_orders.insert_many(batch, ordered=False); batch = []
    db.nb_orders.create_index([("customer_id", 1), ("created_at", 1)])
    def mox(title, cmd):
        log("-- " + title); log("   " + json.dumps(cmd, default=str))
        mongo_explain(log, db.command("explain", cmd, verbosity="executionStats"))
    log("## MongoDB 8.0")
    mox("1. both fields of the index, in order", {"find": "nb_orders", "filter": {"customer_id": 42, "created_at": {"$gte": datetime.datetime(2026, 6, 1)}}})
    mox("2. only the second field of the index", {"find": "nb_orders", "filter": {"created_at": {"$gte": datetime.datetime(2026, 11, 17)}}})
    mox("3. covering: projection only uses indexed fields", {"find": "nb_orders", "filter": {"customer_id": 42}, "projection": {"_id": 0, "customer_id": 1, "created_at": 1}})
    mox("4a. paging with skip", {"find": "nb_orders", "filter": {}, "sort": {"_id": 1}, "skip": 500000, "limit": 20})
    mox("4b. paging with a key (keyset)", {"find": "nb_orders", "filter": {"_id": {"$gt": 500000}}, "sort": {"_id": 1}, "limit": 20})
    log.save()


if __name__ == "__main__":
    only = sys.argv[2:] if len(sys.argv) > 2 else None
    for fn in (nb_long_transaction, nb_commit_cost, nb_scan_vs_index, nb_anomalies, nb_queries):
        if only and fn.__name__ not in only:
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            with open(os.path.join(OUT, fn.__name__ + ".error.txt"), "w") as f:
                f.write(traceback.format_exc())
