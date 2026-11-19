/* Config checker: paste PostgreSQL, MySQL or MongoDB settings and get the
   risky and the costly ones flagged, with why and what to change.
   HDW_CONFIG.check({engine, text, ramGB}) -> {engine, settings, findings, unknownFormat}
   Runs in the browser; nothing is sent anywhere. */
(function (root) {
  var L = { pg: '../postgresql/index.html', my: '../mysql/index.html', mo: '../mongodb/index.html',
    commit: '../decisions/sync-replication-failover/index.html', pool: '../decisions/connection-pooling/index.html',
    backup: '../decisions/backup-restore/index.html', sym: '../symptoms/index.html' };

  /* ---------- parsing ---------- */
  function stripQuotes(v) { v = v.trim(); if ((v[0] === "'" && v.slice(-1) === "'") || (v[0] === '"' && v.slice(-1) === '"')) v = v.slice(1, -1); return v; }
  function parseKV(text, dashes) {
    var out = {};
    text.split(/\r?\n/).forEach(function (line) {
      var l = line.replace(/\s+#.*$/, '').trim();
      if (!l || l[0] === '#' || l[0] === ';' || l[0] === '[' || /^[-+]+$/.test(l) || /^\(\d+ rows?\)$/.test(l)) return;
      var m;
      if ((m = l.match(/^\|?\s*([A-Za-z_][\w.\-]*)\s*\|\s*([^|]*?)\s*(?:\|\s*([^|]*?)\s*)?(?:\|.*)?$/))) {
        var k = m[1], v = m[2], unit = m[3];
        if (/^(name|variable_name|setting)$/i.test(k)) return;
        if (unit && /^\d+$/.test(v)) { if (unit === '8kB') v = (+v * 8) + 'kB'; else if (/^(kB|MB|GB|B|ms|s|min)$/.test(unit)) v = v + unit; }
        out[norm(k, dashes)] = stripQuotes(v);
      } else if ((m = l.match(/^([A-Za-z_][\w.\-]*)\s*\t\s*(.*)$/))) {
        if (!/^variable_name$/i.test(m[1])) out[norm(m[1], dashes)] = stripQuotes(m[2]);
      } else if ((m = l.match(/^([A-Za-z_][\w.\-]*)\s*=\s*(.*)$/))) {
        out[norm(m[1], dashes)] = stripQuotes(m[2]);
      } else if ((m = l.match(/^([A-Za-z_][\w\-]*)$/)) && dashes) {
        out[norm(m[1], dashes)] = 'ON';      /* my.cnf flags like skip-name-resolve */
      }
    });
    return out;
  }
  function norm(k, dashes) { k = k.trim().toLowerCase(); return dashes ? k.replace(/-/g, '_') : k; }
  function parseYaml(text) {
    var out = {}, stack = [];
    text.split(/\r?\n/).forEach(function (line) {
      if (!line.trim() || /^\s*#/.test(line)) return;
      var m = line.match(/^(\s*)([A-Za-z_][\w.]*)\s*:\s*(.*)$/);
      if (!m) return;
      var ind = m[1].length, key = m[2], val = m[3].replace(/\s+#.*$/, '').trim();
      while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
      var path = stack.map(function (s) { return s.key; }).concat(key).join('.');
      if (val === '') stack.push({ ind: ind, key: key }); else out[path] = stripQuotes(val);
    });
    return out;
  }
  function parseJson(text) {
    var o; try { o = JSON.parse(text); } catch (e) { return null; }
    if (o && o.parsed) o = o.parsed;
    var out = {};
    (function walk(x, p) {
      if (x && typeof x === 'object' && !Array.isArray(x)) Object.keys(x).forEach(function (k) { walk(x[k], p ? p + '.' + k : k); });
      else out[p] = String(x);
    })(o, '');
    return out;
  }
  function detect(text) {
    if (/^\s*\{/.test(text)) return 'mo';
    if (/^\s*(storage|net|replication|security|systemLog|operationProfiling|processManagement)\s*:/m.test(text)) return 'mo';
    if (/\b(innodb_|binlog|sync_binlog|max_binlog|log_bin|sql_mode|\[mysqld\])/i.test(text)) return 'my';
    if (/\b(shared_buffers|work_mem|wal_level|autovacuum|effective_cache_size|max_wal_size|synchronous_commit|statement_timeout|idle_in_transaction_session_timeout|log_min_duration_statement|archive_mode|full_page_writes|shared_preload_libraries|random_page_cost)\b/.test(text)) return 'pg';
    return null;
  }

  /* ---------- values ---------- */
  function bytes(v, defUnit) {
    if (v == null) return null;
    var m = String(v).trim().match(/^(-?\d+(?:\.\d+)?)\s*([kKmMgGtT]?[bB]?)?$/);
    if (!m) return null;
    var n = parseFloat(m[1]), u = (m[2] || defUnit || '').toUpperCase();
    var mult = { '': 1, B: 1, K: 1024, KB: 1024, M: 1048576, MB: 1048576, G: 1073741824, GB: 1073741824, T: 1099511627776, TB: 1099511627776 }[u];
    if (u === '8KB') mult = 8192;
    if (/^8kB$/i.test(m[2] || '')) mult = 8192;
    return mult == null ? null : n * mult;
  }
  function pgBytes(v, defUnit) {
    return bytes(v, defUnit);
  }
  function ms(v, defUnit) {
    var m = String(v).trim().match(/^(-?\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/);
    if (!m) return null;
    return parseFloat(m[1]) * { ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 }[m[2] || defUnit || 'ms'];
  }
  function on(v) { return /^(on|true|1|yes)$/i.test(String(v).trim()); }
  function off(v) { return /^(off|false|0|no)$/i.test(String(v).trim()); }
  function gb(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(b >= 10737418240 ? 0 : 1) + ' GB' : Math.round(b / 1048576) + ' MB'; }

  /* ---------- rules ---------- */
  function F(sev, key, val, title, why, fix, link) { return { sev: sev, key: key, value: val, title: title, why: why, fix: fix, link: link }; }

  function checkPg(s, ram) {
    var f = [], v;
    if ((v = s.fsync) && off(v)) f.push(F('risk', 'fsync', v, 'fsync is off', 'The server never forces data to disk. A power failure or OS crash can corrupt the whole cluster, not just lose recent commits.', 'Turn it on. If commits are too slow, synchronous_commit = off loses a short window without risking corruption.', L.pg));
    if ((v = s.full_page_writes) && off(v)) f.push(F('risk', 'full_page_writes', v, 'full_page_writes is off', 'After a crash a half-written 8 KB page cannot be repaired from the WAL, so the data can be silently corrupt.', 'Turn it on unless the storage guarantees atomic 8 KB writes, and you have checked that it does.', L.pg));
    if ((v = s.synchronous_commit) && /^(off|local)$/i.test(v)) f.push(F(v.toLowerCase() === 'off' ? 'risk' : 'tip', 'synchronous_commit', v,
      v.toLowerCase() === 'off' ? 'Commits return before the WAL is flushed' : 'Commits do not wait for a standby',
      v.toLowerCase() === 'off' ? 'A crash can lose commits from the last few hundred milliseconds that clients were told succeeded. No corruption, but real loss.' : 'If a synchronous standby is configured, this setting skips waiting for it, so a failover can lose recent commits.',
      'Use on for data you cannot lose. off can be set per transaction for data you can, such as logs.', L.commit));
    if ((v = s.autovacuum) && off(v)) f.push(F('risk', 'autovacuum', v, 'autovacuum is off', 'Dead rows pile up, tables and indexes bloat, and transaction ID wraparound will eventually force the database to stop accepting writes.', 'Turn it on. Tune it per table instead of turning it off.', L.pg));
    var sb = s.shared_buffers != null ? pgBytes(s.shared_buffers, '8kB') : null;
    if (sb != null && ram) {
      if (sb <= 134217728 && ram >= 4 * 1073741824) f.push(F('slow', 'shared_buffers', s.shared_buffers, 'shared_buffers is still the 128 MB default', 'On a ' + gb(ram) + ' server almost every read goes through the OS cache or the disk instead of PostgreSQL\'s own cache.', 'Start at about 25% of memory: ' + gb(ram * 0.25) + ' here. Restart required.', L.pg));
      else if (sb > ram * 0.45) f.push(F('slow', 'shared_buffers', s.shared_buffers, 'shared_buffers is over 45% of memory', 'PostgreSQL also relies on the OS cache, and work_mem, maintenance and connections need memory too. Too large a value can mean double caching and memory pressure.', 'Around 25% of memory is the usual start; measure before going above 40%.', L.pg));
    } else if (sb != null && sb <= 134217728) f.push(F('tip', 'shared_buffers', s.shared_buffers, 'shared_buffers is the 128 MB default', 'The default suits a laptop, not a server.', 'Enter the server\'s memory above to get a suggested value.', L.pg));
    var wm = s.work_mem != null ? pgBytes(s.work_mem, 'kB') : null, mc = s.max_connections != null ? +s.max_connections : null;
    if (wm != null && mc && ram && wm * mc * 2 > ram) f.push(F('risk', 'work_mem', s.work_mem, 'work_mem × connections can exceed memory', 'work_mem is per sort or hash, not per connection. ' + mc + ' connections each running a query with two sorts could ask for ' + gb(wm * mc * 2) + ' on a ' + gb(ram) + ' server, and the OOM killer ends the postmaster.', 'Lower work_mem globally and raise it per session for the reports that need it, or use fewer connections with a pooler.', L.sym + '#memory'));
    if (mc && mc > 500) f.push(F('slow', 'max_connections', mc, 'max_connections is ' + mc, 'Each connection is a process. Hundreds of mostly idle ones cost memory and make snapshots and locking slower for the busy ones.', 'Use a pooler such as PgBouncer and size the pool from the work: queries a second × seconds per query.', L.pool));
    var ecs = s.effective_cache_size != null ? pgBytes(s.effective_cache_size, '8kB') : null;
    if (ecs != null && ram && ecs < ram * 0.4) f.push(F('tip', 'effective_cache_size', s.effective_cache_size, 'effective_cache_size is low for this server', 'It allocates nothing; it tells the planner how much data is likely cached. Too low, and the planner avoids index scans that would be fast.', 'Set it to about 50 to 75% of memory: ' + gb(ram * 0.6) + ' here.', L.pg));
    var mwm = s.maintenance_work_mem != null ? pgBytes(s.maintenance_work_mem, 'kB') : null;
    if (mwm != null && mwm <= 67108864 && (!ram || ram >= 8 * 1073741824)) f.push(F('tip', 'maintenance_work_mem', s.maintenance_work_mem, 'maintenance_work_mem is the 64 MB default', 'Index builds and vacuum run faster with more memory. Building an HNSW index is far faster when the graph fits in it.', 'Try 512 MB to 1 GB, more for a one-off index build in that session.', L.pg));
    var mws = s.max_wal_size != null ? pgBytes(s.max_wal_size, 'MB') : null;
    if (mws != null && mws <= 1073741824) f.push(F('tip', 'max_wal_size', s.max_wal_size, 'max_wal_size is the 1 GB default', 'On a busy server checkpoints are forced by WAL volume every few minutes, and each one causes a burst of writes and full-page images.', 'Raise it (4 to 16 GB is common) and check pg_stat_checkpointer for requested checkpoints. Longer gaps mean longer crash recovery.', L.pg));
    if (s.random_page_cost != null && +s.random_page_cost >= 4) f.push(F('tip', 'random_page_cost', s.random_page_cost, 'random_page_cost is 4, tuned for spinning disks', 'On SSD or cloud block storage a random read is not four times a sequential one, so the planner prefers sequential scans too often.', 'On SSD, 1.1 to 2 is common. Test with EXPLAIN on your slow queries.', L.pg));
    if (s.idle_in_transaction_session_timeout != null && ms(s.idle_in_transaction_session_timeout) === 0) f.push(F('tip', 'idle_in_transaction_session_timeout', s.idle_in_transaction_session_timeout, 'Sessions can sit idle in a transaction forever', 'An app that opens a transaction and forgets it holds locks and stops vacuum from cleaning up.', 'Set it to a few minutes, for example 5min, at least for application roles.', L.sym + '#bloat'));
    if (s.statement_timeout != null && ms(s.statement_timeout) === 0) f.push(F('tip', 'statement_timeout', s.statement_timeout, 'No statement timeout', 'A runaway query can run for hours and hold a connection.', 'Set one per application role (ALTER ROLE app SET statement_timeout = \'30s\'), not globally, so maintenance jobs are not cut off.', L.sym + '#cpu'));
    if (s.log_min_duration_statement != null && ms(s.log_min_duration_statement) < 0) f.push(F('tip', 'log_min_duration_statement', s.log_min_duration_statement, 'Slow queries are not logged', 'When something gets slow you will have no record of which statements took long.', 'Set it to something like 500ms or 1s.', L.sym + '#cpu'));
    if (s.shared_preload_libraries != null && !/pg_stat_statements/.test(s.shared_preload_libraries)) f.push(F('tip', 'shared_preload_libraries', s.shared_preload_libraries || '(empty)', 'pg_stat_statements is not loaded', 'It is the one view that ranks queries by total time. Without it, finding what uses the CPU is guesswork.', 'Add pg_stat_statements to shared_preload_libraries, restart, then CREATE EXTENSION pg_stat_statements.', L.sym + '#cpu'));
    if (s.track_io_timing != null && off(s.track_io_timing)) f.push(F('tip', 'track_io_timing', s.track_io_timing, 'I/O time is not tracked', 'EXPLAIN (ANALYZE, BUFFERS) and pg_stat_statements cannot show how long reads took.', 'Turn it on; the overhead is small on modern systems (check with pg_test_timing).', L.pg));
    if ((v = s.wal_level) && /^minimal$/i.test(v)) f.push(F('risk', 'wal_level', v, 'wal_level is minimal', 'No streaming replicas and no point-in-time recovery are possible.', 'Use replica (the default) or logical.', L.backup));
    if ((v = s.archive_mode) && off(v)) f.push(F('tip', 'archive_mode', v, 'WAL archiving is off', 'Without an archive you can restore only to the moment of a backup, not to any point in time. Backup tools such as pgBackRest set this up for you.', 'Set archive_mode = on with an archive_command or a backup tool, unless a managed service or another tool handles it.', L.backup));
    return f;
  }

  function checkMy(s, ram) {
    var f = [], v;
    if ((v = s.innodb_flush_log_at_trx_commit) != null && v !== '1') f.push(F('risk', 'innodb_flush_log_at_trx_commit', v, 'Commits do not wait for the redo log flush', 'With ' + v + ', the redo log is flushed about once a second, so a crash' + (v === '2' ? ' of the machine (not just mysqld)' : '') + ' can lose up to a second of commits that clients were told succeeded.', 'Use 1 for data you cannot lose.', L.commit));
    if ((v = s.sync_binlog) != null && v !== '1') f.push(F('risk', 'sync_binlog', v, 'The binlog is not flushed on every commit', 'After a crash the binlog can be missing transactions the redo log has, so replicas and point-in-time recovery disagree with the primary.', 'Use 1 together with innodb_flush_log_at_trx_commit = 1.', L.commit));
    if ((v = s.log_bin) != null && off(v)) f.push(F('risk', 'log_bin', v, 'Binary logging is off', 'No replicas and no point-in-time recovery.', 'Enable the binlog (it is on by default since 8.0).', L.backup));
    if ((v = s.binlog_format) && !/^row$/i.test(v)) f.push(F('risk', 'binlog_format', v, 'binlog_format is ' + v, 'Statement-based logging can apply differently on replicas for non-deterministic statements. ROW is the default and the only format not deprecated.', 'Use ROW.', L.my));
    if ((v = s.gtid_mode) && off(v)) f.push(F('tip', 'gtid_mode', v, 'GTIDs are off', 'Failover tools have to find positions by file and offset, which is error prone.', 'Turn on gtid_mode and enforce_gtid_consistency (in steps on a running system).', L.my));
    var bp = s.innodb_buffer_pool_size != null ? bytes(s.innodb_buffer_pool_size) : null;
    if (bp != null) {
      if (bp <= 134217728 && (!ram || ram >= 4 * 1073741824)) f.push(F('slow', 'innodb_buffer_pool_size', s.innodb_buffer_pool_size, 'The buffer pool is the 128 MB default', 'Almost every read beyond a small working set goes to disk.', ram ? 'On a dedicated ' + gb(ram) + ' server, 60 to 75%: about ' + gb(ram * 0.7) + '.' : 'On a dedicated server, 60 to 75% of memory. Enter the memory above for a number.', L.my));
      else if (ram && bp > ram * 0.85) f.push(F('risk', 'innodb_buffer_pool_size', s.innodb_buffer_pool_size, 'The buffer pool is over 85% of memory', 'Connections, sorts, the OS and backups need memory too; the OOM killer may end mysqld.', 'Keep it near 70 to 75% of memory unless you have measured the rest.', L.sym + '#memory'));
    }
    var rl = s.innodb_redo_log_capacity != null ? bytes(s.innodb_redo_log_capacity) : null;
    if (rl != null && rl <= 104857600) f.push(F('tip', 'innodb_redo_log_capacity', s.innodb_redo_log_capacity, 'The redo log is the 100 MB default', 'A small redo log forces frequent flushing of dirty pages under write load, and writes stall when it fills.', 'Size it to hold about an hour of redo at peak; 1 to 8 GB is common. It can be changed online since 8.0.30.', L.my));
    if ((v = s.sql_mode) != null && !/STRICT_(TRANS|ALL)_TABLES/i.test(v)) f.push(F('risk', 'sql_mode', v || '(empty)', 'Strict mode is off', 'Values that do not fit are silently truncated or changed instead of failing the statement.', 'Include STRICT_TRANS_TABLES (the default).', L.my));
    if ((v = s.lock_wait_timeout) != null && +v >= 31536000) f.push(F('tip', 'lock_wait_timeout', v, 'DDL can wait a year for a metadata lock', 'An ALTER waiting behind a long transaction blocks every query on that table while it waits.', 'Set a short lock_wait_timeout (for example 5 seconds) in sessions that run schema changes, and retry.', L.sym + '#locks'));
    if ((v = s.max_connections) != null && +v > 1000) f.push(F('slow', 'max_connections', v, 'max_connections is ' + v, 'Threads_running is what matters; thousands of threads fighting for CPU make every query slower.', 'Pool in the application or with ProxySQL; size pools from the work.', L.pool));
    if ((v = s.slow_query_log) != null && off(v)) f.push(F('tip', 'slow_query_log', v, 'The slow query log is off', 'When something gets slow there is no record of which statements took long.', 'Turn it on with long_query_time = 1 (or lower).', L.sym + '#cpu'));
    else if ((v = s.long_query_time) != null && +v >= 10) f.push(F('tip', 'long_query_time', v, 'Only queries over ' + v + ' s are logged', 'Most painful queries run hundreds of times at a fraction of a second; they never reach the log.', 'Use 1 second or less.', L.sym + '#cpu'));
    if ((v = s.innodb_file_per_table) != null && off(v)) f.push(F('tip', 'innodb_file_per_table', v, 'Tables share the system tablespace', 'Space freed by dropping or rebuilding a table is never returned to the operating system.', 'Turn it on (the default).', L.my));
    if ((v = s.performance_schema) != null && off(v)) f.push(F('tip', 'performance_schema', v, 'performance_schema is off', 'sys schema views, lock waits and statement statistics all depend on it.', 'Turn it on (the default); the overhead is small.', L.sym));
    if ((v = s.innodb_print_all_deadlocks) != null && off(v)) f.push(F('tip', 'innodb_print_all_deadlocks', v, 'Only the latest deadlock is kept', 'SHOW ENGINE INNODB STATUS shows one deadlock; earlier ones are lost.', 'Turn it on so every deadlock goes to the error log.', L.sym + '#locks'));
    if ((v = s.binlog_expire_logs_seconds) != null && +v > 0 && +v < 86400 * 3) f.push(F('tip', 'binlog_expire_logs_seconds', v, 'Binlogs are kept for ' + (Math.round(+v / 3600)) + ' hours', 'Point-in-time recovery can only reach back as far as the oldest binlog, and a replica down longer than this needs a full rebuild.', 'Keep at least the time between backups plus a margin, or copy binlogs off the server.', L.backup));
    return f;
  }

  function checkMo(s, ram) {
    var f = [], v, g = function (k) { for (var i = 0; i < arguments.length; i++) if (s[arguments[i]] != null) return s[arguments[i]]; return null; };
    if ((v = g('storage.journal.enabled')) != null && off(v)) f.push(F('risk', 'storage.journal.enabled', v, 'Journaling is off', 'A crash can lose everything since the last checkpoint, up to a minute of writes. (Since 6.1 the journal cannot be turned off.)', 'Remove the setting.', L.mo));
    if (g('replication.replSetName', 'replication.replSet') == null) f.push(F('risk', 'replication.replSetName', '(not set)', 'Not a replica set', 'There is no failover, no oplog for point-in-time recovery, and majority write concern is not available.', 'Run a three-member replica set, even for small deployments. A single-member set at least gives you an oplog.', L.mo));
    var auth = g('security.authorization');
    var bind = g('net.bindIp', 'net.bind_ip');
    if (!auth || /disabled/i.test(auth)) f.push(F(bind && /0\.0\.0\.0|::/.test(bind) ? 'risk' : 'tip', 'security.authorization', auth || '(not set)', 'Authentication is not enforced', bind && /0\.0\.0\.0|::/.test(bind) ? 'Combined with bindIp ' + bind + ', anyone who can reach the port can read and delete everything.' : 'Anyone who can reach the port can read and change data.', 'Set security.authorization: enabled and create users with the least privileges they need.', L.mo));
    var cache = g('storage.wiredTiger.engineConfig.cacheSizeGB');
    if (cache != null && ram) {
      var cb = +cache * 1073741824;
      if (cb > ram * 0.8) f.push(F('risk', 'cacheSizeGB', cache, 'The WiredTiger cache is over 80% of memory', 'Connections, in-memory sorts and the OS file cache also need memory; mongod may be killed.', 'The default is 50% of (memory minus 1 GB): ' + gb(Math.max(0.25 * 1073741824, (ram - 1073741824) * 0.5)) + ' here.', L.sym + '#memory'));
      else if (cb < ram * 0.25) f.push(F('slow', 'cacheSizeGB', cache, 'The WiredTiger cache is small for this server', 'Reads that could be served from the cache go to disk and decompression.', 'Unless other processes share the machine, the default (50% of memory minus 1 GB) is a better start.', L.mo));
    }
    var op = g('replication.oplogSizeMB');
    if (op != null && +op < 2048) f.push(F('tip', 'replication.oplogSizeMB', op, 'The oplog is ' + op + ' MB', 'The oplog window (size divided by write rate) is how long a secondary can be down and still catch up. A small oplog means full resyncs.', 'Size it for at least a day of writes. rs.printReplicationInfo() shows the current window.', L.mo));
    if ((v = g('net.maxIncomingConnections')) != null && +v > 20000) f.push(F('tip', 'net.maxIncomingConnections', v, 'Very high connection limit', 'Each connection costs about 1 MB and a thread; a connection storm can exhaust memory before the limit.', 'Keep driver pools small (maxPoolSize) and watch serverStatus().connections.', L.pool));
    if ((v = g('operationProfiling.slowOpThresholdMs')) != null && +v > 1000) f.push(F('tip', 'slowOpThresholdMs', v, 'Only operations over ' + v + ' ms are logged as slow', 'Frequent operations at a few hundred milliseconds never show up.', 'The default of 100 ms is a good start.', L.sym + '#cpu'));
    return f;
  }

  var KNOWN = {
    pg: ['fsync', 'full_page_writes', 'synchronous_commit', 'autovacuum', 'shared_buffers', 'work_mem', 'max_connections', 'effective_cache_size', 'maintenance_work_mem', 'max_wal_size', 'random_page_cost', 'idle_in_transaction_session_timeout', 'statement_timeout', 'log_min_duration_statement', 'shared_preload_libraries', 'track_io_timing', 'wal_level', 'archive_mode'],
    my: ['innodb_flush_log_at_trx_commit', 'sync_binlog', 'log_bin', 'binlog_format', 'gtid_mode', 'innodb_buffer_pool_size', 'innodb_redo_log_capacity', 'sql_mode', 'lock_wait_timeout', 'max_connections', 'slow_query_log', 'long_query_time', 'innodb_file_per_table', 'performance_schema', 'innodb_print_all_deadlocks', 'binlog_expire_logs_seconds'],
    mo: ['storage.journal.enabled', 'replication.replSetName', 'security.authorization', 'net.bindIp', 'storage.wiredTiger.engineConfig.cacheSizeGB', 'replication.oplogSizeMB', 'net.maxIncomingConnections', 'operationProfiling.slowOpThresholdMs']
  };

  function check(o) {
    var text = o.text || '', engine = o.engine && o.engine !== 'auto' ? o.engine : detect(text);
    var ram = o.ramGB ? +o.ramGB * 1073741824 : 0;
    if (!engine) return { engine: null, settings: 0, findings: [], unknownFormat: true };
    var s = engine === 'mo' ? (parseJson(text) || parseYaml(text)) : parseKV(text, engine === 'my');
    var n = Object.keys(s).length;
    var fs = engine === 'pg' ? checkPg(s, ram) : engine === 'my' ? checkMy(s, ram) : checkMo(s, ram);
    var order = { risk: 0, slow: 1, tip: 2 };
    fs.sort(function (a, b) { return order[a.sev] - order[b.sev]; });
    var checked = KNOWN[engine].filter(function (k) { return s[k] != null; });
    return { engine: engine, settings: n, checked: checked.length, known: KNOWN[engine].length, findings: fs, unknownFormat: n === 0, parsed: s };
  }
  var api = { check: check, _parseKV: parseKV, _parseYaml: parseYaml, _bytes: bytes, _detect: detect };
  root.HDW_CONFIG = api;
  if (typeof module !== 'undefined') module.exports = api;

  /* ---------- page UI ---------- */
  if (typeof document === 'undefined') return;
  var EX = {
    pg: "# postgresql.conf, or the output of SHOW ALL\nshared_buffers = 128MB\nwork_mem = 64MB\nmax_connections = 800\nmaintenance_work_mem = 64MB\neffective_cache_size = 4GB\nmax_wal_size = 1GB\nrandom_page_cost = 4\nsynchronous_commit = off\nidle_in_transaction_session_timeout = 0\nlog_min_duration_statement = -1\nshared_preload_libraries = ''\narchive_mode = off",
    my: "[mysqld]\ninnodb_buffer_pool_size = 134217728\ninnodb_flush_log_at_trx_commit = 2\nsync_binlog = 0\nbinlog_format = ROW\ngtid_mode = OFF\ninnodb_redo_log_capacity = 104857600\nsql_mode = NO_ENGINE_SUBSTITUTION\nlock_wait_timeout = 31536000\nslow_query_log = OFF\nmax_connections = 2000",
    mo: "# mongod.conf\nstorage:\n  dbPath: /var/lib/mongodb\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 60\nnet:\n  port: 27017\n  bindIp: 0.0.0.0\nreplication:\n  oplogSizeMB: 1024"
  };
  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function mount(el) {
    el.innerHTML = '<div class="cc-row"><label>Engine <select class="cc-eng"><option value="auto">Detect it</option><option value="pg">PostgreSQL</option><option value="my">MySQL</option><option value="mo">MongoDB</option></select></label>' +
      '<label>Server memory, GB <input class="cc-ram" type="number" min="1" placeholder="optional" inputmode="numeric"></label>' +
      '<span class="cc-ex"><span class="kicker">Examples</span><button type="button" data-ex="pg">PostgreSQL</button><button type="button" data-ex="my">MySQL</button><button type="button" data-ex="mo">MongoDB</button></span></div>' +
      '<textarea class="cc-in" rows="12" spellcheck="false" aria-label="Settings to check" placeholder="Paste postgresql.conf, SHOW ALL, my.cnf, SHOW VARIABLES, or mongod.conf"></textarea>' +
      '<div class="cc-row"><button type="button" class="labbtn cc-go">Check the settings</button><span class="cc-meta"></span></div><div class="cc-out" aria-live="polite"></div>';
    var ta = el.querySelector('.cc-in'), out = el.querySelector('.cc-out'), meta = el.querySelector('.cc-meta'), eng = el.querySelector('.cc-eng'), ram = el.querySelector('.cc-ram');
    function run() {
      var r = check({ engine: eng.value, text: ta.value, ramGB: +ram.value || 0 });
      if (r.unknownFormat) { meta.textContent = ''; out.innerHTML = '<p class="cc-empty">I could not read any settings there. Pick the engine, and paste lines like <code>name = value</code>, a SHOW ALL or SHOW VARIABLES table, or mongod.conf.</p>'; return; }
      var name = { pg: 'PostgreSQL', my: 'MySQL', mo: 'MongoDB' }[r.engine];
      meta.textContent = name + ': read ' + r.settings + ' settings, ' + r.checked + ' of the ' + r.known + ' I check were present.';
      var cnt = { risk: 0, slow: 0, tip: 0 }; r.findings.forEach(function (x) { cnt[x.sev]++; });
      var lab = { risk: 'Risk', slow: 'Slow', tip: 'Tip' };
      out.innerHTML = (r.findings.length ? '<p class="cc-sum"><span class="qc-pill qc-risk">' + cnt.risk + ' risk</span> <span class="qc-pill qc-slow">' + cnt.slow + ' slow</span> <span class="qc-pill qc-tip">' + cnt.tip + ' tip</span></p>' :
        '<p class="cc-empty">Nothing flagged in the settings I check. That is not a full review: memory, disks and the workload matter as much as the settings.</p>') +
        r.findings.map(function (x) {
          return '<div class="qc-f qc-' + x.sev + '"><div class="qc-h"><span class="qc-tag">' + lab[x.sev] + '</span><b>' + esc(x.title) + '</b><code>' + esc(x.key) + ' = ' + esc(x.value) + '</code></div><p>' + esc(x.why) + '</p><p class="qc-fix"><b>Change:</b> ' + esc(x.fix) + '</p>' + (x.link ? '<a href="' + x.link + '">Why this matters →</a>' : '') + '</div>';
        }).join('') + (r.engine && !ram.value ? '<p class="cc-empty">Enter the server\'s memory to check the memory settings against it.</p>' : '');
      if (root.HDW_GOALS && r.findings.length) root.HDW_GOALS.done('config-check', 'run');
      if (root.HDW_GOALS && ram.value) root.HDW_GOALS.done('config-check', 'ram');
    }
    el.querySelector('.cc-go').addEventListener('click', run);
    Array.prototype.forEach.call(el.querySelectorAll('[data-ex]'), function (b) {
      b.addEventListener('click', function () { var k = b.getAttribute('data-ex'); ta.value = EX[k]; eng.value = k; run(); });
    });
    var pref = root.HDW_ENGINE && root.HDW_ENGINE.get(); if (pref) eng.value = pref;
    if (root.HDW_GOALS) root.HDW_GOALS.attach(el, 'config-check', [['run', 'Check a config, yours or an example'], ['ram', 'Add the server\'s memory and see the memory settings judged']]);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.configcheck'), mount);
})(typeof window !== 'undefined' ? window : globalThis);
