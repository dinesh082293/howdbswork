#!/usr/bin/env python3
"""Lab notebook 9: Redis and Cassandra when something fails.

Redis: what a killed process loses with the AOF on and with only snapshots,
and what a failover to an asynchronous replica loses, with and without WAIT.
Cassandra: a real three-node cluster with replication factor 3, writes and
reads at ONE, QUORUM and ALL, then with one and two nodes stopped.

Usage: python3 scripts/notebooks/run_failure.py OUTDIR
Starts and removes its own containers with the docker CLI. It stops the
workflow's single-node Cassandra and ClickHouse first to free memory, so it
runs after the other notebooks.
"""
import os, sys, time, subprocess, threading, traceback, datetime, platform, statistics

OUT = sys.argv[1] if len(sys.argv) > 1 else "lab-output"
os.makedirs(OUT, exist_ok=True)
NET = "nb-fail"


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


def sh(*cmd, check=True, quiet=False):
    r = subprocess.run(list(cmd), capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError("%s failed: %s" % (" ".join(cmd), r.stderr.strip()[:400]))
    return r.stdout.strip()


def docker_rm(*names):
    for n in names:
        sh("docker", "rm", "-f", "-v", n, check=False)


def wait(fn, timeout, step=1.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(step)
    return False


# ------------------------------------------------------------------ Redis
def redis_conn(port):
    import redis
    return redis.Redis(host="127.0.0.1", port=port, socket_timeout=5, socket_connect_timeout=2)


def write_until_killed(r, kill, seconds_before_kill, wait_replicas=False):
    """Write k:0, k:1, ... one at a time; kill() is called from another thread.
    Returns the number of writes the server acknowledged."""
    acked = [0]
    def killer():
        time.sleep(seconds_before_kill)
        kill()
    t = threading.Thread(target=killer); t.start()
    i = 0
    started = time.perf_counter()
    lat = []
    while True:
        try:
            t0 = time.perf_counter()
            r.set("k:%d" % i, i)
            if wait_replicas:
                r.execute_command("WAIT", 1, 1000)
            lat.append(time.perf_counter() - t0)
            i += 1
            acked[0] = i
        except Exception:
            break
        if time.perf_counter() - started > seconds_before_kill + 10:
            break
    t.join()
    return acked[0], lat


def present(r, n):
    """How many of k:0 .. k:n-1 exist."""
    pipe = r.pipeline(transaction=False)
    found = 0
    for start in range(0, n, 5000):
        keys = ["k:%d" % j for j in range(start, min(n, start + 5000))]
        found += sum(1 for v in r.mget(keys) if v is not None)
    return found


def nb_redis(log):
    log("## Redis")
    sh("docker", "network", "create", NET, check=False)

    def run_kill(label, args):
        docker_rm("nb-rf")
        sh("docker", "run", "-d", "--name", "nb-rf", "--network", NET, "-p", "6390:6379",
           "-v", "nb-rf-data:/data", "redis:7.4", "redis-server", *args)
        r = redis_conn(6390)
        wait(lambda: r.ping(), 30)
        r.flushall()
        ver = r.info("server")["redis_version"]
        acked, lat = write_until_killed(r, lambda: sh("docker", "kill", "-s", "KILL", "nb-rf"), 5)
        rate = acked / 5.0
        sh("docker", "start", "nb-rf")
        r = redis_conn(6390)
        wait(lambda: r.ping() and r.info("persistence").get("loading") == 0, 60)
        got = present(r, acked)
        lost = acked - got
        log("  %-44s acknowledged %6d, present after restart %6d, lost %6d" % (label, acked, got, lost))
        docker_rm("nb-rf"); sh("docker", "volume", "rm", "nb-rf-data", check=False)
        return ver, rate, lost

    log("### 1. The process is killed (kill -9) while one client writes, then restarted")
    ver, rate, _ = run_kill("AOF on, appendfsync everysec:", ["--appendonly", "yes", "--appendfsync", "everysec"])
    run_kill("AOF off, snapshots on the default schedule:", ["--appendonly", "no"])
    log("  Redis %s, one client, one SET per round trip: about %d writes a second" % (ver, rate))
    log("  Read it this way: a killed process does not lose what it already handed to the operating system.")
    log("  The AOF is written to the file before the reply, and only the fsync waits up to a second, so only")
    log("  a machine crash or power loss can lose that last second. With snapshots only, everything since the")
    log("  last snapshot is gone: the default schedule had not taken one yet.")

    log("")
    log("### 2. Failover to a lagging replica")
    log("  The replica is frozen (docker pause) for one second to stand in for a slow network or a busy")
    log("  replica. The primary is killed during that second, then the replica is unfrozen and promoted.")
    for label, use_wait in (("plain SET, replication is asynchronous:", False), ("SET then WAIT 1 500, count only confirmed writes:", True)):
        docker_rm("nb-rp", "nb-rr")
        sh("docker", "run", "-d", "--name", "nb-rp", "--network", NET, "-p", "6391:6379", "redis:7.4", "redis-server", "--appendonly", "no", "--save", "")
        sh("docker", "run", "-d", "--name", "nb-rr", "--network", NET, "-p", "6392:6379", "redis:7.4", "redis-server", "--replicaof", "nb-rp", "6379", "--save", "")
        p, rr = redis_conn(6391), redis_conn(6392)
        wait(lambda: p.ping() and rr.ping(), 30)
        wait(lambda: rr.info("replication").get("master_link_status") == "up", 30)
        stop = [False]
        acked = [0]; confirmed = [0]; unconfirmed = [0]; lat = []
        def writer():
            i = 0
            while not stop[0]:
                try:
                    t0 = time.perf_counter()
                    p.set("k:%d" % i, i)
                    ok = True
                    if use_wait:
                        ok = p.execute_command("WAIT", 1, 500) >= 1
                    lat.append(time.perf_counter() - t0)
                    i += 1; acked[0] = i
                    if ok: confirmed[0] = i
                    else: unconfirmed[0] += 1
                except Exception:
                    break
        t = threading.Thread(target=writer); t.start()
        time.sleep(3)
        sh("docker", "pause", "nb-rr")
        time.sleep(1)
        sh("docker", "kill", "-s", "KILL", "nb-rp")
        t.join(timeout=10); stop[0] = True
        sh("docker", "unpause", "nb-rr")
        rr = redis_conn(6392)
        wait(lambda: rr.ping(), 10)
        rr.execute_command("REPLICAOF", "NO", "ONE")
        got = present(rr, acked[0])
        med = statistics.median(lat) * 1000 if lat else 0
        if use_wait:
            got_conf = present(rr, confirmed[0]) if confirmed[0] else 0
            log("  %-52s acknowledged %6d, %4d of them reported unconfirmed by WAIT; confirmed and lost: %d. Median write %.3f ms" % (
                label, acked[0], unconfirmed[0], confirmed[0] - got_conf, med))
        else:
            log("  %-52s acknowledged %6d, on the promoted replica %6d, lost %4d. Median write %.3f ms" % (label, acked[0], got, acked[0] - got, med))
        docker_rm("nb-rp", "nb-rr")
    log("  Read it this way: the primary acknowledges a write before any replica has it. Writes acknowledged")
    log("  while the replica was behind are gone after the promotion. WAIT does not stop that, but it tells the")
    log("  client which writes no replica confirmed, so the application can retry them or report them. It does")
    log("  not make Redis a consensus system.")


# -------------------------------------------------------------- Cassandra
def nb_cassandra(log):
    log("## Cassandra: three nodes, replication factor 3")
    for n in ("nb-cass", "nb-ch"):
        sh("docker", "stop", n, check=False)
    sh("docker", "network", "create", NET, check=False)
    docker_rm("nb-c1", "nb-c2", "nb-c3")
    env = ["-e", "MAX_HEAP_SIZE=768M", "-e", "HEAP_NEWSIZE=128M", "-e", "CASSANDRA_SEEDS=nb-c1",
           "-e", "CASSANDRA_CLUSTER_NAME=nb", "-e", "CASSANDRA_ENDPOINT_SNITCH=GossipingPropertyFileSnitch", "-e", "CASSANDRA_DC=dc1"]

    def up_count():
        out = sh("docker", "exec", "nb-c1", "nodetool", "status", check=False)
        return sum(1 for l in out.splitlines() if l.startswith("UN"))

    t0 = time.time()
    sh("docker", "run", "-d", "--name", "nb-c1", "--network", NET, *env, "cassandra:5.0")
    if not wait(lambda: up_count() == 1, 300, 5):
        raise RuntimeError("node 1 did not start")
    for k, name in ((2, "nb-c2"), (3, "nb-c3")):
        sh("docker", "run", "-d", "--name", name, "--network", NET, *env, "-e", "JVM_EXTRA_OPTS=-Dcassandra.skip_wait_for_gossip_to_settle=0", "cassandra:5.0")
        if not wait(lambda: up_count() == k, 400, 5):
            raise RuntimeError("%s did not join" % name)
    log("  cluster of 3 up in %.0f s" % (time.time() - t0))
    for l in sh("docker", "exec", "nb-c1", "nodetool", "status").splitlines():
        if l.startswith(("UN", "DN", "--")):
            log("   ", l[:90])

    from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
    from cassandra import ConsistencyLevel as CL, Unavailable, WriteTimeout, ReadTimeout
    from cassandra.policies import RoundRobinPolicy
    ips = [sh("docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", n) for n in ("nb-c1", "nb-c2", "nb-c3")]
    prof = ExecutionProfile(load_balancing_policy=RoundRobinPolicy(), request_timeout=15)
    cl = Cluster(ips, execution_profiles={EXEC_PROFILE_DEFAULT: prof})
    se = cl.connect()
    log("# Cassandra:", se.execute("SELECT release_version FROM system.local").one()[0])
    se.execute("CREATE KEYSPACE IF NOT EXISTS nb WITH replication = {'class': 'NetworkTopologyStrategy', 'dc1': 3}")
    se.set_keyspace("nb")
    se.execute("CREATE TABLE IF NOT EXISTS kv (k int PRIMARY KEY, v text)")
    ins = se.prepare("INSERT INTO kv (k, v) VALUES (?, ?)")
    sel = se.prepare("SELECT v FROM kv WHERE k = ?")

    def trial(label, n_rows, offset):
        out = []
        for name, level in (("ONE", CL.ONE), ("QUORUM", CL.QUORUM), ("ALL", CL.ALL)):
            ins.consistency_level = level; sel.consistency_level = level
            ok = fail = 0; wl = []; reason = ""
            for i in range(n_rows):
                t = time.perf_counter()
                try:
                    se.execute(ins, (offset + i, "v%d" % i)); ok += 1; wl.append(time.perf_counter() - t)
                except (Unavailable, WriteTimeout) as e:
                    fail += 1; reason = type(e).__name__
                except Exception as e:
                    fail += 1; reason = type(e).__name__
            rok = 0; rl = []
            for i in range(n_rows):
                t = time.perf_counter()
                try:
                    if se.execute(sel, (offset + i,)).one() is not None:
                        rok += 1
                    rl.append(time.perf_counter() - t)
                except Exception as e:
                    reason = reason or type(e).__name__
            log("  %-22s %-7s writes ok %4d of %d%s   reads found %4d   median write %5.2f ms, read %5.2f ms" % (
                label, name, ok, n_rows, (" (" + reason + ")") if fail else "", rok,
                1000 * statistics.median(wl) if wl else float("nan"), 1000 * statistics.median(rl) if rl else float("nan")))
            offset += n_rows
        return offset

    N = 500
    log("### 1. All three nodes up: %d writes and %d reads at each consistency level" % (N, N))
    off = trial("3 of 3 up:", N, 0)
    log("### 2. One node stopped")
    sh("docker", "stop", "nb-c3")
    wait(lambda: up_count() == 2, 120, 3)
    off = trial("2 of 3 up:", N, off)
    log("### 3. Two nodes stopped")
    sh("docker", "stop", "nb-c2")
    wait(lambda: up_count() == 1, 120, 3)
    off = trial("1 of 3 up:", N, off)
    log("### 4. Both nodes back. Do they get the writes they missed?")
    written_while_down = list(range(1500, 2500)) + list(range(3000, 3500))
    sh("docker", "start", "nb-c2"); sh("docker", "start", "nb-c3")
    wait(lambda: up_count() == 3, 400, 5)
    def pending():
        out = sh("docker", "exec", "nb-c1", "nodetool", "listpendinghints", check=False) + sh("docker", "exec", "nb-c2", "nodetool", "listpendinghints", check=False)
        return [l for l in out.splitlines() if l.strip() and not l.startswith(("Host ID", "This node does not have any pending hints"))]
    t_h = time.time()
    drained = wait(lambda: not pending(), 180, 5)
    log("  pending hints on the other nodes: %s after %.0f s" % ("none" if drained else "still some", time.time() - t_h))
    sh("docker", "stop", "nb-c1"); sh("docker", "stop", "nb-c2")
    wait(lambda: sh("docker", "exec", "nb-c3", "nodetool", "status", check=False).count("UN") == 1, 120, 3)
    time.sleep(5)
    out = sh("docker", "exec", "nb-c3", "cqlsh", "-e", "CONSISTENCY ONE; PAGING OFF; SELECT k FROM nb.kv;", check=False)
    have = set(int(l.strip()) for l in out.splitlines() if l.strip().isdigit())
    found = sum(1 for k in written_while_down if k in have)
    log("  with only node 3 running, reads at ONE of the %d writes it missed while down: %d found" % (len(written_while_down), found))
    log("  (1,000 written at ONE and QUORUM with node 3 down, 500 at ONE with nodes 2 and 3 down)")
    cl.shutdown()
    log("  Read it this way: with three copies, QUORUM needs two. One node down, QUORUM still works and ALL")
    log("  fails at once with Unavailable. Two down, only ONE works, and those writes live on one machine until")
    log("  the others come back and hints (kept up to max_hint_window, 3 hours by default) or repair copy them.")
    docker_rm("nb-c1", "nb-c2", "nb-c3")


def main():
    log = Log("failure")
    log("# Notebook 9: Redis and Cassandra when something fails")
    log("# run at:", datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"))
    log("# runner:", platform.platform(), "|", os.cpu_count(), "vCPU")
    log("Timings are from a client on the same machine and include the round trip.")
    log("")
    for part in (nb_redis, nb_cassandra):
        try:
            part(log)
        except Exception:
            log("  this part failed:")
            for l in traceback.format_exc().splitlines()[-6:]:
                log("   ", l)
        log("")
    sh("docker", "network", "rm", NET, check=False)
    log.save()


if __name__ == "__main__":
    main()
