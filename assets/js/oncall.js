/* On call tonight: branching incident scenarios. Each choice gets feedback; good calls move on. */
(function () {
  var root = document.getElementById('oncall');
  if (!root) return;
  var S = {
    disk: { title: 'The disk is filling up', engine: 'PostgreSQL', start: 'n1', nodes: {
      n1: { t: '02:40', text: 'Alert: the disk on the PostgreSQL primary is at 92% and climbing about 1% every 10 minutes. Writes still succeed. What do you do first?',
        ev: '$ df -h /var/lib/postgresql\nFilesystem  Size  Used Avail Use% Mounted on\n/dev/nvme1  260G  239G   21G  92% /var/lib/postgresql',
        ch: [['Delete old files in pg_wal/ to free space', 'bad', 'Never. Those files may be needed for crash recovery and by replicas. Deleting them by hand can leave the database unable to start.', null],
             ['Find out what is growing: the data or the WAL', 'good', 'Right. The fix depends entirely on which one it is.', 'n2'],
             ['Restart PostgreSQL', 'bad', 'A restart frees no disk, and crash recovery needs room to write. You spend the time you have on nothing.', null]] },
      n2: { t: '02:44', text: 'The data directory is normal. The WAL directory is huge. Normally it sits around a gigabyte or two.',
        ev: '$ du -sh pg_wal base\n180G  pg_wal\n 58G  base',
        ch: [['Check the replication slots', 'good', 'Right. A slot keeps WAL until its consumer reads it, so a stuck consumer makes WAL pile up.', 'n3'],
             ['Run CHECKPOINT to recycle the WAL', 'ok', 'A checkpoint recycles WAL that nothing else needs. Here it changes nothing, because something is holding the WAL. Find what.', null],
             ['Raise max_wal_size', 'bad', 'That lets the WAL grow further before checkpoints. It does not explain or fix 180 GB.', null]] },
      n3: { t: '02:47', text: 'One slot is inactive and holds almost all of it. The other is the streaming replica, and it is healthy.',
        ev: "postgres=# SELECT slot_name, active, wal_status,\n  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS held\n  FROM pg_replication_slots;\n slot_name  | active | wal_status | held\n------------+--------+------------+--------\n cdc_orders | f      | extended   | 176 GB\n replica1   | t      | reserved   | 12 MB",
        ch: [['Ask the owner of the CDC consumer whether it is coming back, then drop cdc_orders if not', 'good', 'The best call when you have the time. Dropping the slot releases the WAL at the next checkpoint, and the owner knows the consumer will need a fresh snapshot.', 'end'],
             ['Drop cdc_orders right away', 'ok', 'At 92% and climbing, this is often the right call, and it frees the disk. The CDC consumer will need a new snapshot, so tell its owner.', 'end'],
             ['Drop every slot', 'bad', 'replica1 is active and healthy. Dropping its slot can leave the replica needing WAL the primary has already removed, and then it must be rebuilt.', null]] },
      end: { end: true, text: 'Cause: a change data capture consumer stopped, and its replication slot kept every WAL file since. Prevention: set max_slot_wal_keep_size as a ceiling, and alert on inactive slots and on WAL held per slot.',
        links: [['Add change data capture, safely', '../designs/migrations/index.html#cdc'], ['A stuck replica can fill the primary disk', '../compare/index.html#replica-lag']] } } },
    locks: { title: 'Checkout is timing out', engine: 'PostgreSQL', start: 'n1', nodes: {
      n1: { t: '19:05', text: 'Checkout requests time out. The application\'s connection pool is exhausted. CPU on the database is under 10%. What do you do first?',
        ev: 'app: TimeoutError: could not acquire a connection from the pool within 5000 ms\ndb:  CPU 8%   disk I/O low   connections 100 of 100',
        ch: [['Scale the database up to a bigger instance', 'bad', 'CPU is at 8%. The database is not short of capacity, it is waiting on something.', null],
             ['Look at what the sessions are doing', 'good', 'Right. Low CPU with a full pool means sessions are waiting.', 'n2'],
             ['Restart the application servers', 'ok', 'It frees the pool for a minute. Whatever is blocking is still there, and the pool fills again.', null]] },
      n2: { t: '19:08', text: 'Almost every session is waiting on a lock. One is idle inside a transaction.',
        ev: "postgres=# SELECT state, wait_event_type, count(*)\n  FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC;\n        state        | wait_event_type | count\n---------------------+-----------------+-------\n active              | Lock            |    96\n active              |                 |     3\n idle in transaction |                 |     1",
        ch: [['Find the session that blocks the others', 'good', 'Right. One blocker can hold up all 96.', 'n3'],
             ['Terminate all the waiting sessions', 'bad', 'They come straight back, and the blocker still holds its lock.', null],
             ['Add an index on the table', 'bad', 'This is a lock wait, not a slow scan. An index does not release a lock.', null]] },
      n3: { t: '19:10', text: 'The blocker updated the hot stock row 14 minutes ago and never committed. Its query is idle.',
        ev: "postgres=# SELECT pid, state, now() - xact_start AS age, left(query, 50) AS query\n  FROM pg_stat_activity\n  WHERE pid IN (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity);\n pid  |        state        |   age    |                  query\n------+---------------------+----------+------------------------------------------\n 4121 | idle in transaction | 00:14:32 | UPDATE stock SET available = available - 1",
        ch: [['SELECT pg_terminate_backend(4121)', 'good', 'Right. The transaction rolls back, the lock is released, and the 96 waiting sessions move.', 'end'],
             ['SELECT pg_cancel_backend(4121)', 'ok', 'Cancel stops a running query. This session is idle, so there is nothing to cancel. Terminate it instead.', null],
             ['Wait for it to finish', 'bad', 'An idle transaction is waiting for the application, which has probably forgotten it. It will not finish on its own.', null]] },
      end: { end: true, text: 'Cause: the application opened a transaction, updated the hot row, then called a slow outside service before committing. Prevention: keep outside calls out of transactions, and set idle_in_transaction_session_timeout and lock_timeout for application sessions.',
        links: [['The lock pile-up lab', '../labs/index.html#lock-pileup'], ['A transaction open across a network call', '../designs/anti-patterns/index.html#long-transaction']] } } },
    lag: { title: 'The replica is far behind', engine: 'MySQL', start: 'n1', nodes: {
      n1: { t: '07:30', text: 'The morning reports, which read from a replica, show yesterday\'s numbers. The replica is far behind the source. What do you do first?',
        ev: 'dashboard: replica lag 40 min and rising',
        ch: [['Look at the replica\'s status', 'good', 'Right. First find out whether it is stopped, slow, or stuck on one thing.', 'n2'],
             ['Skip the transaction it is stuck on', 'bad', 'Skipping silently drops that transaction\'s changes on the replica. The replica then differs from the source, and every report built on it is wrong.', null],
             ['Stop and start replication', 'ok', 'It rarely helps. Replication was running; restarting it does not make it faster.', null]] },
      n2: { t: '07:33', text: 'Both threads are running, with no error. The applier is busy with row deletes.',
        ev: "mysql> SHOW REPLICA STATUS\\G\n...\n     Replica_IO_Running: Yes\n    Replica_SQL_Running: Yes\n  Seconds_Behind_Source: 2412\n         Last_SQL_Error:\nReplica_SQL_Running_State: Applying batch of row changes (delete)",
        ch: [['Find out what is being applied', 'good', 'Right. A single large transaction is the usual cause of this shape.', 'n3'],
             ['Raise replica_parallel_workers', 'ok', 'Parallel apply helps many small transactions. One big transaction still applies as one unit.', null],
             ['Blame the network', 'bad', 'The I/O thread is running and the relay log is not the bottleneck. The applier is.', null]] },
      n3: { t: '07:36', text: 'At 01:10 a cleanup job ran one DELETE that removed 40 million old rows in a single transaction. The replica is replaying it row by row.',
        ev: "source> DELETE FROM events WHERE created_at < '2025-01-01';\nQuery OK, 40213877 rows affected",
        ch: [['Let it finish, send the reports to the source meanwhile, and change the job to delete in batches', 'good', 'The safe fix today and the real fix for tomorrow.', 'end'],
             ['Rebuild the replica from a fresh backup', 'ok', 'It works, but it is usually slower than letting the apply finish. Consider it if the lag would outlast the source\'s binlog retention.', null],
             ['Stop the applier and skip the DELETE', 'bad', 'Then the replica keeps 40 million rows the source deleted, and every report on it is wrong.', null]] },
      end: { end: true, text: 'Cause: one huge transaction on the source replays as one huge unit on the replica. Prevention: delete in batches of a few thousand rows per transaction, or drop time partitions, and alert on replica lag before the reports run.',
        links: [['Why a replica falls behind', '../compare/index.html#replica-lag'], ['DELETE for retention, the anti-pattern', '../designs/anti-patterns/index.html#delete-retention']] } } }
  };
  var tabs = root.querySelector('.oc-tabs'), stage = root.querySelector('.oc-stage');
  var cur, path, calls;
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function start(id) {
    cur = S[id]; path = []; calls = { good: 0, ok: 0, bad: 0 };
    Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.dataset.s === id); b.setAttribute('aria-pressed', String(b.dataset.s === id)); });
    show(cur.start);
  }
  function show(nid) {
    var n = cur.nodes[nid];
    if (n.end) {
      stage.innerHTML = '<div class="oc-card"><p class="oc-time">Resolved</p><h3>' + esc(cur.title) + '</h3><p>' + esc(n.text) + '</p>' +
        '<p class="labnote">Your calls: ' + calls.good + ' good, ' + calls.ok + ' workable, ' + calls.bad + ' that would have made it worse.</p>' +
        '<p>' + n.links.map(function (l) { return '<a href="' + l[1] + '">' + esc(l[0]) + ' →</a>'; }).join('<br>') + '</p>' +
        '<button type="button" class="labbtn oc-again">Run it again</button></div>';
      stage.querySelector('.oc-again').addEventListener('click', function () { start(tabs.querySelector('.on').dataset.s); });
      return;
    }
    var h = '<div class="oc-card"><p class="oc-time">' + esc(cur.engine) + ' · ' + esc(n.t) + '</p><p class="oc-text">' + esc(n.text) + '</p>' +
      '<p class="oc-evl">What you see (sample output)</p><pre class="oc-ev">' + esc(n.ev) + '</pre><div class="oc-ch">' +
      n.ch.map(function (c, i) { return '<button type="button" class="qopt" data-i="' + i + '">' + esc(c[0]) + '</button>'; }).join('') +
      '</div><div class="oc-fb" aria-live="polite"></div></div>';
    stage.innerHTML = h;
    Array.prototype.forEach.call(stage.querySelectorAll('.oc-ch .qopt'), function (b) {
      b.addEventListener('click', function () {
        var c = n.ch[+b.dataset.i], fb = stage.querySelector('.oc-fb');
        calls[c[1]]++;
        b.classList.add(c[1] === 'good' ? 'good' : c[1] === 'bad' ? 'bad' : 'meh');
        var label = c[1] === 'good' ? 'Good call.' : c[1] === 'ok' ? 'Workable, but not the best move.' : 'That would make it worse.';
        fb.innerHTML = '<p class="oc-v ' + c[1] + '"><b>' + label + '</b> ' + esc(c[2]) + '</p>' +
          (c[3] ? '<button type="button" class="labbtn oc-next">Continue →</button>' : '<p class="labnote">Try another option.</p>');
        if (c[3]) {
          Array.prototype.forEach.call(stage.querySelectorAll('.oc-ch .qopt'), function (o) { o.disabled = true; });
          fb.querySelector('.oc-next').addEventListener('click', function () { show(c[3]); stage.scrollIntoView({ block: 'nearest' }); });
        } else { b.disabled = true; }
      });
    });
  }
  Array.prototype.forEach.call(tabs.querySelectorAll('button'), function (b) { b.addEventListener('click', function () { start(b.dataset.s); }); });
  start('disk');
})();
