#!/usr/bin/env python3
"""Lab notebooks 6 and 7: checks behind the Designs pages, and the engines
those pages recommend besides the main three (Redis, ClickHouse, Cassandra).

Usage: python3 scripts/notebooks/run_more.py OUTDIR [nb_design_checks nb_other_engines]
Expects the workflow's containers on localhost: 5432, 3306, 27017, 6379, 8123, 9042.
"""
import os, sys, time, threading, traceback
sys.path.insert(0, os.path.dirname(__file__))
import run_all as base
from run_all import Log, pg, my, mo, q1, header
import psycopg2, pymysql

OUT = sys.argv[1] if len(sys.argv) > 1 else "lab-output"
base.OUT = OUT
os.makedirs(OUT, exist_ok=True)


def threads(n, fn):
    ts = [threading.Thread(target=fn, args=(i,)) for i in range(n)]
    t = time.perf_counter()
    for x in ts: x.start()
    for x in ts: x.join()
    return time.perf_counter() - t


# ---------------------------------------------------------------- notebook 6
def nb_design_checks():
    log = Log("design-checks")
    header(log, "Notebook 6: the rules the design docs rely on")
    STOCK, N, PER = 1000, 16, 100
    log("## 1. The last item: %d units, %d clients each trying %d purchases at once (%d attempts)" % (STOCK, N, PER, N * PER))
    # PostgreSQL naive read-then-write
    c = pg(); q1(c, "DROP TABLE IF EXISTS nb_stock"); q1(c, "CREATE TABLE nb_stock (sku text PRIMARY KEY, available int NOT NULL)")
    def run_pg(mode):
        q1(c, "TRUNCATE nb_stock"); q1(c, "INSERT INTO nb_stock VALUES ('hot', %s)", (STOCK,))
        sold = [0] * N
        def worker(i):
            k = pg(autocommit=False)
            for _ in range(PER):
                try:
                    if mode == "naive":
                        a = q1(k, "SELECT available FROM nb_stock WHERE sku = 'hot'")[0][0]
                        if a > 0:
                            q1(k, "UPDATE nb_stock SET available = %s WHERE sku = 'hot'", (a - 1,)); sold[i] += 1
                    else:
                        with k.cursor() as cur:
                            cur.execute("UPDATE nb_stock SET available = available - 1 WHERE sku = 'hot' AND available >= 1")
                            sold[i] += cur.rowcount
                    k.commit()
                except psycopg2.Error:
                    k.rollback()
            k.close()
        dt = threads(N, worker)
        left = q1(c, "SELECT available FROM nb_stock WHERE sku = 'hot'")[0][0]
        log("  PostgreSQL, %-34s sold %4d of %d, stock left %4d, %.1f s" % (
            "read, then write the new value:" if mode == "naive" else "UPDATE ... WHERE available >= 1:", sum(sold), STOCK, left, dt))
    run_pg("naive"); run_pg("conditional")
    m = my(); q1(m, "DROP TABLE IF EXISTS nb_stock"); q1(m, "CREATE TABLE nb_stock (sku varchar(16) PRIMARY KEY, available int NOT NULL)")
    def run_my(mode):
        q1(m, "TRUNCATE nb_stock"); q1(m, "INSERT INTO nb_stock VALUES ('hot', %s)", (STOCK,))
        sold = [0] * N
        def worker(i):
            k = my(autocommit=False)
            for _ in range(PER):
                try:
                    with k.cursor() as cur:
                        if mode == "naive":
                            cur.execute("SELECT available FROM nb_stock WHERE sku = 'hot'"); a = cur.fetchone()[0]
                            if a > 0:
                                cur.execute("UPDATE nb_stock SET available = %s WHERE sku = 'hot'", (a - 1,)); sold[i] += 1
                        else:
                            sold[i] += cur.execute("UPDATE nb_stock SET available = available - 1 WHERE sku = 'hot' AND available >= 1")
                    k.commit()
                except pymysql.Error:
                    k.rollback()
            k.close()
        dt = threads(N, worker)
        left = q1(m, "SELECT available FROM nb_stock WHERE sku = 'hot'")[0][0]
        log("  MySQL,      %-34s sold %4d of %d, stock left %4d, %.1f s" % (
            "read, then write the new value:" if mode == "naive" else "UPDATE ... WHERE available >= 1:", sum(sold), STOCK, left, dt))
    run_my("naive"); run_my("conditional")
    db = mo().shop
    def run_mo(mode):
        db.nb_stock.drop(); db.nb_stock.insert_one({"_id": "hot", "available": STOCK})
        sold = [0] * N
        def worker(i):
            cl = mo(); s = cl.shop.nb_stock
            for _ in range(PER):
                if mode == "naive":
                    a = s.find_one({"_id": "hot"})["available"]
                    if a > 0:
                        s.update_one({"_id": "hot"}, {"$set": {"available": a - 1}}); sold[i] += 1
                else:
                    sold[i] += s.update_one({"_id": "hot", "available": {"$gte": 1}}, {"$inc": {"available": -1}}).modified_count
        dt = threads(N, worker)
        left = db.nb_stock.find_one({"_id": "hot"})["available"]
        log("  MongoDB,    %-34s sold %4d of %d, stock left %4d, %.1f s" % (
            "read, then $set the new value:" if mode == "naive" else "updateOne({available: {$gte: 1}}, $inc):", sum(sold), STOCK, left, dt))
    run_mo("naive"); run_mo("conditional")
    log("")

    log("## 2. A retried payment with an idempotency key (PostgreSQL)")
    q1(c, "DROP TABLE IF EXISTS nb_ledger"); q1(c, "DROP TABLE IF EXISTS nb_idem")
    q1(c, "CREATE TABLE nb_idem (key text PRIMARY KEY, transfer_id int NOT NULL)")
    q1(c, "CREATE TABLE nb_ledger (id serial PRIMARY KEY, transfer_id int, account text, amount bigint)")
    def pay(key, tid):
        k = pg(autocommit=False)
        try:
            q1(k, "INSERT INTO nb_idem VALUES (%s, %s)", (key, tid))
            q1(k, "INSERT INTO nb_ledger (transfer_id, account, amount) VALUES (%s, 'alice', -500), (%s, 'shop', 500)", (tid, tid))
            k.commit(); return "committed"
        except psycopg2.Error as e:
            k.rollback(); return "rolled back: " + e.pgerror.strip().splitlines()[0].replace("ERROR:  ", "")
    log("  attempt 1, key pay-abc:", pay("pay-abc", 1))
    log("  attempt 2, same key (a client retry):", pay("pay-abc", 2))
    log("  ledger rows:", q1(c, "SELECT count(*) FROM nb_ledger")[0][0], "| sum of amounts:", q1(c, "SELECT sum(amount) FROM nb_ledger")[0][0], "| alice:", q1(c, "SELECT sum(amount) FROM nb_ledger WHERE account = 'alice'")[0][0])
    log("")

    log("## 3. Two bookings for the same room and overlapping times")
    q1(c, "CREATE EXTENSION IF NOT EXISTS btree_gist")
    q1(c, "DROP TABLE IF EXISTS nb_room_bookings")
    q1(c, "CREATE TABLE nb_room_bookings (room_id int NOT NULL, during tstzrange NOT NULL, EXCLUDE USING gist (room_id WITH =, during WITH &&))")
    for label, rng in (("14:00-16:00", "[2026-12-01 14:00, 2026-12-01 16:00)"), ("15:00-17:00", "[2026-12-01 15:00, 2026-12-01 17:00)"), ("16:00-18:00", "[2026-12-01 16:00, 2026-12-01 18:00)")):
        try:
            q1(c, "INSERT INTO nb_room_bookings VALUES (7, %s)", (rng,)); log("  PostgreSQL, room 7, %s -> booked" % label)
        except psycopg2.Error as e:
            log("  PostgreSQL, room 7, %s -> %s" % (label, e.pgerror.strip().splitlines()[0].replace("ERROR:  ", "")))
    q1(m, "DROP TABLE IF EXISTS nb_seat_bookings"); q1(m, "CREATE TABLE nb_seat_bookings (event_id int, seat varchar(8), booking_id int NOT NULL, PRIMARY KEY (event_id, seat))")
    for b in (1, 2):
        try:
            q1(m, "INSERT INTO nb_seat_bookings VALUES (99, 'A12', %s)", (b,)); log("  MySQL, event 99, seat A12, booking %d -> booked" % b)
        except pymysql.Error as e:
            log("  MySQL, event 99, seat A12, booking %d -> %s" % (b, e.args[1]))
    log("")

    log("## 4. A query that forgets WHERE tenant_id = ... (PostgreSQL row-level security)")
    for s in ("DROP TABLE IF EXISTS nb_projects", "DROP ROLE IF EXISTS nb_app",
              "CREATE TABLE nb_projects (tenant_id int NOT NULL, id int NOT NULL, name text, PRIMARY KEY (tenant_id, id))",
              "INSERT INTO nb_projects SELECT 1 + g % 3, g, 'project ' || g FROM generate_series(1, 30) g",
              "ALTER TABLE nb_projects ENABLE ROW LEVEL SECURITY",
              "CREATE POLICY tenant_isolation ON nb_projects USING (tenant_id = current_setting('app.tenant_id')::int)",
              "CREATE ROLE nb_app LOGIN PASSWORD 'app'", "GRANT SELECT ON nb_projects TO nb_app"):
        q1(c, s)
    a = psycopg2.connect(host="127.0.0.1", port=5432, user="nb_app", password="app", dbname="shop"); a.autocommit = True
    q1(a, "SET app.tenant_id = '2'")
    log("  as the application role, tenant 2, SELECT count(*) FROM nb_projects ->", q1(a, "SELECT count(*) FROM nb_projects")[0][0])
    log("  same role, the rows it sees, by tenant ->", q1(a, "SELECT tenant_id, count(*) FROM nb_projects GROUP BY 1 ORDER BY 1"))
    log("  as postgres (a superuser), same query ->", q1(c, "SELECT count(*) FROM nb_projects")[0][0], " <- superusers bypass row-level security")
    a.close()
    log.save()


# ---------------------------------------------------------------- notebook 7
def nb_other_engines():
    log = Log("other-engines")
    header(log, "Notebook 7: Redis, ClickHouse and Cassandra, the stores the design docs add")
    # Redis
    import redis
    r = redis.Redis(host="127.0.0.1", port=6379)
    log("# Redis:", r.info("server")["redis_version"])
    r.flushall()
    log("## Redis: a leaderboard of 100,000 players in a sorted set")
    m0 = r.info("memory")["used_memory"]
    p = r.pipeline(transaction=False)
    for i in range(100000):
        p.zadd("lb:season7", {"player:%d" % i: (i * 7919) % 100000})
    p.execute()
    log("  memory for the sorted set: %.1f MB" % ((r.info("memory")["used_memory"] - m0) / 1e6))
    t = time.perf_counter()
    for i in range(10000):
        r.zincrby("lb:season7", 50, "player:%d" % (i * 13 % 100000))
    dt = time.perf_counter() - t
    log("  10,000 ZINCRBY, one round trip each: %.0f ops/s, %.3f ms each" % (10000 / dt, 1000 * dt / 10000))
    t = time.perf_counter(); top = r.zrevrange("lb:season7", 0, 9, withscores=True); dt = time.perf_counter() - t
    log("  ZREVRANGE top 10: %.3f ms -> %s ..." % (1000 * dt, ", ".join("%s=%d" % (k.decode(), s) for k, s in top[:3])))
    t = time.perf_counter(); rank = r.zrevrank("lb:season7", "player:42"); dt = time.perf_counter() - t
    log("  ZREVRANK player:42: rank %d in %.3f ms" % (rank, 1000 * dt))
    log("## Redis: a fixed-window rate limit, 5 requests per window")
    key = "rl:api:key123"
    for i in range(7):
        n = r.incr(key)
        if n == 1: r.expire(key, 2)
        log("  request %d -> count %d -> %s" % (i + 1, n, "allowed" if n <= 5 else "rejected"))
    log("  TTL on the key:", r.ttl(key), "s; waiting 3 s ...")
    time.sleep(3)
    log("  key exists after the window:", bool(r.exists(key)), "-> the next request starts a new window")
    log("")
    # ClickHouse
    import clickhouse_connect
    ch = clickhouse_connect.get_client(host="127.0.0.1", port=8123)
    log("# ClickHouse:", ch.query("SELECT version()").result_rows[0][0])
    log("## ClickHouse: 10,000,000 order lines, then a report that reads two columns")
    ch.command("DROP TABLE IF EXISTS order_lines")
    ch.command("""CREATE TABLE order_lines (order_id UInt64, created_at DateTime, customer_id UInt64,
                  sku LowCardinality(String), qty UInt32, price_cents UInt64, note String)
                  ENGINE = MergeTree PARTITION BY toYYYYMM(created_at) ORDER BY (sku, created_at)""")
    t = time.perf_counter()
    ch.command("""INSERT INTO order_lines SELECT number, toDateTime('2025-11-18 00:00:00') + (number % 31536000),
                  number % 100000, concat('sku-', toString(number % 500)), 1 + number % 5, 99 + number % 9900,
                  concat('gift wrap: ', toString(number % 3 = 0)) FROM numbers(10000000)""")
    log("  INSERT ... SELECT of 10,000,000 rows in one statement: %.1f s" % (time.perf_counter() - t))
    for row in ch.query("""SELECT name, formatReadableSize(data_compressed_bytes), formatReadableSize(data_uncompressed_bytes),
                           round(data_uncompressed_bytes / data_compressed_bytes, 1)
                           FROM system.columns WHERE table = 'order_lines' ORDER BY name""").result_rows:
        log("  column %-12s on disk %-10s uncompressed %-10s ratio %sx" % row)
    t = time.perf_counter()
    res = ch.query("""SELECT sku, sum(qty * price_cents) / 100 AS revenue FROM order_lines
                      WHERE created_at >= toDateTime('2026-10-18 00:00:00') GROUP BY sku ORDER BY revenue DESC LIMIT 3""")
    dt = time.perf_counter() - t
    log("  revenue by SKU, last 30 days, top 3: %s in %.0f ms" % (res.result_rows, 1000 * dt))
    s = res.summary
    log("  rows read: %s, bytes read: %s" % (s.get("read_rows"), s.get("read_bytes")))
    log("## ClickHouse: one row per INSERT against one batch")
    ch.command("DROP TABLE IF EXISTS small_inserts")
    ch.command("CREATE TABLE small_inserts (id UInt64, v UInt32) ENGINE = MergeTree ORDER BY id")
    ch.command("SYSTEM STOP MERGES small_inserts")
    t = time.perf_counter()
    for i in range(200):
        ch.command("INSERT INTO small_inserts VALUES (%d, 1)" % i)
    dt1 = time.perf_counter() - t
    parts1 = ch.query("SELECT count() FROM system.parts WHERE table = 'small_inserts' AND active").result_rows[0][0]
    ch.command("TRUNCATE TABLE small_inserts")
    t = time.perf_counter()
    ch.insert("small_inserts", [[i, 1] for i in range(200)], column_names=["id", "v"])
    dt2 = time.perf_counter() - t
    parts2 = ch.query("SELECT count() FROM system.parts WHERE table = 'small_inserts' AND active").result_rows[0][0]
    log("  200 single-row INSERTs: %.2f s, %d parts on disk (merges paused to show it)" % (dt1, parts1))
    log("  1 INSERT of 200 rows:   %.3f s, %d part on disk" % (dt2, parts2))
    log("")
    # Cassandra
    from cassandra.cluster import Cluster
    from cassandra import InvalidRequest
    cl = Cluster(["127.0.0.1"], port=9042); se = cl.connect()
    log("# Cassandra:", se.execute("SELECT release_version FROM system.local").one()[0])
    log("## Cassandra: chat messages, partitioned by (conversation_id, bucket)")
    se.execute("CREATE KEYSPACE IF NOT EXISTS chat WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}")
    se.set_keyspace("chat")
    se.execute("DROP TABLE IF EXISTS messages")
    se.execute("""CREATE TABLE messages (conversation_id bigint, bucket int, sent_at timestamp, sender_id bigint, body text,
                  PRIMARY KEY ((conversation_id, bucket), sent_at)) WITH CLUSTERING ORDER BY (sent_at DESC)""")
    ins = se.prepare("INSERT INTO messages (conversation_id, bucket, sent_at, sender_id, body) VALUES (?, ?, ?, ?, ?)")
    import datetime
    base_t = datetime.datetime(2026, 11, 1)
    from cassandra.concurrent import execute_concurrent_with_args
    args = [(i % 1000, 202611, base_t + datetime.timedelta(seconds=i), i % 50, "message %d" % i) for i in range(100000)]
    t = time.perf_counter()
    execute_concurrent_with_args(se, ins, args, concurrency=64)
    log("  100,000 messages across 1,000 conversations written in %.1f s" % (time.perf_counter() - t))
    q = se.prepare("SELECT sent_at, body FROM messages WHERE conversation_id = ? AND bucket = ? LIMIT 20")
    t = time.perf_counter(); rows = list(se.execute(q, (42, 202611))); dt = time.perf_counter() - t
    log("  latest 20 messages of conversation 42 (one partition): %d rows in %.1f ms, newest first: %s" % (len(rows), 1000 * dt, rows[0].body))
    try:
        se.execute("SELECT body FROM messages WHERE sender_id = 7 LIMIT 5")
        log("  query by sender_id: allowed")
    except InvalidRequest as e:
        log("  query by sender_id (not part of the key): rejected ->", str(e).split("message=")[-1][:200])
    cl.shutdown()
    log.save()


if __name__ == "__main__":
    only = sys.argv[2:] or None
    for fn in (nb_design_checks, nb_other_engines):
        if only and fn.__name__ not in only:
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            with open(os.path.join(OUT, fn.__name__ + ".error.txt"), "w") as f:
                f.write(traceback.format_exc())
