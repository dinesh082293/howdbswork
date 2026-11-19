#!/usr/bin/env python3
"""Lab notebook 8: pgvector for agent memory. Recall against speed, what an HNSW
index costs in memory, and what happens when you filter by tenant.

Usage: python3 scripts/notebooks/run_vector.py OUTDIR [nb_agent_memory]
Expects PostgreSQL with pgvector on localhost:5433 (pgvector/pgvector:pg18).
"""
import os, sys, time, traceback, io
sys.path.insert(0, os.path.dirname(__file__))
import run_all as base
from run_all import Log, q1
import datetime, platform
import numpy as np
import psycopg2

OUT = sys.argv[1] if len(sys.argv) > 1 else "lab-output"
base.OUT = OUT
os.makedirs(OUT, exist_ok=True)

N, DIM, CLUSTERS, TENANTS, QUERIES, K = 100_000, 384, 500, 100, 200, 10


def vpg(autocommit=True):
    c = psycopg2.connect(host="127.0.0.1", port=5433, user="postgres", password="ci", dbname="shop")
    c.autocommit = autocommit
    return c


def vec(v):
    return "[" + ",".join("%.5f" % x for x in v) + "]"


def nb_agent_memory():
    log = Log("agent-memory")
    c = vpg()
    log("# Notebook 8: pgvector for agent memory")
    log("# run at:", datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"))
    log("# runner:", platform.platform(), "|", os.cpu_count(), "vCPU")
    log("# PostgreSQL:", q1(c, "SHOW server_version")[0][0])
    q1(c, "CREATE EXTENSION IF NOT EXISTS vector")
    log("# pgvector:", q1(c, "SELECT extversion FROM pg_extension WHERE extname = 'vector'")[0][0])
    log("")
    log("Data: %s memories of %d dimensions, generated around %d topics in a 64-dimension space and" % (format(N, ","), DIM, CLUSTERS))
    log("projected up, because real embeddings cluster by subject and use far fewer directions than they have.")
    log("%d tenants (agents or customers), %s memories each." % (TENANTS, format(N // TENANTS, ",")))
    log("Generated vectors are not real embeddings, so treat recall as the shape of the curve, not a promise.")
    log("Timings are from a client on the same machine and include the round trip.")
    log("")

    rng = np.random.default_rng(42)
    # Real embeddings use far fewer directions than they have dimensions, so the
    # vectors are built in a 64-dimension space of topics and projected up to DIM.
    LAT = 64
    centers = rng.normal(size=(CLUSTERS, LAT)).astype(np.float32)
    lab = rng.integers(0, CLUSTERS, N)
    Z = centers[lab] + 0.5 * rng.normal(size=(N, LAT)).astype(np.float32)
    P = rng.normal(size=(LAT, DIM)).astype(np.float32) / np.sqrt(LAT)
    X = Z @ P + 0.05 * rng.normal(size=(N, DIM)).astype(np.float32)
    X /= np.linalg.norm(X, axis=1, keepdims=True)
    tenant = rng.integers(0, TENANTS, N)
    qi = rng.choice(N, QUERIES, replace=False)
    Q = X[qi] + 0.08 * rng.normal(size=(QUERIES, DIM)).astype(np.float32)
    Q /= np.linalg.norm(Q, axis=1, keepdims=True)
    sims = Q @ X.T
    truth = np.argsort(-sims, axis=1)[:, :K]

    q1(c, "DROP TABLE IF EXISTS nb_memory")
    q1(c, "CREATE TABLE nb_memory (id int PRIMARY KEY, tenant_id int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), body text, embedding vector(%d) NOT NULL)" % DIM)
    t = time.perf_counter()
    buf = io.StringIO()
    for i in range(N):
        buf.write("%d\t%d\tmemory %d\t%s\n" % (i, tenant[i], i, vec(X[i])))
    buf.seek(0)
    with c.cursor() as cur:
        cur.copy_expert("COPY nb_memory (id, tenant_id, body, embedding) FROM STDIN", buf)
    q1(c, "CREATE INDEX nb_memory_tenant ON nb_memory (tenant_id)")
    q1(c, "VACUUM ANALYZE nb_memory")
    log("## 1. What it costs to store")
    log("  loaded %s rows in %.1f s" % (format(N, ","), time.perf_counter() - t))
    tb = q1(c, "SELECT pg_table_size('nb_memory')")[0][0]
    log("  table: %s, %d bytes per memory (a %d-dimension vector is %d bytes of floats)" % (
        q1(c, "SELECT pg_size_pretty(pg_table_size('nb_memory'))")[0][0], tb // N, DIM, DIM * 4))
    q1(c, "SET maintenance_work_mem = '1GB'")
    t = time.perf_counter()
    q1(c, "CREATE INDEX nb_memory_hnsw ON nb_memory USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)")
    bt = time.perf_counter() - t
    ib = q1(c, "SELECT pg_relation_size('nb_memory_hnsw')")[0][0]
    log("  HNSW index (m = 16, ef_construction = 64): built in %.1f s, %s, %d bytes per memory" % (
        bt, q1(c, "SELECT pg_size_pretty(pg_relation_size('nb_memory_hnsw'))")[0][0], ib // N))
    log("  table plus HNSW index: %d bytes per memory, %.1f times the raw floats" % ((tb + ib) // N, (tb + ib) / N / (DIM * 4)))
    log("")

    def search(sql, qv, args=()):
        with c.cursor() as cur:
            t = time.perf_counter()
            cur.execute(sql, (vec(qv),) + args)
            rows = cur.fetchall()
            return [r[0] for r in rows], time.perf_counter() - t

    log("## 2. Recall against speed: top %d nearest memories, %d searches each" % (K, QUERIES))
    SQL = "SELECT id FROM nb_memory ORDER BY embedding <=> %s::vector LIMIT 10"
    q1(c, "SET enable_indexscan = off")
    ts = [search(SQL, Q[j])[1] for j in range(20)]
    log("  exact search (no index, reads every row): %.1f ms per search" % (1000 * np.median(ts)))
    q1(c, "SET enable_indexscan = on")
    plan = " ".join(r[0] for r in q1(c, "EXPLAIN " + SQL.replace("%s", "'%s'" % vec(Q[0]))))
    log("  plan with the index:", "Index Scan using nb_memory_hnsw" if "nb_memory_hnsw" in plan else plan[:120])
    for ef in (10, 20, 40, 80, 160, 400):
        q1(c, "SET hnsw.ef_search = %d" % ef)
        rec, lat = [], []
        for j in range(QUERIES):
            ids, dt = search(SQL, Q[j])
            rec.append(len(set(ids) & set(truth[j].tolist())) / K); lat.append(dt)
        log("  hnsw.ef_search = %3d   recall@10 %.3f   median %.2f ms   p95 %.2f ms" % (ef, np.mean(rec), 1000 * np.median(lat), 1000 * np.percentile(lat, 95)))
    log("")

    log("## 3. Filtering by tenant: one tenant's memories are 1% of the table")
    FSQL = "SELECT id FROM nb_memory WHERE tenant_id = %s ORDER BY embedding <=> %s::vector LIMIT 10"
    def fsearch(qv, tid):
        with c.cursor() as cur:
            t = time.perf_counter()
            cur.execute(FSQL, (tid, vec(qv)))
            return [r[0] for r in cur.fetchall()], time.perf_counter() - t
    tids = [int(tenant[qi[j]]) for j in range(QUERIES)]
    ftruth = []
    for j in range(QUERIES):
        m = np.where(tenant == tids[j])[0]
        ftruth.append(set(m[np.argsort(-sims[j, m])[:K]].tolist()))
    def run_filtered(label):
        got, rec, lat = [], [], []
        for j in range(QUERIES):
            ids, dt = fsearch(Q[j], tids[j])
            got.append(len(ids)); rec.append(len(set(ids) & ftruth[j]) / K); lat.append(dt)
        log("  %-52s rows returned %.1f of 10   recall@10 %.3f   median %.2f ms" % (label, np.mean(got), np.mean(rec), 1000 * np.median(lat)))
    q1(c, "SET hnsw.ef_search = 40")
    plan = " ".join(r[0] for r in q1(c, "EXPLAIN " + FSQL.replace("%s", "7", 1).replace("%s", "'%s'" % vec(Q[0]))))
    log("  planner's choice for the filtered query:", "HNSW index, then filter" if "nb_memory_hnsw" in plan else ("tenant index, then exact distance" if "nb_memory_tenant" in plan else plan[:100]))
    q1(c, "SET enable_bitmapscan = off"); q1(c, "SET enable_seqscan = off")
    try:
        q1(c, "DROP INDEX nb_memory_tenant")
        run_filtered("HNSW, ef_search 40, then filter:")
        q1(c, "SET hnsw.ef_search = 400")
        run_filtered("HNSW, ef_search 400, then filter:")
        try:
            q1(c, "SET hnsw.ef_search = 40"); q1(c, "SET hnsw.iterative_scan = relaxed_order")
            run_filtered("HNSW, ef_search 40, iterative_scan = relaxed_order:")
            q1(c, "SET hnsw.iterative_scan = off")
        except psycopg2.Error as e:
            log("  iterative scan not available:", str(e).strip().splitlines()[0])
    finally:
        q1(c, "RESET enable_bitmapscan"); q1(c, "RESET enable_seqscan")
    q1(c, "CREATE INDEX nb_memory_tenant ON nb_memory (tenant_id)")
    q1(c, "ANALYZE nb_memory")
    q1(c, "SET enable_indexscan = off")
    run_filtered("tenant index, then exact distance on 1,000 rows:")
    q1(c, "SET enable_indexscan = on")
    log("")
    log("Read it this way: with the filter applied after the index, the index hands back about ef_search")
    log("candidates and 99% of them belong to other tenants. Raising ef_search or scanning iteratively")
    log("fixes it at a cost; for small tenants an exact search inside the tenant is both exact and fast.")
    log.save()


if __name__ == "__main__":
    only = sys.argv[2:] or None
    for fn in (nb_agent_memory,):
        if only and fn.__name__ not in only:
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            with open(os.path.join(OUT, fn.__name__ + ".error.txt"), "w") as f:
                f.write(traceback.format_exc())
