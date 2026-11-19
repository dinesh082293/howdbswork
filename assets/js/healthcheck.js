/* Health check report: reads the output of assets/health/health-*.{sql,js}
   and turns it into findings and tables. Runs in the browser only.
   HDW_HEALTH.analyze(text, {ramGB}) -> {engine, facts, findings, tables} */
(function (root) {
  var L = { sym: '../symptoms/index.html', pool: '../decisions/connection-pooling/index.html', backup: '../decisions/backup-restore/index.html',
    pg: '../postgresql/index.html', my: '../mysql/index.html', mo: '../mongodb/index.html', iso: '../isolation/index.html' };
  function parse(text) {
    var rows = [], engine = null;
    text.split(/\r?\n/).forEach(function (line) {
      if (!line.trim() || /^(psql|ERROR|LINE|\s*\^|mysql: \[Warning\])/.test(line)) return;
      var cols = line.indexOf('\t') >= 0 ? line.split('\t') : line.split('|');
      cols = cols.map(function (c) { return c.trim(); });
      if (cols[0] === 'engine') engine = cols[1];
      rows.push(cols);
    });
    return { engine: engine, rows: rows };
  }
  function F(sev, title, why, fix, link) { return { sev: sev, title: title, why: why, fix: fix, link: link }; }
  function size(b) { b = +b; if (!(b >= 0)) return ''; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return (b >= 100 || i === 0 ? b.toFixed(0) : b.toFixed(1)) + ' ' + u[i]; }
  function dur(s) { s = +s; if (!(s >= 0)) return 'never'; if (s < 120) return Math.round(s) + ' s'; if (s < 7200) return Math.round(s / 60) + ' min'; if (s < 172800) return (s / 3600).toFixed(1) + ' h'; return Math.round(s / 86400) + ' days'; }
  function num(n) { return (+n).toLocaleString('en-US'); }

  function analyze(text, opt) {
    opt = opt || {};
    var p = parse(text), e = p.engine, R = p.rows, f = [], T = {}, facts = {};
    if (!e) return { engine: null, findings: [], tables: {}, facts: {} };
    function all(k) { return R.filter(function (r) { return r[0] === k; }); }
    function one(k) { return all(k)[0]; }
    var settingsText = all('setting').map(function (r) { return r[1] + ' | ' + r[2] + (r[3] ? ' | ' + r[3] : ''); }).join('\n');
    if (e === 'mo') settingsText = all('setting').map(function (r) { return r[1] + ': ' + r[2]; }).join('\n');
    facts.version = (one('version') || [])[1];
    if (e === 'pg') {
      facts.uptime = +(one('uptime_s') || [])[1];
      var st = +(one('stats_since_s') || [])[1];
      var conns = all('conn'), total = conns.reduce(function (a, r) { return a + +r[2]; }, 0), maxc = +(one('max_conn') || [])[1];
      var idleTx = conns.filter(function (r) { return /idle in transaction/.test(r[1]); }).reduce(function (a, r) { return a + +r[2]; }, 0);
      facts.connections = total + (maxc ? ' of ' + maxc : '');
      if (maxc && total > 0.8 * maxc) f.push(F('risk', 'Connections at ' + Math.round(100 * total / maxc) + '% of the limit', total + ' of ' + maxc + ' are in use. The next deploy or traffic spike will be refused.', 'Find who holds them, and put a pooler in front.', L.pool));
      if (idleTx) f.push(F('slow', idleTx + ' session' + (idleTx > 1 ? 's' : '') + ' idle in a transaction', 'They hold locks and stop vacuum from removing dead rows while they sit there.', 'Find the code path that opens a transaction and waits; set idle_in_transaction_session_timeout.', L.sym + '#bloat'));
      var c = one('cache'); if (c) { var hit = +c[1] / Math.max(1, +c[1] + +c[2]); facts.cache = (100 * hit).toFixed(2) + '% of reads from shared buffers';
        if (+c[1] + +c[2] > 1e6 && hit < 0.95) f.push(F('slow', 'Only ' + (100 * hit).toFixed(1) + '% of reads come from the cache', 'The rest go to the OS cache or the disk. Often the hot data no longer fits in shared_buffers.', 'Check shared_buffers against memory, and look for scans of big tables.', L.sym + '#io')); }
      all('oldest_xact').forEach(function (r, i) { if (i === 0) facts.oldest = dur(r[2]); if (+r[2] > 3600) f.push(F('risk', 'A transaction has been open for ' + dur(r[2]), 'pid ' + r[1] + ' (' + r[3] + '): ' + (r[4] || '').slice(0, 90) + '. Vacuum cannot clean anything newer than it.', 'Find out what it is; end it with pg_terminate_backend(' + r[1] + ') if it is stuck.', L.sym + '#bloat')); });
      var x = one('xid_age'); if (x) { facts.xid = num(x[2]) + ' (' + x[1] + ')';
        if (+x[2] > 1.2e9) f.push(F('risk', 'Transaction ID age is ' + num(x[2]), 'At about 2.1 billion PostgreSQL stops accepting writes to protect itself. Anti-wraparound vacuum is behind.', 'Find what blocks vacuum (long transactions, stale slots, prepared transactions) and vacuum the oldest tables.', L.pg));
        else if (+x[2] > 5e8) f.push(F('slow', 'Transaction ID age is ' + num(x[2]), 'Autovacuum should be freezing old rows by now; watch that the number comes down.', 'Check the tables with the oldest relfrozenxid and whether autovacuum keeps up.', L.pg)); }
      T.tables = { head: ['Table', 'Size', 'Live rows', 'Dead rows', 'Last vacuum', 'Seq scans', 'Index scans'], rows: all('table').map(function (r) {
        var dead = +r[4], live = +r[3];
        if (dead > 100000 && dead > 0.2 * live) f.push(F('slow', r[1] + ': ' + Math.round(100 * dead / Math.max(1, live + dead)) + '% dead rows', num(dead) + ' dead against ' + num(live) + ' live; scans read the dead ones too. Last vacuum: ' + dur(r[5]) + ' ago.', 'Check what holds vacuum back, then lower autovacuum_vacuum_scale_factor for this table.', L.sym + '#bloat'));
        if (+r[6] > 1000 && +r[7] < +r[6] && +r[2] > 100 * 1048576) f.push(F('tip', r[1] + ' is mostly read by sequential scans', num(r[6]) + ' sequential scans against ' + num(r[7]) + ' index scans on ' + size(r[2]) + '.', 'Look in the top statements for queries on this table without a usable index.', L.sym + '#cpu'));
        return [r[1], size(r[2]), num(live), num(dead), dur(r[5]), num(r[6]), num(r[7])]; }) };
      var stmts = all('stmt'); if (stmts.length) T.stmts = { head: ['Calls', 'Total ms', 'Mean ms', 'Statement'], rows: stmts.map(function (r) { return [num(r[1]), num(r[2]), r[3], r[4]]; }) };
      else if (/shared_preload_libraries \| [^\n]*pg_stat_statements/.test(settingsText)) f.push(F('tip', 'pg_stat_statements is loaded but not created in this database', 'The library is loaded, but the view does not exist here, so the report cannot rank queries by total time.', 'Run CREATE EXTENSION pg_stat_statements; in this database.', L.sym + '#cpu'));
      all('invalid_index').forEach(function (r) { f.push(F('risk', 'Invalid index ' + r[1], 'A CREATE INDEX CONCURRENTLY failed and left it behind. It is updated on every write and never used.', 'DROP INDEX CONCURRENTLY ' + r[1] + '; then build it again.', L.pg)); });
      all('slot').forEach(function (r) { if (r[2] === 'f' && +r[3] > 1073741824) f.push(F('risk', 'Replication slot ' + r[1] + ' is inactive and holds ' + size(r[3]) + ' of WAL', 'Nothing reads from it, so WAL piles up until the disk is full.', 'If its consumer is gone for good, pg_drop_replication_slot(\'' + r[1] + '\').', L.sym + '#disk')); });
      all('replica').forEach(function (r) { if (+r[4] > 30) f.push(F('slow', 'Replica ' + (r[1] || r[2]) + ' is ' + dur(r[4]) + ' behind', 'Reads there are stale, and a failover to it would lose that much.', 'See the replica lag symptom.', L.sym + '#lag')); });
      var sb = one('standby'); if (sb && sb[1] === 't') facts.role = 'standby, ' + dur(sb[2]) + ' behind'; else facts.role = 'primary';
      if (st > 0) facts.statsAge = dur(st);
    }
    if (e === 'my') {
      var s = {}; all('status').forEach(function (r) { s[r[1].toLowerCase()] = +r[2]; });
      facts.uptime = s.uptime;
      var mx = all('setting').filter(function (r) { return r[1].toLowerCase() === 'max_connections'; })[0];
      facts.connections = s.threads_connected + (mx ? ' of ' + mx[2] : '') + ', ' + s.threads_running + ' running';
      if (mx && s.threads_connected > 0.8 * +mx[2]) f.push(F('risk', 'Connections at ' + Math.round(100 * s.threads_connected / +mx[2]) + '% of the limit', s.threads_connected + ' of ' + mx[2] + '.', 'Find who holds them; pool in the app or with ProxySQL.', L.pool));
      if (s.innodb_buffer_pool_read_requests > 1e6) { var miss = s.innodb_buffer_pool_reads / s.innodb_buffer_pool_read_requests; facts.cache = (100 * (1 - miss)).toFixed(2) + '% of page reads from the buffer pool';
        if (miss > 0.01) f.push(F('slow', (100 * miss).toFixed(1) + '% of page reads go to disk', 'The working set does not fit in the buffer pool, or something scans large tables.', 'Compare innodb_buffer_pool_size with memory and the hot data size.', L.sym + '#io')); }
      var h = one('history_len'); if (h) { facts.history = num(h[1]);
        if (+h[1] > 1e6) f.push(F('risk', 'History list length is ' + num(h[1]), 'Purge is far behind; reads walk long version chains and undo grows.', 'Find the oldest transaction below and end it.', L.sym + '#bloat'));
        else if (+h[1] > 1e5) f.push(F('slow', 'History list length is ' + num(h[1]), 'Old row versions are waiting for purge.', 'Look for long-running transactions.', L.sym + '#bloat')); }
      all('oldest_xact').forEach(function (r, i) { if (i === 0) facts.oldest = dur(r[2]); if (+r[2] > 3600) f.push(F('risk', 'A transaction has been open for ' + dur(r[2]), 'Thread ' + r[1] + ': ' + (r[4] || '(idle)').slice(0, 90) + '. Purge cannot remove versions it might need.', 'Find it; KILL ' + r[1] + ' if it is stuck.', L.sym + '#bloat')); });
      if (s.innodb_deadlocks > 0) facts.deadlocks = num(s.innodb_deadlocks);
      if (s.uptime && s.created_tmp_disk_tables / s.uptime > 10) f.push(F('tip', num(Math.round(s.created_tmp_disk_tables / s.uptime)) + ' temporary tables a second go to disk', 'Sorts and GROUP BYs that do not fit in memory.', 'Find them in the top statements; an index on the GROUP BY or ORDER BY columns often removes the sort.', L.my));
      T.tables = { head: ['Table', 'Size', 'Rows (estimate)', 'Free inside'], rows: all('table').map(function (r) { return [r[1], size(r[2]), num(r[3]), size(r[4])]; }) };
      var sm = all('stmt'); if (sm.length) T.stmts = { head: ['Calls', 'Total ms', 'Mean ms', 'Statement'], rows: sm.map(function (r) { return [num(r[1]), num(r[2]), r[3], r[4]]; }) };
      all('replica').forEach(function (r) { if (r[2] !== 'ON' || r[3]) f.push(F('risk', 'Replication applier ' + (r[1] || 'default') + ' is ' + r[2], r[3] || 'The applier is not running.', 'SHOW REPLICA STATUS for the full error.', L.sym + '#lag')); });
    }
    if (e === 'mo') {
      facts.uptime = +(one('uptime_s') || [])[1];
      var cur = all('conn').filter(function (r) { return r[1] === 'current'; })[0], av = all('conn').filter(function (r) { return r[1] === 'available'; })[0];
      if (cur) facts.connections = num(cur[2]) + ' (' + num(av ? av[2] : 0) + ' more available)';
      var w = one('wt_cache'); if (w) { facts.cache = size(w[1]) + ' of ' + size(w[2]) + ' cache used, ' + size(w[3]) + ' dirty';
        if (+w[3] > 0.2 * +w[2]) f.push(F('slow', 'Dirty data is over 20% of the WiredTiger cache', 'Application threads start evicting pages themselves, and latency spikes.', 'Check write volume and disk speed.', L.mo)); }
      var ow = one('oplog_window_s'); if (ow) { facts.oplog = dur(ow[1]);
        if (+ow[1] < 86400) f.push(F('slow', 'The oplog window is ' + dur(ow[1]), 'A secondary down longer than this needs a full resync.', 'Grow the oplog (replSetResizeOplog) to cover at least a day, more for maintenance windows.', L.mo)); }
      else f.push(F('risk', 'No replica set status', 'Either this is not a replica set, or the user cannot read it. Without a replica set there is no failover and no oplog.', 'Run a three-member replica set.', L.mo));
      all('member').forEach(function (r) { if (+r[3] > 30) f.push(F('slow', r[1] + ' is ' + dur(r[3]) + ' behind', 'Majority writes may wait on it, and reads from it are stale.', 'See the replica lag symptom.', L.sym + '#lag')); if (!/PRIMARY|SECONDARY|ARBITER/.test(r[2])) f.push(F('risk', r[1] + ' is ' + r[2], 'The member is not healthy.', 'rs.status() for details.', L.mo)); });
      all('long_op').forEach(function (r) { f.push(F('slow', 'An operation has run for ' + dur(r[2]), 'opid ' + r[1] + ', ' + r[3] + ' on ' + r[4] + '.', 'db.currentOp({opid: ' + r[1] + '}) to see it; db.killOp if it is stuck.', L.sym + '#cpu')); });
      T.tables = { head: ['Collection', 'Size on disk with indexes', 'Documents'], rows: all('table').map(function (r) { return [r[1], size(r[2]), num(r[3])]; }) };
    }
    var un = all('unused_index');
    if (un.length) {
      T.unused = { head: ['Index', 'On', 'Size'], rows: un.map(function (r) { return [r[1], r[2], +r[3] ? size(r[3]) : '']; }) };
      var tot = un.reduce(function (a, r) { return a + (+r[3] || 0); }, 0);
      f.push(F('tip', un.length + ' index' + (un.length > 1 ? 'es have' : ' has') + ' not been used' + (tot ? ', ' + size(tot) + ' in total' : ''), 'Every unused index still costs a write on every insert and update, and space in memory. Usage counts reset at restart' + (facts.uptime ? ' (up ' + dur(facts.uptime) + ')' : '') + ', and replicas keep their own counts.', 'Confirm on every replica and over a full business cycle, then drop them one at a time.', L.sym + '#commits'));
    }
    if (settingsText && root.HDW_CONFIG) {
      var cc = root.HDW_CONFIG.check({ engine: e, text: settingsText, ramGB: opt.ramGB || 0 });
      cc.findings.forEach(function (x) { f.push(F(x.sev, x.title, x.why + ' (' + x.key + ' = ' + x.value + ')', x.fix, x.link)); });
    }
    var order = { risk: 0, slow: 1, tip: 2 };
    f.sort(function (a, b) { return order[a.sev] - order[b.sev]; });
    return { engine: e, facts: facts, findings: f, tables: T };
  }
  var api = { analyze: analyze, parse: parse };
  root.HDW_HEALTH = api;
  if (typeof module !== 'undefined') module.exports = api;

  if (typeof document === 'undefined') return;
  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function table(t) { return '<div style="overflow-x:auto"><table class="famtable hc-t"><thead><tr>' + t.head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + t.rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>'; }
  function mount(el) {
    var ta = el.querySelector('.hc-in'), out = el.querySelector('.hc-out'), ram = el.querySelector('.hc-ram');
    function run() {
      var r = analyze(ta.value, { ramGB: +ram.value || 0 });
      if (!r.engine) { out.innerHTML = '<p class="cc-empty">I could not find the report there. Paste the whole output of the script; its first line is <code>engine|pg</code>, <code>engine	my</code> or <code>engine|mo</code>.</p>'; return; }
      var name = { pg: 'PostgreSQL', my: 'MySQL', mo: 'MongoDB' }[r.engine], fx = r.facts, lab = { risk: 'Risk', slow: 'Slow', tip: 'Tip' };
      var cnt = { risk: 0, slow: 0, tip: 0 }; r.findings.forEach(function (x) { cnt[x.sev]++; });
      var facts = [['Engine', name + ' ' + (fx.version || '')], ['Up for', fx.uptime ? dur(fx.uptime) : ''], ['Role', fx.role], ['Connections', fx.connections], ['Cache', fx.cache], ['Oldest open transaction', fx.oldest], ['History list', fx.history], ['Transaction ID age', fx.xid], ['Oplog window', fx.oplog]].filter(function (x) { return x[1]; });
      out.innerHTML = '<div class="hc-facts">' + facts.map(function (x) { return '<div><span>' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b></div>'; }).join('') + '</div>' +
        '<h3 class="hc-h">What I would look at <span class="qc-pill qc-risk">' + cnt.risk + ' risk</span> <span class="qc-pill qc-slow">' + cnt.slow + ' slow</span> <span class="qc-pill qc-tip">' + cnt.tip + ' tip</span></h3>' +
        (r.findings.length ? r.findings.map(function (x) { return '<div class="qc-f qc-' + x.sev + '"><div class="qc-h"><span class="qc-tag">' + lab[x.sev] + '</span><b>' + esc(x.title) + '</b></div><p>' + esc(x.why) + '</p><p class="qc-fix"><b>Next:</b> ' + esc(x.fix) + '</p>' + (x.link ? '<a href="' + x.link + '">Why this matters →</a>' : '') + '</div>'; }).join('') : '<p class="cc-empty">Nothing flagged. That covers what this script reads, not everything that can go wrong.</p>') +
        (r.tables.tables && r.tables.tables.rows.length ? '<h3 class="hc-h">Biggest tables</h3>' + table(r.tables.tables) : '') +
        (r.tables.stmts ? '<h3 class="hc-h">Statements by total time</h3>' + table(r.tables.stmts) : '') +
        (r.tables.unused ? '<h3 class="hc-h">Indexes not used since the statistics were reset</h3>' + table(r.tables.unused) : '');
      if (root.HDW_GOALS) root.HDW_GOALS.done('health-check', 'run');
    }
    el.querySelector('.hc-go').addEventListener('click', run);
    var sample = el.querySelector('.hc-sample');
    if (sample) sample.addEventListener('click', function () { ta.value = el.querySelector('#hcSample').textContent.trim(); run(); });
    if (root.HDW_GOALS) root.HDW_GOALS.attach(el.querySelector('.hc-go').parentNode, 'health-check', [['run', 'Read a report: the sample or your own']]);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.healthcheck'), mount);
})(typeof window !== 'undefined' ? window : globalThis);
