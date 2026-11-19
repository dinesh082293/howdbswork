/* Engine architecture, animated: processes, memory and disk as three layers,
   with requests, writes and background work moving through them one scene
   at a time. Each engine below is data: its boxes, the small moving parts
   inside them (widgets), and its scenes. The layout is computed.
   Markup: <div class="archanim" data-engine="pg|my|mo|rd|cs|vx"></div> */
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FLIGHT = 1300, STEP = 1650, HOLD = 2800;
  var BAND = { proc: 'Processes', mem: 'Memory', disk: 'Disk' };

  /* Box: [id, label, sub, weight, opts]. opts.full: own row on phones.
     Widget types: spawn (small cards that appear), slots (pages, keys or
     files), bar (one record), segs (log segments), mark (a flag), graph
     (HNSW layers). Scene fx(S) changes the lasting state; moves fly. */
  var ENG = {};

  ENG.pg = {
    name: 'PostgreSQL', intro: ['Three layers: processes, memory, disk', 'Press play to watch one connection, one read, one write and the background work move through them. When something is slow or broken, it lives in one of these three layers.'],
    left: ['client', 'Your app', 'driver'], right: [['standby', 'Standby', 'replays the WAL']],
    proc: [['postmaster', 'postmaster', 'listens, starts the rest'], ['backend', 'backends', 'one per connection'], ['walwriter', 'WAL writer', 'flushes the log'], ['checkpointer', 'checkpointer', 'writes dirty pages'], ['autovac', 'autovacuum', 'removes dead rows'], ['walsender', 'WAL sender', 'streams to standbys']],
    mem: [['buffers', 'shared_buffers', '8 KB pages, about 25% of RAM', 3, { full: 1 }], ['walbuf', 'WAL buffers', 'log records', 1], ['workmem', 'work_mem', 'per sort or hash', 1]],
    disk: [['base', 'base/', 'table and index files', 2.2, { full: 1 }], ['wal', 'pg_wal/', '16 MB log segments', 1.8], ['xact', 'pg_xact/', 'commit status', 1]],
    widgets: { bk: ['spawn', 'backend', 3, 'b'], pages: ['slots', 'buffers', 8, ['clean', 'clean', 'clean', 'clean', 'clean', 'empty', 'empty', 'empty']], rec: ['bar', 'walbuf'], seg: ['segs', 'wal', 5, 3], ck: ['mark', 'wal', '⚑ checkpoint'], sr: ['rep', 'standby', ['WAL receiver', 'pg_wal/ (its copy)', 'startup: replays'], ['clean', 'clean', 'clean', 'clean']] },
    rep: { box: 'standby', name: 'Standby', promotedName: 'New primary', primary: 'primary', unit: 'commit', label: 'Replication', modes: ['async', 'synchronous'], def: 0, lostText: 'the last commit is lost', keptText: 'every commit is here' },
    scenes: [
      { layers: ['proc'], hl: ['client', 'postmaster', 'backend'], t: 'A client connects, and gets its own process',
        s: 'The postmaster accepts the connection and starts a backend process just for it. A hundred connections means a hundred processes, each with its own memory.',
        d: 'This is why PostgreSQL connections are expensive and why poolers like PgBouncer exist: the pooler keeps a few backends busy instead of hundreds idle.',
        moves: [['q', 'client', 'postmaster', 0, 'connect'], ['q', 'postmaster', 'backend', 0.5, 'fork']], fx: function (S) { S.bk = 3; } },
      { layers: ['proc', 'mem'], hl: ['backend', 'buffers'], t: 'A SELECT finds its page in memory',
        s: 'The backend looks for the page in shared_buffers first. It is there, so the answer comes straight from memory: no disk at all.',
        d: 'A healthy OLTP server serves almost every read this way. pg_stat_database counts these as blks_hit.',
        moves: [['q', 'client', 'backend', 0, 'SELECT'], ['q', 'backend', 'pages:2', 0.45, 'find'], ['r', 'pages:2', 'client', 0.75, 'rows']], fx: function (S) { S.hit.pages = 2; } },
      { layers: ['mem', 'disk'], hl: ['buffers', 'base'], t: 'Not in memory: read 8 KB from disk',
        s: 'For a page that is not cached, the backend reads it from the table file in base/ into a free slot in shared_buffers. Slower, and then cached for next time.',
        d: 'The operating system has its own cache too, so a "disk" read may still come from RAM. pg_stat_database counts these as blks_read.',
        moves: [['q', 'backend', 'buffers', 0, 'miss'], ['p', 'base', 'pages:5', 0.35, '8 KB page']], fx: function (S) { S.pages[5] = 'clean'; } },
      { layers: ['mem'], hl: ['backend', 'walbuf', 'buffers'], t: 'An UPDATE: the log first, then the page',
        s: 'The backend writes a WAL record describing the change into the WAL buffers, then changes the page in shared_buffers. The page is now dirty: newer in memory than on disk.',
        d: 'An UPDATE in PostgreSQL writes a new row version and leaves the old one behind as a dead row. Vacuum deals with it later.',
        moves: [['q', 'client', 'backend', 0, 'UPDATE'], ['w', 'backend', 'walbuf', 0.4, 'WAL record'], ['q', 'backend', 'pages:2', 0.65, 'change']], fx: function (S) { S.pages[2] = 'dirty'; S.dead.pages = 2; S.rec = 1; } },
      { layers: ["mem", "disk"], hl: ["walbuf", "walwriter", "wal", "xact"], t: "COMMIT: the WAL reaches disk, then the app hears back",
        s: "The WAL record is flushed to pg_wal/ and the commit is recorded in pg_xact/, then the client gets its answer. With asynchronous replication the standby has not received it yet: it is one commit behind.",
        d: "This one flush is the price of a durable commit: a fraction of a millisecond on local NVMe, more on network storage. Notebook 2 measures it.",
        moves: [["w", "walbuf", "wal", 0, "flush"], ["w", "wal", "xact", 0.45, "committed"], ["a", "backend", "client", 0.7, "✓ COMMIT"]], fx: function (S) { S.rec = 0; S.seg = 4; S.fsync = 'wal'; S.lag = S.sync ? 0 : 1; },
        alt: { t: "COMMIT with a synchronous standby: it confirms first", s: "The WAL record is flushed locally and streamed to the standby, which writes it to its own pg_wal/ and confirms. Only then does the app hear back. Every acknowledged commit is now on two machines.", d: "The cost is a network round trip on every commit. synchronous_commit = on with synchronous_standby_names waits for the standby to flush; remote_apply also waits for it to replay.", moves: [["w", "walbuf", "wal", 0, "flush"], ["w", "walsender", "rep:0", 0.2, "WAL"], ["w", "rep:0", "rep:1", 0.4, "write"], ["a", "rep:0", "backend", 0.6, "✓ flushed"], ["w", "wal", "xact", 0.75, "committed"], ["a", "backend", "client", 0.9, "✓ COMMIT"]], lines: ["COMMIT: the WAL record is flushed to pg_wal/", "The WAL sender streams it to the standby", "The standby writes it to its own pg_wal/", "The standby confirms: flushed", "The commit is recorded in pg_xact/", "Only now does the app hear back"], fx: function (S) { S.rec = 0; S.seg = 4; S.fsync = 'wal'; S.lag = 0; } } },
      { layers: ['proc', 'disk'], hl: ['checkpointer', 'buffers', 'base', 'wal'], t: 'Later, the checkpointer writes dirty pages to disk',
        s: 'In the background, the checkpointer writes every dirty page to its file in base/ and marks a checkpoint in the WAL. A crash now only needs the WAL written after it.',
        d: 'checkpoint_timeout and max_wal_size decide how often this happens. Too often means write bursts; too rarely means longer crash recovery.',
        moves: [['p', 'pages:2', 'base', 0.1, 'dirty page'], ['c', 'checkpointer', 'wal', 0.55, 'checkpoint']], fx: function (S) { S.pages[2] = 'clean'; S.ck = 1; } },
      { layers: ['proc', 'mem'], hl: ['autovac', 'buffers'], t: 'Autovacuum removes the dead row version',
        s: 'The old version left by the UPDATE is invisible to every transaction now. Autovacuum finds it and marks the space free for new rows.',
        d: 'One transaction left open for hours stops this cleanup for every table, which is how tables bloat. The symptom pages show how to find it.',
        moves: [['v', 'autovac', 'pages:2', 0, 'vacuum']], fx: function (S) { S.dead.pages = -1; } },
      { layers: ["proc", "disk"], hl: ["wal", "walsender", "standby"], t: "The standby receives the WAL and replays it",
        s: "The WAL sender streams the new records, the standby's WAL receiver writes them to its own pg_wal/, and the startup process replays them into its copy of the page. Now it is in step.",
        d: "The standby replays the log, not the SQL, so it ends up with the same bytes. pg_stat_replication on the primary shows how far behind each standby is.",
        moves: [["w", "wal", "walsender", 0, "WAL"], ["w", "walsender", "rep:0", 0.2, "WAL stream"], ["w", "rep:0", "rep:1", 0.4, "write"], ["w", "rep:1", "rep:2", 0.6, "replay"], ["p", "rep:2", "rpages:2", 0.8, "page"]], fx: function (S) { S.lag = 0; S.rpages[2] = 'dirty'; },
        lines: ["The WAL sender reads the new WAL", "and streams it to the standby's WAL receiver", "The receiver writes it to the standby's pg_wal/", "The startup process replays it", "and the standby's copy of the page changes"],
        alt: { t: "The standby replays the WAL it already has", s: "With a synchronous standby the WAL arrived during the commit. Replay still runs on its own schedule, so a read on the standby can briefly see the old row.", d: "synchronous_commit = remote_apply makes the commit wait for replay too, so reads on the standby are never behind. It costs more on every commit.", moves: [["w", "rep:1", "rep:2", 0, "replay"], ["p", "rep:2", "rpages:2", 0.4, "page"]], lines: ["The startup process replays the WAL it already received", "and the standby's copy of the page changes"], fx: function (S) { S.lag = 0; S.rpages[2] = 'dirty'; } } },
      { layers: ["proc", "mem", "disk"], hl: ["client", "standby"], t: "The primary fails: a commit that was not streamed is gone",
        s: "One more commit is acknowledged, and the primary crashes before streaming it. The standby is promoted and the app reconnects, but that commit does not exist on the new primary. With asynchronous replication, the replication lag is what you lose.",
        d: "This is the trade in Decision 2 on this site: what a commit waits for, and what each choice costs when a server dies.",
        moves: [["q", "client", "backend", 0, "UPDATE"], ["a", "backend", "client", 0.25, "✓ COMMIT"], ["x", "postmaster", "postmaster", 0.5, "crash"], ["q", "client", "standby", 0.75, "reconnect"]], fx: function (S) { S.down = 1; S.promoted = 1; S.lost = S.sync ? 2 : 1; S.lag = 0; },
        lines: ["One more UPDATE commits on the primary", "The app is told it committed", "The primary crashes before streaming it", "The standby is promoted, and that commit is not on it"],
        alt: { t: "The primary fails: nothing acknowledged is lost", s: "With a synchronous standby, the last commit reached the standby before the app heard back. The promoted standby has every commit the app was told about.", d: "The price was the extra round trip on every commit. And if the only synchronous standby is down, commits wait: plan for two standbys or a quorum.", moves: [["q", "client", "backend", 0, "UPDATE"], ["w", "walsender", "rep:0", 0.2, "WAL"], ["a", "rep:0", "backend", 0.4, "✓ flushed"], ["a", "backend", "client", 0.6, "✓ COMMIT"], ["x", "postmaster", "postmaster", 0.75, "crash"], ["q", "client", "standby", 0.9, "reconnect"]], lines: ["One more UPDATE commits on the primary", "Its WAL reaches the standby first", "The standby confirms", "Then the app is told it committed", "The primary crashes", "The standby is promoted, with every commit"], fx: function (S) { S.down = 1; S.promoted = 1; S.lost = 2; S.lag = 0; } } }
    ]
  };

  ENG.my = {
    name: 'MySQL', intro: ['One process, many threads, two logs', 'Press play to follow a connection, a read and a write through InnoDB. Watch the two logs: the redo log makes a commit survive a crash, the binlog feeds replicas and point-in-time recovery.'],
    left: ['client', 'Your app', 'driver'], right: [['replica', 'Replica', 'applies the binlog']],
    proc: [['mysqld', 'mysqld', 'one process, many threads'], ['conn', 'connection threads', 'one per connection'], ['logw', 'log writer', 'writes and flushes redo'], ['cleaner', 'page cleaner', 'flushes dirty pages'], ['purge', 'purge', 'removes old versions'], ['dump', 'binlog dump', 'sends to replicas']],
    mem: [['pool', 'buffer pool', '16 KB pages, 60 to 75% of RAM', 3, { full: 1 }], ['logbuf', 'log buffer', 'redo records', 1], ['bcache', 'binlog cache', 'per session', 1]],
    disk: [['ibd', 'shop/users.ibd', 'the table is its primary key', 1.6, { full: 1 }], ['redo', '#innodb_redo/', 'redo log', 1.2], ['binlog', 'binlog.000042', 'row events', 1.2], ['undo', 'undo_001', 'old row versions', 1]],
    widgets: { th: ['spawn', 'conn', 3, 't'], pages: ['slots', 'pool', 8, ['clean', 'clean', 'clean', 'clean', 'clean', 'empty', 'empty', 'empty']], rec: ['bar', 'logbuf'], brec: ['bar', 'bcache'], seg: ['segs', 'redo', 4, 2], bseg: ['segs', 'binlog', 4, 2], hist: ['segs', 'undo', 4, 1, 'dead'], sr: ['rep', 'replica', ['I/O thread', 'relay log', 'applier threads'], ['clean', 'clean', 'clean', 'clean']] },
    rep: { box: 'replica', name: 'Replica', promotedName: 'New primary', primary: 'source', unit: 'transaction', label: 'Replication', modes: ['async', 'semi-sync'], def: 0, lostText: 'the last commit is lost', keptText: 'every commit is here' },
    scenes: [
      { layers: ['proc'], hl: ['client', 'mysqld', 'conn'], t: 'A client connects, and gets a thread',
        s: 'mysqld is one process. Each connection gets its own thread inside it, taken from the thread cache when one is free.',
        d: 'Threads are cheaper than PostgreSQL\'s processes, but thousands of them still fight for CPU. Threads_running is the number that matters.',
        moves: [['q', 'client', 'mysqld', 0, 'connect'], ['q', 'mysqld', 'conn', 0.5, 'thread']], fx: function (S) { S.th = 3; } },
      { layers: ['proc', 'mem'], hl: ['conn', 'pool'], t: 'A lookup by primary key finds its page in the buffer pool',
        s: 'In InnoDB the table is a B-tree ordered by primary key, and the rows live in its leaf pages. The leaf page is already in the buffer pool, so no disk read.',
        d: 'A lookup by a secondary index reads that index first, finds the primary key, then walks the primary key tree too.',
        moves: [['q', 'client', 'conn', 0, 'SELECT'], ['q', 'conn', 'pages:2', 0.45, 'find'], ['r', 'pages:2', 'client', 0.75, 'row']], fx: function (S) { S.hit.pages = 2; } },
      { layers: ['mem', 'disk'], hl: ['pool', 'ibd'], t: 'Not cached: read a 16 KB page from the table file',
        s: 'For a page that is not in the buffer pool, the thread reads 16 KB from users.ibd into a free slot. With innodb_flush_method set to O_DIRECT, InnoDB skips the OS cache, so the buffer pool is the cache.',
        d: 'That is why the buffer pool is sized much larger than PostgreSQL\'s shared_buffers: 60 to 75% of memory on a dedicated server.',
        moves: [['q', 'conn', 'pool', 0, 'miss'], ['p', 'ibd', 'pages:5', 0.35, '16 KB page']], fx: function (S) { S.pages[5] = 'clean'; } },
      { layers: ['mem', 'disk'], hl: ['conn', 'pool', 'logbuf', 'bcache', 'undo'], t: 'An UPDATE changes the row in place',
        s: 'The old version is copied to undo, a redo record goes into the log buffer, the row is changed in its page, and a binlog event waits in this session\'s binlog cache.',
        d: 'Readers that need the old version rebuild it from undo. That is how InnoDB keeps consistent reads without leaving dead rows in the table.',
        moves: [['q', 'client', 'conn', 0, 'UPDATE'], ['d', 'pages:2', 'undo', 0.3, 'old version'], ['w', 'conn', 'logbuf', 0.45, 'redo'], ['w', 'conn', 'bcache', 0.6, 'binlog event']], fx: function (S) { S.pages[2] = 'dirty'; S.rec = 1; S.brec = 1; S.hist = 3; } },
      { layers: ["mem", "disk"], hl: ["logw", "logbuf", "redo", "bcache", "binlog"], t: "COMMIT: redo and binlog reach disk together",
        s: "A two-phase commit: the redo log is flushed with the transaction prepared, the binlog is written and flushed, then the commit is marked in redo. The app hears back. The replica has not received it yet.",
        d: "innodb_flush_log_at_trx_commit = 1 and sync_binlog = 1 make both flushes happen on every commit. Group commit lets many sessions share one flush.",
        moves: [["w", "logbuf", "redo", 0, "prepare"], ["w", "bcache", "binlog", 0.3, "binlog"], ["w", "logbuf", "redo", 0.55, "commit"], ["a", "conn", "client", 0.75, "✓ COMMIT"]], fx: function (S) { S.rec = 0; S.brec = 0; S.seg = 3; S.bseg = 3; S.fsync = 'redo'; S.lag = S.sync ? 0 : 1; },
        alt: { t: "COMMIT with semi-sync: a replica confirms first", s: "With semi-synchronous replication (AFTER_SYNC), the source waits until at least one replica has written the transaction to its relay log before telling the app.", d: "If no replica answers within rpl_semi_sync_source_timeout (10 seconds by default), the source falls back to asynchronous and carries on. Watch Rpl_semi_sync_source_status.", moves: [["w", "logbuf", "redo", 0, "prepare"], ["w", "bcache", "binlog", 0.2, "binlog"], ["w", "dump", "rep:0", 0.4, "binlog event"], ["w", "rep:0", "rep:1", 0.55, "relay log"], ["a", "rep:0", "conn", 0.7, "✓ received"], ["a", "conn", "client", 0.85, "✓ COMMIT"]], lines: ["Redo is flushed with the transaction prepared", "The binlog is written and flushed", "The binlog dump thread sends it to the replica", "The I/O thread writes it to the relay log", "The replica confirms it has it", "Only now does the app hear back"], fx: function (S) { S.rec = 0; S.brec = 0; S.seg = 3; S.bseg = 3; S.fsync = 'redo'; S.lag = 0; } } },
      { layers: ['proc', 'disk'], hl: ['cleaner', 'pool', 'ibd'], t: 'Later, the page cleaner flushes the dirty page',
        s: 'Background page cleaner threads write dirty pages back to users.ibd, first through the doublewrite buffer, so a half-written page can be repaired after a crash.',
        d: 'The redo log is a ring. If dirty pages are not flushed fast enough, the ring fills and writes stall: checkpoint age is the number to watch.',
        moves: [['p', 'pages:2', 'ibd', 0.1, 'dirty page']], fx: function (S) { S.pages[2] = 'clean'; } },
      { layers: ['proc', 'disk'], hl: ['purge', 'undo'], t: 'Purge removes old versions no one needs',
        s: 'When no open transaction can still see the old row version, purge threads remove it from undo. The history list gets shorter.',
        d: 'One transaction left open for hours stops purge. The history list grows into the millions and reads slow down: SHOW ENGINE INNODB STATUS shows its length.',
        moves: [['v', 'purge', 'undo', 0, 'purge']], fx: function (S) { S.hist = 1; } },
      { layers: ["proc", "disk"], hl: ["binlog", "dump", "replica"], t: "The replica receives the binlog and applies it",
        s: "The binlog dump thread sends the new events, the replica's I/O thread writes them to its relay log, and the applier threads apply them to its own tables. Now it is in step.",
        d: "Replication is asynchronous by default: the source does not wait. SHOW REPLICA STATUS on the replica shows how far behind it is.",
        moves: [["w", "binlog", "dump", 0, "events"], ["w", "dump", "rep:0", 0.2, "binlog"], ["w", "rep:0", "rep:1", 0.4, "relay log"], ["w", "rep:1", "rep:2", 0.6, "apply"], ["p", "rep:2", "rpages:2", 0.8, "row"]], fx: function (S) { S.lag = 0; S.rpages[2] = 'dirty'; },
        lines: ["The binlog dump thread reads the new events", "and sends them to the replica's I/O thread", "which writes them to the relay log", "The applier threads apply them", "and the replica's row changes too"],
        alt: { t: "The replica applies what it already received", s: "With semi-sync the event reached the relay log during the commit. The applier threads still apply it on their own schedule, so the replica can briefly show the old row.", d: "Semi-sync guarantees the replica received the transaction, not that it applied it. Lag on reads is still possible.", moves: [["w", "rep:1", "rep:2", 0, "apply"], ["p", "rep:2", "rpages:2", 0.4, "row"]], lines: ["The applier threads apply the relay log", "and the replica's row changes too"], fx: function (S) { S.lag = 0; S.rpages[2] = 'dirty'; } } },
      { layers: ["proc", "mem", "disk"], hl: ["client", "replica"], t: "The source fails: a commit not yet sent is gone",
        s: "One more commit is acknowledged, and the source crashes before the replica receives it. The failover tool promotes the replica and the app reconnects, but that commit is not there.",
        d: "GitHub's story on this site shows the other half: a failover tool needs rules about when to promote and when to wait for a human.",
        moves: [["q", "client", "conn", 0, "UPDATE"], ["a", "conn", "client", 0.25, "✓ COMMIT"], ["x", "mysqld", "mysqld", 0.5, "crash"], ["q", "client", "replica", 0.75, "reconnect"]], fx: function (S) { S.down = 1; S.promoted = 1; S.lost = S.sync ? 2 : 1; S.lag = 0; },
        lines: ["One more UPDATE commits on the source", "The app is told it committed", "The source crashes before sending it", "The replica is promoted, and that commit is not on it"],
        alt: { t: "The source fails: nothing acknowledged is lost", s: "With semi-sync (AFTER_SYNC), the last commit was in the replica's relay log before the app heard back. The promoted replica applies it and has every acknowledged commit.", d: "The promoted replica must finish applying its relay log before it takes writes, or reads will miss the last transactions.", moves: [["q", "client", "conn", 0, "UPDATE"], ["w", "dump", "rep:0", 0.2, "binlog event"], ["a", "rep:0", "conn", 0.4, "✓ received"], ["a", "conn", "client", 0.6, "✓ COMMIT"], ["x", "mysqld", "mysqld", 0.75, "crash"], ["q", "client", "replica", 0.9, "reconnect"]], lines: ["One more UPDATE commits on the source", "Its binlog event reaches the replica first", "The replica confirms", "Then the app is told it committed", "The source crashes", "The replica is promoted, with every commit"], fx: function (S) { S.down = 1; S.promoted = 1; S.lost = 2; S.lag = 0; } } }
    ]
  };

  ENG.mo = {
    name: 'MongoDB', intro: ['mongod, the WiredTiger cache, and three kinds of file', 'Press play to follow a read and a write with write concern majority. Watch the journal, which makes a write survive a crash, and the oplog, which the secondaries copy.'],
    left: ['client', 'Your app', 'driver pool'], right: [['sec', 'Secondaries', 'copy the oplog']],
    proc: [['mongod', 'mongod', 'one process per member'], ['conn', 'connection threads', 'one per connection'], ['jflush', 'journal flusher', 'about every 100 ms'], ['ckpt', 'checkpoint', 'every 60 seconds'], ['evict', 'eviction', 'keeps the cache in bounds'], ['repl', 'replication', 'serves the oplog']],
    mem: [['cache', 'WiredTiger cache', 'uncompressed pages, ~50% of RAM', 3, { full: 1 }], ['logbuf', 'journal buffer', 'log records', 1], ['oscache', 'OS file cache', 'compressed blocks', 1]],
    disk: [['coll', 'collection-*.wt', 'documents, compressed', 1.5, { full: 1 }], ['idx', 'index-*.wt', 'one file per index', 1.2], ['journal', 'journal/', 'WiredTigerLog files', 1.2], ['oplog', 'local.oplog.rs', 'the oplog, a capped collection', 1.3]],
    widgets: { th: ['spawn', 'conn', 3, 'c'], pages: ['slots', 'cache', 8, ['clean', 'clean', 'clean', 'clean', 'clean', 'clean', 'empty', 'empty']], rec: ['bar', 'logbuf'], jseg: ['segs', 'journal', 4, 2], op: ['segs', 'oplog', 5, 4], ck: ['mark', 'coll', '⚑ checkpoint'], sr: ['rep', 'sec', ['oplog fetcher', 'oplog (its copy)', 'applier'], ['clean', 'clean', 'clean', 'clean']] },
    rep: { box: 'sec', name: 'Secondaries', promotedName: 'New primary', primary: 'primary', unit: 'write', label: 'Write concern', modes: ['w: 1', 'w: "majority"'], def: 1, lostText: 'the last write is rolled back', keptText: 'every acknowledged write is here' },
    scenes: [
      { layers: ['proc'], hl: ['client', 'mongod', 'conn'], t: 'The driver opens a pool of connections',
        s: 'Drivers keep a pool, 100 connections per host by default. mongod gives each connection a thread.',
        d: 'Each connection costs about 1 MB on the server. A thousand application instances with default pools can open far more connections than the work needs.',
        moves: [['q', 'client', 'mongod', 0, 'connect'], ['q', 'mongod', 'conn', 0.5, 'thread']], fx: function (S) { S.th = 3; } },
      { layers: ['proc', 'mem'], hl: ['conn', 'cache'], t: 'find() is served from the WiredTiger cache',
        s: 'The document\'s page is already in the WiredTiger cache, uncompressed. The answer comes straight from memory.',
        d: 'The working set, the documents and index pages you touch often, should fit in this cache. When it does not, reads go to disk and decompression.',
        moves: [['q', 'client', 'conn', 0, 'find()'], ['q', 'conn', 'pages:2', 0.45, 'find'], ['r', 'pages:2', 'client', 0.75, 'document']], fx: function (S) { S.hit.pages = 2; } },
      { layers: ['mem', 'disk'], hl: ['cache', 'oscache', 'coll'], t: 'Not cached: read, then decompress',
        s: 'The page is read from collection-*.wt as a compressed block, usually through the OS file cache, then decompressed into the WiredTiger cache.',
        d: 'Two caches hold the same data in two forms: compressed in the OS cache, uncompressed in WiredTiger\'s. That is why the WiredTiger cache defaults to about half of memory.',
        moves: [['q', 'conn', 'cache', 0, 'miss'], ['p', 'coll', 'oscache', 0.25, 'compressed'], ['p', 'oscache', 'pages:6', 0.55, 'decompress']], fx: function (S) { S.pages[6] = 'clean'; } },
      { layers: ['mem'], hl: ['conn', 'cache', 'logbuf'], t: 'insertOne: document, index and oplog in one transaction',
        s: 'The document goes into a collection page, its keys into the index pages, and an oplog entry is written, all together. A journal record goes into the journal buffer.',
        d: 'Because the oplog entry is written in the same transaction as the change, the two can never disagree after a crash.',
        moves: [['q', 'client', 'conn', 0, 'insertOne'], ['q', 'conn', 'pages:2', 0.35, 'document'], ['w', 'conn', 'logbuf', 0.55, 'journal record']], fx: function (S) { S.pages[2] = 'dirty'; S.pages[3] = 'dirty'; S.rec = 1; } },
      { layers: ["proc", "disk"], hl: ["jflush", "journal", "conn", "client"], t: "w: 1: the primary alone acknowledges",
        s: "With write concern w: 1, the app hears back as soon as the primary has the write. The secondaries have not copied it yet: they are one write behind.",
        d: "Since MongoDB 5.0 the default write concern is majority. w: 1 is faster and can lose acknowledged writes in a failover.",
        moves: [["w", "logbuf", "journal", 0, "flush"], ["a", "conn", "client", 0.45, "✓ w: 1"]], fx: function (S) { S.rec = 0; S.jseg = 3; S.op = 5; S.fsync = 'journal'; S.lag = S.sync ? 0 : 1; },
        lines: ["The journal record is flushed to disk", "The primary has it: the app hears back"],
        alt: { t: "w: \"majority\": journal on disk, a majority has it", s: "The journal is flushed, and a secondary pulls the new oplog entry and writes it to its own oplog. With a majority of members holding the write, the app hears back.", d: "A write a majority holds survives a failover. Since 8.0 the acknowledgement comes once a majority has written the oplog entry, so a read on a secondary just after may not see it yet.", moves: [["w", "logbuf", "journal", 0, "flush"], ["w", "oplog", "repl", 0.2, "oplog entry"], ["w", "repl", "rep:0", 0.4, "oplog"], ["w", "rep:0", "rep:1", 0.55, "write"], ["a", "rep:0", "conn", 0.7, "✓ have it"], ["a", "conn", "client", 0.85, "✓ majority"]], lines: ["The journal record is flushed to disk", "The new oplog entry is ready", "A secondary's fetcher pulls it", "and writes it to its own oplog", "The secondary reports back", "A majority has it: the app hears back"], fx: function (S) { S.rec = 0; S.jseg = 3; S.op = 5; S.fsync = 'journal'; S.lag = 0; } } },
      { layers: ['proc', 'disk'], hl: ['ckpt', 'cache', 'coll', 'idx'], t: 'Every 60 seconds, a checkpoint',
        s: 'WiredTiger writes the dirty pages to the .wt files as a new, consistent checkpoint. After that, the journal written before it is no longer needed for recovery.',
        d: 'A crash restarts from the last checkpoint and replays the journal after it, so recovery replays at most about a minute of writes.',
        moves: [['p', 'pages:2', 'coll', 0.1, 'dirty page'], ['p', 'pages:3', 'idx', 0.35, 'index page']], fx: function (S) { S.pages[2] = 'clean'; S.pages[3] = 'clean'; S.ck = 1; S.jseg = 1; } },
      { layers: ['proc', 'mem'], hl: ['evict', 'cache'], t: 'When the cache fills, eviction makes room',
        s: 'At about 80% full, eviction threads remove pages that have not been used lately. Clean pages are dropped; dirty ones are written first.',
        d: 'If eviction cannot keep up, application threads are made to evict pages themselves, and every request slows down. Too much dirty data in the cache is the usual cause.',
        moves: [['v', 'evict', 'pages:0', 0, 'evict'], ['v', 'evict', 'pages:1', 0.3, 'evict']], fx: function (S) { S.pages[0] = 'empty'; S.pages[1] = 'empty'; } },
      { layers: ["proc", "disk"], hl: ["oplog", "repl", "sec"], t: "The secondaries pull the oplog and apply it",
        s: "Each secondary's fetcher pulls new oplog entries, writes them to its own oplog, and the applier applies them to its copy of the data. Now it is in step.",
        d: "The oplog is capped: a secondary that falls further behind than the window (size divided by write rate) cannot catch up and needs a full resync. rs.printReplicationInfo() shows the window.",
        moves: [["w", "oplog", "repl", 0, "oplog"], ["w", "repl", "rep:0", 0.2, "oplog entry"], ["w", "rep:0", "rep:1", 0.4, "write"], ["w", "rep:1", "rep:2", 0.6, "apply"], ["p", "rep:2", "rpages:2", 0.8, "document"]], fx: function (S) { S.lag = 0; S.rpages[2] = 'dirty'; },
        lines: ["The primary's oplog has a new entry", "A secondary's fetcher pulls it", "and writes it to its own oplog", "The applier applies it", "and the secondary's document changes"],
        alt: { t: "The secondaries apply what they already have", s: "With w: \"majority\" the entry reached a secondary's oplog during the write. The applier still applies it on its own schedule.", d: "The oplog is capped: a secondary that falls further behind than the window cannot catch up and needs a full resync.", moves: [["w", "rep:1", "rep:2", 0, "apply"], ["p", "rep:2", "rpages:2", 0.4, "document"]], lines: ["The applier applies the oplog entry", "and the secondary's document changes"], fx: function (S) { S.lag = 0; S.rpages[2] = 'dirty'; } } },
      { layers: ["proc", "mem", "disk"], hl: ["client", "sec"], t: "The primary fails: a w: 1 write is rolled back",
        s: "One more insert with w: 1 is acknowledged, and the primary crashes before any secondary copies it. The secondaries elect a new primary within seconds. When the old primary rejoins, that write is rolled back and saved to a rollback file.",
        d: "Elections are automatic in a replica set. Writes with w: \"majority\" are never rolled back.",
        moves: [["q", "client", "conn", 0, "insertOne"], ["a", "conn", "client", 0.25, "✓ w: 1"], ["x", "mongod", "mongod", 0.5, "crash"], ["q", "client", "sec", 0.75, "reconnect"]], fx: function (S) { S.down = 1; S.promoted = 1; S.lost = S.sync ? 2 : 1; S.lag = 0; },
        lines: ["One more insert, with w: 1", "The app hears back", "The primary crashes before a secondary copies it", "A new primary is elected, without that write"],
        alt: { t: "The primary fails: majority writes survive", s: "The last insert was in a majority's oplog before the app heard back. The secondaries elect a new primary that has it, so nothing acknowledged is lost.", d: "Elections usually take seconds. Drivers retry writes once by default (retryWrites), so many apps see only a short pause.", moves: [["q", "client", "conn", 0, "insertOne"], ["w", "repl", "rep:0", 0.2, "oplog"], ["a", "rep:0", "conn", 0.4, "✓ have it"], ["a", "conn", "client", 0.6, "✓ majority"], ["x", "mongod", "mongod", 0.75, "crash"], ["q", "client", "sec", 0.9, "reconnect"]], lines: ["One more insert, with w: \"majority\"", "A secondary copies it to its oplog", "and reports back", "A majority has it: the app hears back", "The primary crashes", "A new primary is elected, with the write"], fx: function (S) { S.down = 1; S.promoted = 1; S.lost = 2; S.lag = 0; } } }
    ]
  };

  ENG.rd = {
    name: 'Redis', intro: ['One thread, everything in memory, disk on the side', 'Press play to watch commands take turns on the main thread, a write reach the AOF, a replica fall behind and a snapshot fork. Disk is only for getting the data back after a restart.'],
    left: ['client', 'Clients', 'many connections'], right: [['replica', 'Replica', 'asynchronous copy']],
    proc: [['main', 'main thread', 'runs every command, in order', 2], ['io', 'I/O threads', 'read and write sockets'], ['bio', 'background threads', 'fsync, lazy free'], ['child', 'forked child', 'snapshots, AOF rewrite']],
    mem: [['keys', 'keyspace', 'every key and value', 3, { full: 1 }], ['aofbuf', 'AOF buffer', 'commands to append', 1], ['backlog', 'replication backlog', 'recent writes', 1]],
    disk: [['aof', 'appendonlydir/', 'the append-only file', 1.4], ['rdb', 'dump.rdb', 'point-in-time snapshot', 1]],
    widgets: { q: ['spawn', 'main', 3, 'cmd'], pages: ['slots', 'keys', 8, ['clean', 'clean', 'clean', 'clean', 'clean', 'clean', 'empty', 'empty']], rec: ['bar', 'aofbuf'], bl: ['bar', 'backlog'], aseg: ['segs', 'aof', 5, 3], kid: ['spawn', 'child', 1, 'pid'], snap: ['mark', 'rdb', '✓ written'], sr: ['rep', 'replica', ['replication link', 'applies commands'], ['clean', 'clean', 'clean', 'clean']] },
    rep: { box: 'replica', name: 'Replica', promotedName: 'New primary', primary: 'primary', unit: 'write', label: 'After a write', modes: ['just SET', 'SET + WAIT'], def: 0, lostText: 'the last OK write is lost', keptText: 'every confirmed write is here' },
    scenes: [
      { layers: ['proc'], hl: ['client', 'io', 'main'], t: 'Every command takes its turn on one thread',
        s: 'Commands from all clients line up for the main thread, which runs them one at a time. No locks are needed, and every single command is atomic.',
        d: 'I/O threads can read requests and write replies in parallel since Redis 6, but the commands themselves still run one after another.',
        moves: [['q', 'client', 'io', 0, 'GET'], ['q', 'client', 'io', 0.15, 'INCR'], ['q', 'io', 'main', 0.4, 'queue']], fx: function (S) { S.q = 3; } },
      { layers: ['proc', 'mem'], hl: ['main', 'keys'], t: 'GET is answered from memory',
        s: 'The key is found in the keyspace, a hash table in memory, and the reply goes straight back. Nothing touches disk.',
        d: 'At about a tenth of a millisecond per command on one machine, the network round trip usually costs more than the command. Notebook 7 measures it.',
        moves: [['q', 'main', 'pages:2', 0, 'lookup'], ['r', 'pages:2', 'client', 0.4, 'value']], fx: function (S) { S.q = 2; S.hit.pages = 2; } },
      { layers: ['mem'], hl: ['main', 'keys', 'aofbuf'], t: 'SET changes memory, and the command is queued for the AOF',
        s: 'The value is changed in memory, and the command itself is appended to the AOF buffer and the replication backlog.',
        d: 'The AOF records commands, not pages. That is why it can be rewritten in the background into a shorter file with the same result.',
        moves: [['q', 'main', 'pages:3', 0, 'SET'], ['w', 'main', 'aofbuf', 0.35, 'SET cart:42'], ['w', 'main', 'backlog', 0.5, 'SET cart:42']], fx: function (S) { S.q = 1; S.pages[3] = 'dirty'; S.rec = 1; S.bl = 1; } },
      { layers: ["mem", "disk"], hl: ["aofbuf", "aof", "main"], t: "Written to the AOF file, then the reply",
        s: "Before replying, Redis writes the AOF buffer to the file, so a killed process loses nothing. Then the client gets OK. The replica has not received the write yet.",
        d: "Notebook 9 killed Redis with kill -9 mid-write: with the AOF on, 0 of 40,200 acknowledged writes were lost.",
        moves: [["w", "aofbuf", "aof", 0, "write()"], ["a", "main", "client", 0.5, "OK"]], fx: function (S) { S.rec = 0; S.aseg = 4; S.pages[3] = 'clean'; S.lag = S.sync ? 0 : 1; },
        lines: ["The AOF buffer is written to the file", "Then the client gets OK"],
        alt: { t: "OK, then WAIT until a replica confirms", s: "After OK the client sends WAIT 1 500: Redis returns when at least one replica has acknowledged the write, or after 500 ms. The answer is how many replicas confirmed.", d: "WAIT tells the client which writes no replica confirmed, so it can retry or report them. It does not make Redis a consensus system: a confirmed replica may not be the one promoted.", moves: [["w", "aofbuf", "aof", 0, "write()"], ["a", "main", "client", 0.2, "OK"], ["q", "client", "main", 0.4, "WAIT 1 500"], ["w", "backlog", "rep:0", 0.55, "SET cart:42"], ["a", "rep:0", "main", 0.7, "ack"], ["a", "main", "client", 0.85, "1 replica"]], lines: ["The AOF buffer is written to the file", "The client gets OK", "The client sends WAIT 1 500", "The write goes to the replica", "The replica acknowledges", "WAIT returns: 1 replica has it"], fx: function (S) { S.rec = 0; S.bl = 0; S.aseg = 4; S.pages[3] = 'clean'; S.lag = 0; } } },
      { layers: ['proc', 'disk'], hl: ['bio', 'aof'], t: 'Once a second, a background thread fsyncs',
        s: 'With appendfsync everysec, a background thread forces the file to disk about once a second. A power cut can lose that last second; a crashed process cannot.',
        d: 'appendfsync always fsyncs every write and is much slower. With the AOF off, only snapshots are kept: Notebook 9 lost all 42,269 writes made since the last one.',
        moves: [['c', 'bio', 'aof', 0.1, 'fsync']], fx: function (S) { S.fsync = 'aof'; } },
      { layers: ["mem"], hl: ["backlog", "replica"], t: "The replica gets the write afterwards",
        s: "The primary sends the command from the backlog after it has already replied OK. The replica applies it, and now it is in step. If the primary had died first, the replica would never have had it.",
        d: "Notebook 9 killed a primary while its replica was a second behind: 2,217 acknowledged writes were missing after the promotion.",
        moves: [["w", "backlog", "rep:0", 0, "SET cart:42"], ["w", "rep:0", "rep:1", 0.3, "apply"], ["p", "rep:1", "rpages:3", 0.6, "value"]], fx: function (S) { S.bl = 0; S.lag = 0; S.rpages[3] = 'dirty'; },
        lines: ["The primary sends the write from its backlog", "The replica runs the same command", "and its copy of the value changes"],
        alt: { t: "The replica already has the write", s: "With WAIT the replica received and applied the write during the wait. Nothing is left to send.", d: "WAIT costs a round trip to the replica on every write that uses it: 0.30 ms instead of 0.13 ms per write in Notebook 9.", moves: [["p", "rep:1", "rpages:3", 0, "value"]], lines: ["The replica's copy already has the new value"], fx: function (S) { S.bl = 0; S.lag = 0; S.rpages[3] = 'dirty'; } } },
      { layers: ['proc', 'mem', 'disk'], hl: ['child', 'keys', 'rdb'], t: 'A snapshot: fork, and let the child write',
        s: 'For BGSAVE, Redis forks. The child writes everything it sees to dump.rdb while the parent keeps serving. Pages the parent changes meanwhile are copied, so memory use grows.',
        d: 'On a busy 40 GB instance the fork itself can pause the server, and copy-on-write can add many GB. Leave memory headroom, or take snapshots on a replica.',
        moves: [['q', 'main', 'child', 0, 'fork()'], ['p', 'keys', 'rdb', 0.4, 'snapshot']], fx: function (S) { S.kid = 1; S.snap = 1; S.pages[6] = 'dirty'; } },
      { layers: ['proc'], hl: ['main', 'client'], t: 'One slow command makes everyone wait',
        s: 'KEYS * or deleting a huge key runs on the same single thread. Until it finishes, every other client\'s command waits in line.',
        d: 'Use SCAN instead of KEYS, UNLINK instead of DEL for big keys, and SLOWLOG GET to find what is blocking.',
        moves: [['q', 'client', 'main', 0, 'KEYS *'], ['q', 'client', 'io', 0.3, 'GET'], ['q', 'client', 'io', 0.45, 'GET']], fx: function (S) { S.kid = 0; S.q = 3; S.slow = 1; } },
      { layers: ["proc", "mem", "disk"], hl: ["client", "replica"], t: "The primary fails: an OK write can be gone",
        s: "Another SET gets OK, and the primary dies before sending it. Sentinel or the cluster promotes the replica, and the client reconnects. That write was acknowledged and is not there.",
        d: "Notebook 9: with the replica one second behind, 2,217 of 29,981 acknowledged writes were missing after the promotion.",
        moves: [["q", "client", "main", 0, "SET"], ["a", "main", "client", 0.25, "OK"], ["x", "main", "main", 0.5, "crash"], ["q", "client", "replica", 0.75, "reconnect"]], fx: function (S) { S.down = 1; S.promoted = 1; S.lost = S.sync ? 2 : 1; S.lag = 0; },
        lines: ["Another SET arrives", "The client gets OK", "The primary dies before sending it", "The replica is promoted, without that write"],
        alt: { t: "The primary fails: the client knew what was confirmed", s: "Every write the client waited for was confirmed by the replica, and the promoted replica has it. A write WAIT reported as unconfirmed is the one to retry.", d: "In Notebook 9, with WAIT, no confirmed write was lost, and the client knew about the one write no replica had confirmed.", moves: [["q", "client", "main", 0, "SET"], ["a", "main", "client", 0.2, "OK"], ["q", "client", "main", 0.35, "WAIT 1 500"], ["w", "backlog", "rep:0", 0.5, "SET"], ["a", "main", "client", 0.65, "1 replica"], ["x", "main", "main", 0.8, "crash"], ["q", "client", "replica", 0.92, "reconnect"]], lines: ["Another SET arrives", "The client gets OK", "and waits for a replica", "The write reaches the replica", "WAIT returns: confirmed", "The primary dies", "The replica is promoted, with the write"], fx: function (S) { S.down = 1; S.promoted = 1; S.lost = 2; S.lag = 0; } } }
    ]
  };

  ENG.cs = {
    name: 'Cassandra', intro: ['Every node the same: memtable, commit log, SSTables', 'Press play to follow one write at QUORUM through a three-node ring, then a flush, a read, a delete, compaction and a node that was down. The detail shown is node 1; nodes 2 and 3 do the same.'],
    left: ['client', 'Your app', 'driver'], right: [['n2', 'Node 2', 'replica'], ['n3', 'Node 3', 'replica']],
    proc: [['transport', 'native transport', 'CQL, port 9042'], ['coord', 'coordinator', 'hashes the partition key'], ['flusher', 'memtable flush', 'memory to SSTable'], ['compact', 'compaction', 'merges SSTables'], ['hinter', 'hinted handoff', 'replays missed writes'], ['gossip', 'gossip', 'who is up']],
    mem: [['memtable', 'memtable', 'recent writes, sorted', 2.2, { full: 1 }], ['bloom', 'bloom filters', 'one per SSTable', 1.4], ['kcache', 'key cache', 'where keys are', 1]],
    disk: [['commitlog', 'commitlog/', 'every write, appended', 1.2], ['sst', 'SSTables', 'immutable sorted files', 2, { full: 1 }], ['hints', 'hints/', 'writes for nodes that were down', 1.1]],
    widgets: { rows: ['slots', 'memtable', 6, ['row', 'row', 'empty', 'empty', 'empty', 'empty']], bf: ['slots', 'bloom', 3, ['bloom', 'bloom', 'empty']], cl: ['segs', 'commitlog', 4, 2], ss: ['slots', 'sst', 4, ['file', 'file', 'empty', 'empty']], hn: ['segs', 'hints', 3, 0, 'dead'], r2: ['segs', 'n2', 4, 2, 'rep'], r3: ['segs', 'n3', 4, 2, 'rep'] },
    scenes: [
      { layers: ['proc'], hl: ['client', 'transport', 'coord'], t: 'Any node can take the write',
        s: 'The client sends INSERT at QUORUM to any node, which becomes the coordinator. It hashes the partition key to a token, and the token decides the three replicas.',
        d: 'There is no primary. Drivers usually send each request straight to a replica that owns the token, so the coordinator is also one of the replicas.',
        moves: [['q', 'client', 'transport', 0, 'INSERT'], ['q', 'transport', 'coord', 0.4, 'hash(key)']], fx: function () {} },
      { layers: ['mem', 'disk'], hl: ['coord', 'commitlog', 'memtable', 'n2', 'n3'], t: 'Each replica: commit log, then memtable',
        s: 'The coordinator sends the write to all three replicas. Each appends it to its commit log and adds it to its memtable in memory. Nothing is updated in place.',
        d: 'commitlog_sync is periodic by default, every 10 seconds, so a node relies on the other replicas for the last few seconds if its power fails.',
        moves: [['w', 'coord', 'commitlog', 0, 'append'], ['q', 'coord', 'rows:2', 0.25, 'row'], ['w', 'coord', 'n2', 0.15, 'write'], ['w', 'coord', 'n3', 0.3, 'write']], fx: function (S) { S.cl = 3; S.rows[2] = 'row'; S.r2 = 3; S.r3 = 3; } },
      { layers: ['proc'], hl: ['n2', 'coord', 'client'], t: 'QUORUM: two of three answer, the client hears back',
        s: 'Node 1 and node 2 acknowledge first. Two of three is a quorum, so the coordinator replies without waiting for node 3.',
        d: 'Write at QUORUM and read at QUORUM, and a read always overlaps a node that has the latest write: 2 + 2 is more than 3.',
        moves: [['a', 'n2', 'coord', 0, 'ack'], ['a', 'coord', 'client', 0.45, '✓ QUORUM']], fx: function () {} },
      { layers: ['proc', 'mem', 'disk'], hl: ['flusher', 'memtable', 'sst', 'commitlog'], t: 'A full memtable becomes a new SSTable',
        s: 'When the memtable is big enough, it is written to disk as a new, immutable SSTable, with its own bloom filter. The commit log segments it covered can be recycled.',
        d: 'SSTables are never changed after they are written. Updates and deletes are new entries in newer SSTables; reads merge them by timestamp.',
        moves: [['p', 'memtable', 'sst', 0, 'flush']], fx: function (S) { S.rows = ['empty', 'empty', 'empty', 'empty', 'empty', 'empty']; S.ss[2] = 'file'; S.bf[2] = 'bloom'; S.cl = 1; } },
      { layers: ['mem', 'disk'], hl: ['coord', 'memtable', 'bloom', 'sst'], t: 'A read checks memory, then only the SSTables that may have the key',
        s: 'The node looks in the memtable, then asks each SSTable\'s bloom filter. Filters say "definitely not here" for most files; only the rest are read, and the newest version wins.',
        d: 'More SSTables per read means slower reads. nodetool tablehistograms shows how many each read touches; compaction keeps the number down.',
        moves: [['q', 'coord', 'bloom', 0, 'key?'], ['r', 'ss:0', 'coord', 0.4, 'v1'], ['r', 'ss:2', 'coord', 0.55, 'v2 newer']], fx: function (S) { S.hit.ss = 2; } },
      { layers: ['mem'], hl: ['memtable'], t: 'A delete is a write: a tombstone',
        s: 'DELETE writes a tombstone, a marker that says the data is gone. The old data stays in its SSTable until compaction removes both, after gc_grace_seconds.',
        d: 'Reads must scan past tombstones. Discord had a channel that took 20 seconds to load: one live message behind millions of tombstones.',
        moves: [['q', 'client', 'rows:0', 0, 'DELETE']], fx: function (S) { S.rows[0] = 'row'; S.dead.rows = 0; } },
      { layers: ['proc', 'disk'], hl: ['compact', 'sst'], t: 'Compaction merges SSTables',
        s: 'In the background, compaction reads several SSTables and writes one new file with only the newest version of each row, dropping old tombstones and the data they covered.',
        d: 'Compaction needs spare disk and I/O. When it falls behind, reads slow down; nodetool compactionstats shows pending work.',
        moves: [['p', 'ss:0', 'ss:1', 0, 'merge'], ['p', 'ss:2', 'ss:1', 0.2, 'merge']], fx: function (S) { S.ss = ['empty', 'file', 'empty', 'empty']; S.bf = ['empty', 'bloom', 'empty']; } },
      { layers: ['proc', 'disk'], hl: ['n3', 'hinter', 'hints'], t: 'A node was down: hints catch it up',
        s: 'Writes for node 3 while it was down are kept as hints on the coordinator, for up to three hours by default. When node 3 is back, hinted handoff replays them.',
        d: 'Down longer than max_hint_window, and only a repair brings it back in line. Notebook 9 stopped a node and found all 1,500 missed writes on it after hints replayed.',
        moves: [['d', 'coord', 'hints', 0, 'hint'], ['w', 'hints', 'n3', 0.45, 'replay']], fx: function (S) { S.hn = 0; S.r3 = 4; } }
    ]
  };

  ENG.vx = {
    name: 'pgvector', intro: ['Vector search inside PostgreSQL', 'Press play to follow one question: the embedding, the HNSW graph search, the rows coming back, and the two things that go wrong most often, filters and memory.'],
    left: ['client', 'Your app', 'question in text'], right: [['model', 'Embedding model', 'text to 384 numbers']],
    proc: [['backend', 'backend', 'runs the query', 1.4], ['planner', 'planner', 'chooses the HNSW index', 1.4], ['vac', 'vacuum', 'cleans deleted vectors', 1.2]],
    mem: [['graph', 'HNSW graph', 'index pages in shared_buffers', 2.4, { full: 1 }], ['cands', 'candidate list', 'hnsw.ef_search = 40', 1.4]],
    disk: [['heap', 'table file', 'rows with their vectors', 1.4], ['index', 'HNSW index file', 'about 2 KB per vector', 1.4], ['wal', 'pg_wal/', 'every insert is logged', 1]],
    widgets: { hnsw: ['graph', 'graph'], cl: ['spawn', 'cands', 4, 'c'], seg: ['segs', 'wal', 4, 2] },
    scenes: [
      { layers: [], hl: ['client', 'model'], t: 'The question becomes a vector',
        s: 'The app sends the question to an embedding model and gets back a list of numbers. Similar meanings end up close together.',
        d: 'The same model must embed the stored documents and the questions. A new model means re-embedding everything.',
        moves: [['q', 'client', 'model', 0, 'text'], ['r', 'model', 'client', 0.45, '[0.12, -0.4, …]']], fx: function () {} },
      { layers: ['proc'], hl: ['client', 'backend', 'planner'], t: 'ORDER BY distance, LIMIT 10',
        s: 'The query asks for the 10 rows nearest to the vector. The planner picks the HNSW index instead of comparing the vector with every row.',
        d: 'An exact search reads every row: 21.7 ms for 100,000 rows in Notebook 8. The index answered in under a millisecond.',
        moves: [['q', 'client', 'backend', 0, 'ORDER BY <=> LIMIT 10'], ['q', 'backend', 'planner', 0.45, 'plan']], fx: function () {} },
      { layers: ['mem'], hl: ['graph', 'backend'], t: 'Enter at the top layer',
        s: 'HNSW is a graph in layers. The search starts at one entry point on the sparse top layer and hops to whichever neighbour is closest to the question.',
        d: 'Each upper layer is a shortcut through the one below, like express stops on a train line.',
        moves: [['q', 'backend', 'graph', 0, 'enter']], fx: function (S) { S.hnsw = 1; } },
      { layers: ['mem'], hl: ['graph', 'cands'], t: 'Down the layers, keeping the best candidates',
        s: 'On each lower layer the search widens. It keeps a list of the best candidates found so far, ef_search of them, and stops when no neighbour is closer.',
        d: 'A bigger ef_search finds more of the true nearest neighbours and takes longer: recall 0.80 at 10, 0.95 at 40, 1.00 at 160 in Notebook 8.',
        moves: [['q', 'graph', 'cands', 0.1, 'candidates']], fx: function (S) { S.hnsw = 3; S.cl = 4; } },
      { layers: ['mem', 'disk'], hl: ['cands', 'heap', 'client'], t: 'The top 10 rows go back',
        s: 'The closest candidates point at rows in the table. Those rows are fetched and returned, nearest first. It is approximate: a true neighbour can be missed.',
        d: 'Measure recall on your own data: compute exact answers for a sample of questions once, then compare after every change.',
        moves: [['p', 'heap', 'cands', 0, 'rows'], ['r', 'cands', 'client', 0.45, '10 rows']], fx: function () {} },
      { layers: ['mem'], hl: ['cands', 'client'], t: 'Filter after the index, and rows go missing',
        s: 'Add WHERE tenant_id = 7 and the filter runs after the index has picked its 40 candidates. Most belong to other tenants, so fewer than 10 rows come back.',
        d: 'Notebook 8 got 1.3 rows out of 10. Iterative scan (pgvector 0.8 and later) keeps searching until enough rows pass; for small tenants an exact search inside the tenant is exact and fast.',
        moves: [['r', 'cands', 'client', 0.2, '1 row']], fx: function (S) { S.dead.cl = 1; } },
      { layers: ['mem', 'disk'], hl: ['backend', 'graph', 'wal'], t: 'An insert adds a node and its links',
        s: 'A new vector is added to the graph: linked to its nearest neighbours on each layer it reaches. The change is logged in the WAL like any other write.',
        d: 'Building the graph is the expensive part. Bulk loads are faster with the index built afterwards and maintenance_work_mem large enough to hold it.',
        moves: [['q', 'client', 'backend', 0, 'INSERT'], ['q', 'backend', 'graph', 0.3, 'link'], ['w', 'backend', 'wal', 0.55, 'WAL']], fx: function (S) { S.dead.cl = -1; S.cl = 0; S.hnsw = 4; S.seg = 3; } },
      { layers: ['mem', 'disk'], hl: ['graph', 'index'], t: 'When the index outgrows memory',
        s: 'Every hop in the graph needs its page. If the index no longer fits in memory, hops become disk reads and search goes from about a millisecond to many.',
        d: 'An index of 20 million 1,536-dimension vectors needs about 133 GB. halfvec halves it; the vector page has a calculator.',
        moves: [['p', 'index', 'graph', 0, 'page'], ['p', 'index', 'graph', 0.25, 'page'], ['p', 'index', 'graph', 0.5, 'page']], fx: function (S) { S.hnsw = 5; } }
    ]
  };

  /* What each moving piece is doing, in order of when it moves. */
  var NARR = {
 "pg": [
  [
   "Your app asks the postmaster for a connection",
   "The postmaster starts a backend process for it"
  ],
  [
   "The query goes to its backend",
   "The backend finds the page in shared_buffers",
   "Rows go straight back to the app"
  ],
  [
   "This page is not in shared_buffers",
   "8 KB is read from base/ into a free slot"
  ],
  [
   "An UPDATE arrives at the backend",
   "First, a WAL record goes into the WAL buffers",
   "Then the page changes in memory: now dirty"
  ],
  [
   "COMMIT: the WAL record is flushed to pg_wal/",
   "The commit is recorded in pg_xact/",
   "Only now does the app hear back"
  ],
  [
   "The checkpointer writes the dirty page to base/",
   "A checkpoint is marked in the WAL"
  ],
  [
   "Autovacuum clears the dead row version"
  ],
  [
   "The WAL sender reads the new WAL",
   "and streams it to the standby, which replays it"
  ]
 ],
 "my": [
  [
   "Your app connects to mysqld",
   "mysqld gives the connection its own thread"
  ],
  [
   "The query goes to its thread",
   "The leaf page is already in the buffer pool",
   "The row goes back to the app"
  ],
  [
   "This page is not in the buffer pool",
   "16 KB is read from users.ibd"
  ],
  [
   "An UPDATE arrives",
   "The old version is copied to undo",
   "A redo record goes into the log buffer",
   "The binlog event waits in the session's cache"
  ],
  [
   "Redo is flushed with the transaction prepared",
   "The binlog is written and flushed",
   "Redo marks the transaction committed",
   "Only now does the app hear back"
  ],
  [
   "The page cleaner writes the dirty page to users.ibd"
  ],
  [
   "Purge removes the old version from undo"
  ],
  [
   "The binlog dump thread reads the new events",
   "and sends them to the replica"
  ]
 ],
 "mo": [
  [
   "The driver opens a connection to mongod",
   "mongod gives it a thread"
  ],
  [
   "find() goes to its connection thread",
   "The page is in the WiredTiger cache",
   "The document goes back to the app"
  ],
  [
   "This page is not in the WiredTiger cache",
   "A compressed block is read from the .wt file",
   "It is decompressed into the cache"
  ],
  [
   "insertOne arrives",
   "The document goes into a collection page",
   "A journal record goes into the journal buffer"
  ],
  [
   "The journal is flushed to disk",
   "The new oplog entry is ready for the secondaries",
   "The secondaries copy it and apply it",
   "A majority has it: the app hears back"
  ],
  [
   "The checkpoint writes the dirty collection page",
   "and the dirty index page"
  ],
  [
   "Eviction drops a page no one has used lately",
   "and another, to keep the cache under 80%"
  ],
  [
   "The oldest oplog entries drop off the end"
  ]
 ],
 "rd": [
  [
   "A client sends GET",
   "Another client sends INCR",
   "They wait in line for the main thread"
  ],
  [
   "The main thread looks up the key in memory",
   "The value goes straight back"
  ],
  [
   "SET changes the value in memory",
   "The command is added to the AOF buffer",
   "and to the replication backlog"
  ],
  [
   "The AOF buffer is written to the file",
   "Then the client gets OK"
  ],
  [
   "A background thread fsyncs the file to disk"
  ],
  [
   "The replica gets the write, after the OK"
  ],
  [
   "Redis forks a child process",
   "The child writes a snapshot to dump.rdb"
  ],
  [
   "KEYS * starts on the main thread",
   "Another GET has to wait",
   "and another"
  ]
 ],
 "cs": [
  [
   "The app sends INSERT to any node",
   "The coordinator hashes the key to find the replicas"
  ],
  [
   "Node 1 appends the write to its commit log",
   "The write goes to node 2",
   "Node 1 adds the row to its memtable",
   "and the write goes to node 3"
  ],
  [
   "Node 2 acknowledges",
   "Two of three: the app hears back"
  ],
  [
   "The full memtable is written as a new SSTable"
  ],
  [
   "Bloom filters say which SSTables may have the key",
   "An older version comes from one SSTable",
   "A newer one from another: the newest wins"
  ],
  [
   "DELETE writes a tombstone"
  ],
  [
   "Compaction merges one SSTable",
   "and another, into a single new file"
  ],
  [
   "Node 3 was down: the write is kept as a hint",
   "Node 3 is back: the hint is replayed"
  ]
 ],
 "vx": [
  [
   "The question goes to the embedding model",
   "A vector comes back"
  ],
  [
   "The query asks for the 10 nearest rows",
   "The planner picks the HNSW index"
  ],
  [
   "The search enters at the top of the graph"
  ],
  [
   "It goes down the layers, keeping the best candidates"
  ],
  [
   "The candidates' rows are read from the table",
   "The 10 nearest go back to the app"
  ],
  [
   "A tenant filter after the index leaves 1 row"
  ],
  [
   "A new vector arrives",
   "It is linked to its neighbours in the graph",
   "and the change is logged in the WAL"
  ],
  [
   "Each hop needs a page read from disk",
   "and another",
   "and another"
  ]
 ]
};

  /* ---------- layout ---------- */
  var H = { proc: 90, mem: 108, disk: 84 };
  function layout(E, lay) {
    var G = { bands: {} };
    function pack(list, x0, w, y) {
      var tot = list.reduce(function (a, b) { return a + (b[3] || 1); }, 0), gap = 8, x = x0, avail = w - gap * (list.length - 1);
      list.forEach(function (b) { var bw = avail * (b[3] || 1) / tot; G[b[0]] = [x, y, bw, 0]; x += bw + gap; });
    }
    if (lay === 'wide') {
      G.W = 1000;
      var hasR = E.right.length > 0, bx = 120, bwFull = 872, bwMem = hasR ? 700 : 872, y = 10;
      G.left = [8, 40, 102, 70]; G[E.left[0]] = G.left;
      ['proc', 'mem', 'disk'].forEach(function (k) {
        var bw = k === 'proc' ? bwFull : bwMem, h = H[k] + 48;
        G.bands[k] = [bx, y, bw, h];
        pack(E[k], bx + 14, bw - 28, y + 34);
        E[k].forEach(function (b) { G[b[0]][3] = H[k]; });
        y += h + 16;
      });
      G.H = y - 6;
      if (hasR) {
        var top = G.bands.mem[1], bottom = G.bands.disk[1] + G.bands.disk[3], n = E.right.length, rh = (bottom - top - 12 * (n - 1)) / n;
        E.right.forEach(function (b, i) { G[b[0]] = [834, top + i * (rh + 12), 158, rh]; });
      }
    } else {
      G.W = 440;
      var yy = 12;
      G[E.left[0]] = [8, yy, 200, 72]; yy += 72 + 18;
      ['proc', 'mem', 'disk'].forEach(function (k) {
        var cols = k === 'proc' ? 3 : 2, h = k === 'mem' ? 96 : k === 'proc' ? 88 : 76, rows = [], cur = [];
        E[k].forEach(function (b) { if (b[4] && b[4].full) { if (cur.length) rows.push(cur); rows.push([b]); cur = []; } else { cur.push(b); if (cur.length === cols) { rows.push(cur); cur = []; } } });
        if (cur.length) rows.push(cur);
        var y0 = yy;
        yy += 34;
        rows.forEach(function (r) {
          var full = r.length === 1 && r[0][4] && r[0][4].full, rh = full && k === 'mem' ? 120 : h;
          var gap = 8, bw = (424 - 24 - gap * (r.length - 1)) / r.length;
          r.forEach(function (b, i) { G[b[0]] = [20 + i * (bw + gap), yy, bw, rh]; });
          yy += rh + 10;
        });
        G.bands[k] = [8, y0, 424, yy - y0 + 4];
        yy += 22;
      });
      var others = E.right.filter(function (b) { return !(E.rep && b[0] === E.rep.box); });
      if (E.rep) { G[E.rep.box] = [8, yy, 424, 206]; yy += 218; }
      others.forEach(function (b, i) { G[b[0]] = [i % 2 ? 228 : 8, yy + Math.floor(i / 2) * 82, 204, 70]; });
      yy += Math.ceil(others.length / 2) * 82;
      G.H = yy + 4;
    }
    return G;
  }

  function el(n, a, p, t) { var e = document.createElementNS(NS, n); for (var k in a) e.setAttribute(k, a[k]); if (t != null) e.textContent = t; if (p) p.appendChild(e); return e; }
  var RX = /\b(shared_buffers|WAL buffers|buffer pool|WiredTiger cache|OS file cache|keyspace|memtable|in memory|memory|base\/|users\.ibd|collection-\*\.wt|\.wt files|dump\.rdb|SSTables?|table file|pg_xact\/|undo|disk)\b|\b(WAL records?|the WAL|WAL|pg_wal\/|redo log|redo|binlog|journal|oplog( entry)?|AOF( buffer| file)?|commit log|log)\b|\b(standby|replicas?|secondaries|secondary|node 2|node 3)\b/gi;
  function colorize(t) {
    var e = String(t).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
    return e.replace(RX, function (m, a, b, c) {
      return '<span class="' + (a ? (/disk|base|xact|table file|ibd|\.wt|rdb|SSTable|undo/i.test(m) ? 'w-disk' : 'w-mem') : b ? 'w-log' : 'w-rep') + '">' + m + '</span>';
    });
  }

  function mount(root) {
    var key = root.getAttribute('data-engine') || 'pg', E = ENG[key];
    if (!E) return;
    var st = { i: -1, playing: false, timer: null, lay: null, seen: false, raf: [], tt: [], speed: 1, sync: !!(E.rep && E.rep.def) }, G, svg, N;
    var ALL = [E.left].concat(E.proc, E.mem, E.disk, E.right), INFO = {};
    E.proc.forEach(function (b) { INFO[b[0]] = 'proc'; }); E.mem.forEach(function (b) { INFO[b[0]] = 'mem'; }); E.disk.forEach(function (b) { INFO[b[0]] = 'disk'; });
    root.classList.add('aa');
    root.innerHTML =
      '<div class="aa-stage"></div>' +
      '<div class="aa-now" aria-hidden="true"><span class="aa-now-n"></span><span class="aa-now-t"></span></div>' +
      '<div class="aa-cap" aria-live="polite"><div class="aa-layers"></div><div class="aa-step"></div><div class="aa-title"></div><p class="aa-sub"></p><details class="aa-more"><summary>Why it works this way</summary><p class="aa-detail"></p></details></div>' +
      '<div class="aa-ctl"><button type="button" class="aa-btn aa-prev" aria-label="Previous scene">‹</button><button type="button" class="aa-btn aa-play">▶ Play</button><button type="button" class="aa-btn aa-next" aria-label="Next scene">›</button><div class="aa-dots"></div><div class="aa-opts">' +
        (E.rep ? '<div class="aa-seg" role="group" aria-label="Replication"><span>' + E.rep.label + '</span><button type="button" data-sync="0">' + E.rep.modes[0] + '</button><button type="button" data-sync="1">' + E.rep.modes[1] + '</button></div>' : '') +
        '<div class="aa-seg" role="group" aria-label="Speed"><span>Speed</span><button type="button" data-speed="1.45">slower</button><button type="button" data-speed="1">normal</button><button type="button" data-speed="0.7">faster</button></div></div></div>';
    var stage = root.querySelector('.aa-stage'), dots = root.querySelector('.aa-dots');
    E.scenes.forEach(function (sc, k) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'aa-dot'; b.setAttribute('aria-label', 'Scene ' + (k + 1) + ': ' + sc.t);
      b.addEventListener('click', function () { go(k); stop(); }); dots.appendChild(b);
    });

    function build() {
      var lay = root.clientWidth < 640 ? 'narrow' : 'wide'; st.lay = lay;
      G = layout(E, lay);
      stage.innerHTML = '';
      svg = el('svg', { viewBox: '0 0 ' + G.W + ' ' + G.H, role: 'img', 'aria-label': E.name + ' architecture, animated: processes, memory and disk' }, stage);
      N = { box: {}, w: {}, pos: {}, lab: {} };
      Object.keys(G.bands).forEach(function (k) {
        var r = G.bands[k], g = el('g', { 'class': 'aa-band aa-' + k }, svg);
        el('rect', { x: r[0], y: r[1], width: r[2], height: r[3], rx: 16 }, g);
        el('text', { x: r[0] + 14, y: r[1] + 22, 'class': 'aa-bandlab' }, g, BAND[k].toUpperCase());
        N['band_' + k] = g;
      });
      ALL.forEach(function (b) {
        var r = G[b[0]]; if (!r) return;
        var layer = INFO[b[0]] || 'out';
        var g = el('g', { 'class': 'aa-box aa-' + layer, 'data-k': b[0] }, svg);
        el('rect', { x: r[0], y: r[1], width: r[2], height: r[3], rx: 12 }, g);
        var lab = el('text', { x: r[0] + 10, y: r[1] + 21, 'class': 'aa-lab' }, g, b[1]);
        var room = r[2] - 30, need = b[1].length * 7.7;
        if (need > room) lab.setAttribute('style', 'font-size:' + Math.max(10.5, 13.5 * room / need).toFixed(1) + 'px');
        wrapText(g, b[2], r[0] + 10, r[1] + 37, r[2] - 18, r[3] >= 70 ? 2 : 1);
        el('circle', { cx: r[0] + r[2] - 11, cy: r[1] + 13, r: 4, 'class': 'aa-led' }, g);
        N.box[b[0]] = g; N.lab[b[0]] = lab;
      });
      Object.keys(E.widgets).forEach(function (id) { widget(id, E.widgets[id]); });
      if (E.rep) {
        var pb = G.bands.proc;
        N.downMark = el('g', { 'class': 'aa-downmark' }, svg);
        el('rect', { x: pb[0] + pb[2] - 172, y: pb[1] + 6, width: 160, height: 24, rx: 12 }, N.downMark);
        el('text', { x: pb[0] + pb[2] - 92, y: pb[1] + 22, 'text-anchor': 'middle' }, N.downMark, '✕ ' + E.rep.primary + ' down');
      }
    }
    function wrapText(g, t, x, y, w, lines) {
      var max = Math.floor(w / 5.5), words = t.split(' '), out = [], cur = '';
      words.forEach(function (wd) { if ((cur + ' ' + wd).trim().length > max && cur) { out.push(cur); cur = wd; } else cur = (cur + ' ' + wd).trim(); });
      if (cur) out.push(cur);
      if (out.length > lines) { out = out.slice(0, lines); var l = out[lines - 1]; out[lines - 1] = (l.length > max - 1 ? l.slice(0, max - 1) : l) + '…'; }
      out.forEach(function (l, i) { el('text', { x: x, y: y + i * 13, 'class': 'aa-subl' }, g, l); });
    }
    function widget(id, w) {
      var type = w[0], r = G[w[1]]; if (!r) return;
      var list = [], pos = [];
      if (type === 'spawn') {
        var n = w[2], cw = Math.min(30, (r[2] - 20 - (n - 1) * 5) / n);
        for (var i = 0; i < n; i++) {
          var x = r[0] + 10 + i * (cw + 5), y = r[1] + r[3] - 26, g = el('g', { 'class': 'aa-bk' }, svg);
          el('rect', { x: x, y: y, width: cw, height: 17, rx: 4 }, g);
          el('text', { x: x + cw / 2, y: y + 12.5, 'text-anchor': 'middle' }, g, w[3] + (n > 1 ? i + 1 : ''));
          list.push(g); pos.push([x + cw / 2, y + 8]);
        }
      } else if (type === 'slots') {
        var m = w[2], gp = 6, pw = Math.min(40, (r[2] - 20 - (m - 1) * gp) / m), ph = Math.min(36, r[3] - 56);
        for (var p = 0; p < m; p++) {
          var px = r[0] + 10 + p * (pw + gp), py = r[1] + r[3] - ph - 10, pg = el('g', { 'class': 'aa-page' }, svg);
          el('rect', { x: px, y: py, width: pw, height: ph, rx: 5 }, pg);
          el('line', { x1: px + 6, y1: py + ph * 0.3, x2: px + pw - 6, y2: py + ph * 0.3 }, pg);
          el('line', { x1: px + 6, y1: py + ph * 0.52, x2: px + pw - 10, y2: py + ph * 0.52 }, pg);
          el('line', { x1: px + 6, y1: py + ph * 0.74, x2: px + pw - 8, y2: py + ph * 0.74, 'class': 'aa-deadline' }, pg);
          list.push(pg); pos.push([px + pw / 2, py + ph / 2]);
        }
      } else if (type === 'bar') {
        list.push(el('rect', { x: r[0] + 10, y: r[1] + r[3] - 26, width: r[2] - 20, height: 14, rx: 7, 'class': 'aa-walrec' }, svg));
        pos.push([r[0] + r[2] / 2, r[1] + r[3] - 19]);
      } else if (type === 'segs') {
        var k = w[2], sw = (r[2] - 20) / k;
        for (var s = 0; s < k; s++) list.push(el('rect', { x: r[0] + 10 + s * sw, y: r[1] + r[3] - 22, width: sw - 4, height: 12, rx: 3, 'class': 'aa-seg aa-seg-' + (w[4] || 'log') }, svg));
        N['fs_' + w[1]] = el('rect', { x: r[0] + 10, y: r[1] + r[3] - 6, width: 0, height: 3, rx: 1.5, 'class': 'aa-fsync', 'data-w': r[2] - 20 }, svg);
      } else if (type === 'mark') {
        list.push(el('text', { x: r[0] + r[2] - 24, y: r[1] + 21, 'text-anchor': 'end', 'class': 'aa-ck' }, svg, w[2]));
      } else if (type === 'rep') {
        var parts = w[2], np = parts.length, wide = st.lay === 'wide', rowsEl = [], rpos = [];
        for (var q = 0; q < np; q++) {
          var rx, ry, rw, rh;
          if (wide) { rx = r[0] + 10; ry = r[1] + 50 + q * 34; rw = r[2] - 20; rh = 28; }
          else { rw = (r[2] - 20 - (np - 1) * 8) / np; rx = r[0] + 10 + q * (rw + 8); ry = r[1] + 48; rh = 40; }
          var rg = el('g', { 'class': 'aa-rpart' }, svg);
          el('rect', { x: rx, y: ry, width: rw, height: rh, rx: 7 }, rg);
          el('text', { x: rx + 8, y: ry + (wide ? 18 : 24), 'class': 'aa-rlab' }, rg, parts[q]);
          rowsEl.push(rg); rpos.push([rx + rw / 2, ry + rh / 2]);
        }
        var rm = w[3].length, rgp = 6, rpw = Math.min(30, (r[2] - 20 - (rm - 1) * rgp) / rm), rph = 26, rpages = [], rpp = [];
        for (var z = 0; z < rm; z++) {
          var zx = r[0] + 10 + z * (rpw + rgp), zy = r[1] + r[3] - rph - 10, zg = el('g', { 'class': 'aa-page aa-rpage' }, svg);
          el('rect', { x: zx, y: zy, width: rpw, height: rph, rx: 4 }, zg);
          el('line', { x1: zx + 5, y1: zy + 9, x2: zx + rpw - 5, y2: zy + 9 }, zg);
          el('line', { x1: zx + 5, y1: zy + 16, x2: zx + rpw - 8, y2: zy + 16 }, zg);
          rpages.push(zg); rpp.push([zx + rpw / 2, zy + rph / 2]);
        }
        N.lagText = el('text', { x: r[0] + 10, y: r[1] + r[3] - rph - 20, 'class': 'aa-lag' }, svg, '');
        N.rep = { parts: rowsEl, pages: rpages };
        N.pos.rep = rpos; N.pos.rpages = rpp;
        N.w[id] = { type: 'rep', el: [], box: w[1] };
        return;
      } else if (type === 'graph') {
        // three layers of an HNSW graph: 1, 3 and 7 nodes, plus one new node
        var gx = r[0] + 14, gw = r[2] - 28, rowsY = [r[1] + 52, r[1] + 74, r[1] + r[3] - 14], L = [[0.5], [0.2, 0.5, 0.8], [0.06, 0.2, 0.34, 0.5, 0.64, 0.8, 0.94]];
        var nodes = L.map(function (row, li) { return row.map(function (f) { return [gx + f * gw, rowsY[li]]; }); });
        var edges = [[0, 0, 1, 1], [1, 0, 1, 1], [1, 1, 1, 2], [1, 1, 2, 3], [1, 0, 2, 1], [1, 2, 2, 5], [2, 2, 2, 3], [2, 3, 2, 4], [2, 1, 2, 2], [2, 4, 2, 5], [2, 5, 2, 6], [2, 0, 2, 1]];
        var E2 = el('g', { 'class': 'aa-gr' }, svg);
        edges.forEach(function (e, ei) { var a = nodes[e[0]][e[1]], b = nodes[e[2]][e[3]]; list.push(el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], 'class': 'aa-ge', 'data-e': ei }, E2)); });
        var ND = [];
        nodes.forEach(function (row, li) { row.forEach(function (nn, ni) { ND.push(el('circle', { cx: nn[0], cy: nn[1], r: li === 2 ? 5 : 6, 'class': 'aa-gn', 'data-n': li + ':' + ni }, E2)); }); });
        var nx = [gx + 0.42 * gw, rowsY[2] - 12];
        N.newNode = [el('line', { x1: nx[0], y1: nx[1], x2: nodes[2][3][0], y2: nodes[2][3][1], 'class': 'aa-ge aa-gnew' }, E2), el('line', { x1: nx[0], y1: nx[1], x2: nodes[2][2][0], y2: nodes[2][2][1], 'class': 'aa-ge aa-gnew' }, E2), el('circle', { cx: nx[0], cy: nx[1], r: 5, 'class': 'aa-gn aa-gnew' }, E2)];
        N.gnodes = ND; N.gedges = list;
        pos.push([gx + gw / 2, rowsY[1]]);
      }
      N.w[id] = { type: type, el: list, box: w[1] }; N.pos[id] = pos;
    }
    function anchor(name) {
      var p = name.split(':');
      if (p.length === 2 && N.pos[p[0]]) return N.pos[p[0]][+p[1]] || N.pos[p[0]][0];
      var r = G[name]; return [r[0] + r[2] / 2, r[1] + r[3] / 2];
    }

    function base() {
      var S = { hit: {}, dead: {}, fsync: null, lag: 0, down: 0, promoted: 0, lost: 0, sync: st.sync, rpages: E.widgets.sr ? E.widgets.sr[3].slice() : [] };
      Object.keys(E.widgets).forEach(function (id) {
        var w = E.widgets[id];
        S[id] = w[0] === 'slots' ? w[3].slice() : w[0] === 'segs' ? w[3] : 0;
        S.dead[id] = -1;
      });
      return S;
    }
    function SC(i) {
      var sc = E.scenes[i]; if (!sc) return sc;
      if (!(st.sync && sc.alt)) return sc;
      var o = {}; Object.keys(sc).forEach(function (k) { o[k] = sc[k]; }); Object.keys(sc.alt).forEach(function (k) { o[k] = sc.alt[k]; }); return o;
    }
    function stateAt(i) {
      var S = base();
      for (var k = 0; k <= i; k++) { S.hit = {}; S.fsync = null; S.slow = 0; SC(k).fx(S); }
      return S;
    }
    function render(S) {
      Object.keys(N.w).forEach(function (id) {
        var w = N.w[id], v = S[id];
        if (w.type === 'spawn') w.el.forEach(function (g, k) { g.setAttribute('class', 'aa-bk' + (k < v ? ' on' : '') + (S.dead[id] >= 0 && k > S.dead[id] - 1 && k < v ? ' aa-drop' : '') + (S.slow && id === 'q' && k > 0 ? ' aa-wait' : '')); });
        else if (w.type === 'slots') w.el.forEach(function (g, k) { g.setAttribute('class', 'aa-page aa-' + v[k] + (S.dead[id] === k ? ' aa-dead' : '') + (S.hit[id] === k ? ' aa-hit' : '')); });
        else if (w.type === 'bar' || w.type === 'mark') w.el[0].classList.toggle('on', !!v);
        else if (w.type === 'segs') w.el.forEach(function (r, k) { r.classList.toggle('on', k < v); });
        else if (w.type === 'graph') {
          N.gnodes.forEach(function (c) { var d = c.getAttribute('data-n'), li = +d[0]; c.classList.toggle('on', v >= 1 && ((li === 0) || (v >= 3 && li === 1 && d !== '1:0') || (v >= 3 && li === 2 && /2:[2345]/.test(d)))); c.classList.toggle('slow', v === 5); });
          N.gedges.forEach(function (l) { var e = +l.getAttribute('data-e'); l.classList.toggle('on', (v >= 1 && e === 1) || (v >= 3 && [2, 3, 6, 7, 9].indexOf(e) >= 0)); });
          N.newNode.forEach(function (x) { x.classList.toggle('show', v >= 4); });
        }
      });
      Object.keys(N).forEach(function (k) { if (k.indexOf('fs_') === 0) N[k].setAttribute('width', 0); });
      if (S.fsync && N['fs_' + S.fsync]) { var f = N['fs_' + S.fsync]; later(function () { f.setAttribute('width', f.getAttribute('data-w')); }, 60); }
      Object.keys(N.box).forEach(function (k) { N.box[k].classList.toggle('aa-busy', !!(S.slow && k === 'main')); });
      if (E.rep && N.rep) {
        N.rep.pages.forEach(function (g, k) { g.setAttribute('class', 'aa-page aa-rpage aa-' + S.rpages[k]); });
        var R = E.rep;
        N.lagText.textContent = S.lost === 1 ? '✕ ' + R.lostText : S.lost === 2 ? '✓ ' + R.keptText : S.lag > 0 ? 'Behind by ' + S.lag + ' ' + R.unit + (S.lag > 1 ? 's' : '') : 'In step with the ' + R.primary;
        N.lagText.setAttribute('class', 'aa-lag' + (S.lost === 1 ? ' bad' : S.lost === 2 ? ' good' : S.lag > 0 ? ' warn' : ''));
        ['proc', 'mem', 'disk'].forEach(function (k) { N['band_' + k].classList.toggle('aa-down', !!S.down); });
        N.downMark.classList.toggle('on', !!S.down);
        N.lab[R.box].textContent = S.promoted ? R.promotedName : R.name;
        N.box[R.box].classList.toggle('aa-promoted', !!S.promoted);
      }
    }
    function settled(i) { var S = stateAt(i); if (i >= 0) { S.hit = {}; S.fsync = null; } return S; }
    function frame(i) {
      var sc = SC(i);
      Object.keys(N.box).forEach(function (k) { N.box[k].classList.toggle('hl', !!(sc && sc.hl.indexOf(k) >= 0)); });
      ['proc', 'mem', 'disk'].forEach(function (k) { N['band_' + k].classList.toggle('hl', !!(sc && sc.layers.indexOf(k) >= 0)); });
      var cap = root.querySelector('.aa-cap');
      if (!sc) {
        cap.querySelector('.aa-layers').innerHTML = '';
        cap.querySelector('.aa-step').textContent = E.name + ' · ' + E.scenes.length + ' scenes';
        cap.querySelector('.aa-title').textContent = E.intro[0];
        cap.querySelector('.aa-sub').innerHTML = colorize(E.intro[1]);
        cap.querySelector('.aa-more').hidden = true;
      } else {
        cap.querySelector('.aa-layers').innerHTML = sc.layers.map(function (l) { return '<span class="aa-chip aa-chip-' + l + '">' + BAND[l] + '</span>'; }).join('');
        cap.querySelector('.aa-step').textContent = 'Scene ' + (i + 1) + ' of ' + E.scenes.length;
        cap.querySelector('.aa-title').textContent = sc.t;
        cap.querySelector('.aa-sub').innerHTML = colorize(sc.s);
        cap.querySelector('.aa-detail').innerHTML = colorize(sc.d);
        cap.querySelector('.aa-more').hidden = false;
      }
      Array.prototype.forEach.call(dots.children, function (d, k) { d.classList.toggle('on', k === i); d.classList.toggle('done', k < i); });
    }
    var now = root.querySelector('.aa-now'), nowN = root.querySelector('.aa-now-n'), nowT = root.querySelector('.aa-now-t');
    function say(text, n, total) {
      nowN.textContent = total > 1 ? n + '/' + total : '';
      nowT.innerHTML = colorize(text);
      now.classList.remove('pop'); void now.offsetWidth; now.classList.add('pop');
    }
    function lines(i) { var sc = SC(i); return (sc && sc.lines) || (NARR[key] && NARR[key][i]) || []; }
    function ordered(i) { return SC(i).moves.map(function (m, k) { return [m, k]; }).sort(function (a, b) { return a[0][3] - b[0][3] || a[1] - b[1]; }).map(function (x) { return x[0]; }); }
    function sceneLength(i) { return (SC(i).moves.length * STEP + HOLD) * st.speed; }
    // Show scene i: the moves play one after another, each with its line,
    // and the lasting changes appear when the last one lands.
    function show(i, animate) {
      frame(i);
      if (i < 0) { render(settled(-1)); now.classList.add('idle'); nowN.textContent = ''; nowT.textContent = 'Press play to watch it move.'; return; }
      now.classList.remove('idle');
      var ms = ordered(i), ls = lines(i);
      if (!animate || reduce) { render(stateAt(i)); nowN.textContent = ''; nowT.innerHTML = colorize(ls.join(' · ')); return; }
      render(settled(i - 1));
      ms.forEach(function (m, k) {
        later(function () { say(ls[k] || m[4], k + 1, ms.length); fly(m); }, k * STEP * st.speed);
      });
      later(function () { render(stateAt(i)); }, ((ms.length - 1) * STEP + FLIGHT) * st.speed);
    }
    function later(f, t) { st.tt.push(setTimeout(f, t)); }
    function fly(m) {
      var a = anchor(m[1]), b = anchor(m[2]), delay = 0, label = m[4], same = m[1] === m[2];
      var trail = same ? null : el('path', { d: 'M' + a[0] + ',' + a[1] + ' Q' + ((a[0] + b[0]) / 2) + ',' + (Math.min(a[1], b[1]) - 26) + ' ' + b[0] + ',' + b[1], 'class': 'aa-trail aa-trail-' + m[0] }, svg);
      if (trail) later(function () { trail.remove(); }, (FLIGHT * st.speed) + 900);
      var g = el('g', { 'class': 'aa-pill aa-pill-' + m[0], opacity: 0 }, svg);
      var w = Math.max(56, label.length * 7.2 + 22);
      el('rect', { x: -w / 2, y: -13, width: w, height: 26, rx: 13 }, g);
      el('text', { x: 0, y: 5, 'text-anchor': 'middle' }, g, label);
      var t0 = null, len = FLIGHT * st.speed;
      function step(ts) {
        if (!t0) t0 = ts;
        var t = (ts - t0 - delay) / len;
        if (t < 0) { st.raf.push(requestAnimationFrame(step)); return; }
        if (t > 1.35) { g.remove(); return; }
        var u = Math.min(1, t), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        var x = a[0] + (b[0] - a[0]) * e + (same ? 60 * e : 0), y = a[1] + (b[1] - a[1]) * e - Math.sin(Math.PI * u) * (same ? 10 : 26);
        g.setAttribute('transform', 'translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ') scale(' + (1 + 0.12 * Math.sin(Math.PI * u)).toFixed(3) + ')');
        g.setAttribute('opacity', t > 1.05 ? Math.max(0, 1 - (t - 1.05) / 0.3) : Math.min(1, u * 5));
        st.raf.push(requestAnimationFrame(step));
      }
      st.raf.push(requestAnimationFrame(step));
    }
    function clearFlights() { st.raf.forEach(cancelAnimationFrame); st.raf = []; st.tt.forEach(clearTimeout); st.tt = []; Array.prototype.forEach.call(svg.querySelectorAll('.aa-pill,.aa-trail'), function (p) { p.remove(); }); }
    function go(i, animate) { clearFlights(); st.i = i; show(i, animate !== false); }
    function next() { go(st.i + 1 >= E.scenes.length ? 0 : st.i + 1); }
    function tick() {
      clearTimeout(st.timer);
      st.timer = setTimeout(function () {
        if (!st.playing) return;
        if (st.i >= E.scenes.length - 1) { stop(); return; }
        next(); tick();
      }, sceneLength(st.i));
    }
    function play() {
      st.playing = true; root.querySelector('.aa-play').textContent = '❚❚ Pause';
      if (st.i >= E.scenes.length - 1 || st.i < 0) go(0); else next();
      tick();
    }
    function stop() { st.playing = false; clearTimeout(st.timer); root.querySelector('.aa-play').textContent = st.i >= E.scenes.length - 1 ? '↻ Replay' : '▶ Play'; }
    root.querySelector('.aa-play').addEventListener('click', function () { if (st.playing) stop(); else play(); });
    root.querySelector('.aa-next').addEventListener('click', function () { next(); stop(); });
    root.querySelector('.aa-prev').addEventListener('click', function () { go(Math.max(0, st.i - 1)); stop(); });
    function marks() {
      Array.prototype.forEach.call(root.querySelectorAll('[data-sync]'), function (b) { b.setAttribute('aria-pressed', String((b.getAttribute('data-sync') === '1') === st.sync)); });
      Array.prototype.forEach.call(root.querySelectorAll('[data-speed]'), function (b) { b.setAttribute('aria-pressed', String(+b.getAttribute('data-speed') === st.speed)); });
    }
    Array.prototype.forEach.call(root.querySelectorAll('[data-sync]'), function (b) {
      b.addEventListener('click', function () { st.sync = b.getAttribute('data-sync') === '1'; marks(); var target = st.i < 0 ? 0 : st.i; go(target); stop(); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-speed]'), function (b) {
      b.addEventListener('click', function () { st.speed = +b.getAttribute('data-speed'); marks(); });
    });
    marks();
    build(); show(-1, false);
    var lastW = root.clientWidth;
    addEventListener('resize', function () { var w = root.clientWidth; if ((w < 640) !== (lastW < 640)) { clearFlights(); build(); show(st.i, false); } lastW = w; });
    if ('IntersectionObserver' in window && !reduce) {
      new IntersectionObserver(function (es) { es.forEach(function (en) { if (en.isIntersecting && !st.seen) { st.seen = true; setTimeout(play, 500); } else if (!en.isIntersecting && st.playing) stop(); }); }, { threshold: 0.45 }).observe(root);
    }
  }
  window.HDW_ARCH = { engines: ENG, layout: layout };
  Array.prototype.forEach.call(document.querySelectorAll('.archanim'), mount);
})();
