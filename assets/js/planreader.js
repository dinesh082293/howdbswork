/* EXPLAIN reader: paste a PostgreSQL EXPLAIN (ANALYZE, BUFFERS) plan, a MySQL
   EXPLAIN ANALYZE tree, or a MongoDB explain("executionStats") document, and
   see the plan as a tree with the costly steps marked and explained.
   HDW_PLAN.read(text) -> {engine, root, nodes, findings, analyzed, total}
   Runs in the browser; nothing is sent anywhere. */
(function (root) {
  var L = { plan: '../reference/index.html', q: '../queries/index.html', sym: '../symptoms/index.html', pg: '../postgresql/index.html', mo: '../mongodb/index.html', my: '../mysql/index.html' };
  function F(sev, title, why, fix, node, link) { return { sev: sev, title: title, why: why, fix: fix, node: node, link: link || L.plan }; }
  function n(x) { return x == null ? null : +x; }
  function fmt(x) { x = +x; return x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e4 ? Math.round(x / 1e3) + 'k' : x.toLocaleString('en-US'); }
  function ms(x) { return x >= 1000 ? (x / 1000).toFixed(2) + ' s' : x >= 10 ? x.toFixed(0) + ' ms' : x.toFixed(2) + ' ms'; }

  /* ---------- PostgreSQL text ---------- */
  function readPg(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.replace(/^\s*"|"\s*$/g, '').replace(/\s+\+$/, ''); })
      .filter(function (l) { return l.trim() && !/^\s*QUERY PLAN\s*$/.test(l) && !/^[-\s]+$/.test(l) && !/^\(\d+ rows?\)$/.test(l.trim()); });
    var stack = [], rootNode = null, all = [], extra = {};
    lines.forEach(function (line) {
      var m, ind = line.match(/^\s*/)[0].length;
      if ((m = line.match(/^\s*(Planning Time|Execution Time|Planning time|Execution time):\s*([\d.]+)\s*ms/))) { extra[/Exec/i.test(m[1]) ? 'exec' : 'plan'] = +m[2]; return; }
      if ((m = line.match(/^\s*JIT:/))) { extra.jit = true; return; }
      if ((m = line.match(/^\s*Timing:.*Total ([\d.]+) ms/))) { extra.jitMs = +m[1]; return; }
      var isNode = /^\s*->\s+/.test(line) || (!rootNode && /\(cost=|\(actual/.test(line));
      if (isNode) {
        var body = line.replace(/^\s*->\s+/, ''), name = body.replace(/\s+\((cost|actual)[\s\S]*$/, '').trim();
        var node = { name: name, kids: [], detail: [], depth: 0, ind: line.indexOf('->') >= 0 ? line.indexOf('->') : ind };
        if ((m = body.match(/cost=([\d.]+)\.\.([\d.]+) rows=(\d+)/))) { node.cost = +m[2]; node.est = +m[3]; }
        if ((m = body.match(/actual time=([\d.]+)\.\.([\d.]+) rows=([\d.]+) loops=(\d+)/))) { node.first = +m[1]; node.time = +m[2]; node.rows = +m[3]; node.loops = +m[4]; }
        else if ((m = body.match(/actual rows=([\d.]+) loops=(\d+)/))) { node.rows = +m[1]; node.loops = +m[2]; }
        else if (/never executed/.test(body)) node.never = true;
        while (stack.length && stack[stack.length - 1].ind >= node.ind) stack.pop();
        if (stack.length) { stack[stack.length - 1].kids.push(node); node.depth = stack.length; } else rootNode = node;
        stack.push(node); all.push(node);
      } else if (stack.length) {
        var d = line.trim(), cur = stack[stack.length - 1];
        // detail lines belong to the deepest node whose indent is less than this line's
        for (var i = stack.length - 1; i >= 0; i--) { if (stack[i].ind < ind) { cur = stack[i]; break; } }
        cur.detail.push(d);
        if ((m = d.match(/^Rows Removed by (Filter|Join Filter|Index Recheck): (\d+)/))) cur.removed = (cur.removed || 0) + +m[2];
        if ((m = d.match(/^Sort Method: (.*?)\s+(?:Disk|Memory): (\d+)kB/))) { cur.sortMethod = m[1]; cur.sortDisk = /Disk/.test(d) ? +m[2] : 0; }
        if ((m = d.match(/Batches: (\d+)/))) cur.batches = +m[1];
        if ((m = d.match(/^Heap Fetches: (\d+)/))) cur.heapFetches = +m[1];
        if ((m = d.match(/^Buffers: (.*)/))) { var h = m[1].match(/shared hit=(\d+)/), r = m[1].match(/read=(\d+)/), t = m[1].match(/temp (?:read=\d+ )?written=(\d+)/); cur.hit = h ? +h[1] : 0; cur.read = r ? +r[1] : 0; if (t) cur.tempWritten = +t[1]; }
        if (/lossy=/.test(d)) cur.lossy = true;
        if ((m = d.match(/^Workers Launched: (\d+)/))) cur.workers = +m[1];
      }
    });
    if (!rootNode) return null;
    return { engine: 'pg', root: rootNode, nodes: all, extra: extra, analyzed: all.some(function (x) { return x.time != null || x.rows != null; }) };
  }

  /* ---------- MySQL EXPLAIN ANALYZE / FORMAT=TREE ---------- */
  function readMy(text) {
    var all = [], stack = [], rootNode = null, m;
    text.split(/\r?\n/).forEach(function (line) {
      line = line.replace(/^\|\s?/, '').replace(/\s*\|\s*$/, '');
      var at = line.indexOf('-> ');
      if (at < 0) return;
      var body = line.slice(at + 3), name = body.replace(/\s+\((cost|actual)[\s\S]*$/, '').trim();
      var node = { name: name, kids: [], detail: [], ind: at };
      if ((m = body.match(/\(cost=([\d.e+]+)(?:\.\.([\d.e+]+))? rows=([\d.e+]+)\)/))) { node.cost = +(m[2] || m[1]); node.est = +m[3]; }
      if ((m = body.match(/\(actual time=([\d.]+)\.\.([\d.]+) rows=([\d.e+]+) loops=(\d+)\)/))) { node.first = +m[1]; node.time = +m[2]; node.rows = +m[3]; node.loops = +m[4]; }
      if (/\(never executed\)/.test(body)) node.never = true;
      while (stack.length && stack[stack.length - 1].ind >= at) stack.pop();
      if (stack.length) { stack[stack.length - 1].kids.push(node); node.depth = stack.length; } else { rootNode = rootNode || node; node.depth = 0; }
      stack.push(node); all.push(node);
    });
    if (!rootNode) return null;
    return { engine: 'my', root: rootNode, nodes: all, extra: {}, analyzed: all.some(function (x) { return x.time != null; }) };
  }

  /* ---------- MongoDB explain JSON ---------- */
  function readMo(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) {
      try { o = JSON.parse(text.replace(/(ObjectId|ISODate|NumberLong|NumberInt|Timestamp|NumberDecimal)\(([^)]*)\)/g, '$2').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/'/g, '"')); } catch (e2) { return null; }
    }
    if (!o || !(o.queryPlanner || o.executionStats || o.stages)) return null;
    var qp = o.queryPlanner || (o.stages && o.stages[0] && o.stages[0].$cursor && o.stages[0].$cursor.queryPlanner) || {};
    var es = o.executionStats || (o.stages && o.stages[0] && o.stages[0].$cursor && o.stages[0].$cursor.executionStats) || null;
    var wp = qp.winningPlan || {}; if (wp.queryPlan) wp = wp.queryPlan;
    var classic = es && es.executionStages && /^[A-Z_]+$/.test(es.executionStages.stage || '') ? es.executionStages : null;
    var all = [];
    function build(s, depth) {
      if (!s) return null;
      var node = { name: s.stage + (s.indexName ? ' ' + s.indexName : '') + (s.keyPattern && !s.indexName ? ' ' + JSON.stringify(s.keyPattern) : ''), stage: s.stage, kids: [], detail: [], depth: depth };
      if (s.nReturned != null) node.rows = s.nReturned;
      if (s.executionTimeMillisEstimate != null) node.time = s.executionTimeMillisEstimate;
      if (s.docsExamined != null) node.docs = s.docsExamined;
      if (s.keysExamined != null) node.keys = s.keysExamined;
      if (s.usedDisk) node.usedDisk = true;
      if (s.filter) node.detail.push('filter: ' + JSON.stringify(s.filter).slice(0, 160));
      if (s.indexBounds) node.detail.push('bounds: ' + JSON.stringify(s.indexBounds).slice(0, 160));
      if (s.sortPattern) node.detail.push('sort: ' + JSON.stringify(s.sortPattern));
      all.push(node);
      var kids = s.inputStages || (s.inputStage ? [s.inputStage] : []);
      kids.forEach(function (k) { var c = build(k, depth + 1); if (c) node.kids.push(c); });
      return node;
    }
    var rootNode = build(classic || wp, 0);
    if (!rootNode) return null;
    return { engine: 'mo', root: rootNode, nodes: all, analyzed: !!es,
      extra: es ? { exec: es.executionTimeMillis, nReturned: es.nReturned, docs: es.totalDocsExamined, keys: es.totalKeysExamined } : {} };
  }

  function detect(text) {
    var t = text.trim();
    if (/^[\[{]/.test(t) || /queryPlanner|executionStats|winningPlan/.test(t)) return 'mo';
    if (/^\s*\|?\s*-> /m.test(t) && /\(cost=[\d.e+]+(\.\.[\d.e+]+)? rows=[\d.e+]+\)/.test(t)) return 'my';
    if (/\(cost=[\d.]+\.\.[\d.]+ rows=\d+ width=\d+\)/.test(t)) return 'pg';
    if (/^\s*-> /m.test(t)) return 'my';
    return null;
  }

  /* ---------- analysis ---------- */
  function analyze(p) {
    var f = [], total = 0;
    function walk(node, fn, parent) { fn(node, parent); node.kids.forEach(function (k) { walk(k, fn, node); }); }
    // inclusive and self time
    walk(p.root, function (x, parent) { x.incl = x.time != null ? x.time * (p.engine === 'mo' ? 1 : (x.loops || 1)) : null; x.limited = !!(parent && (parent.limited || /^Limit\b/.test(parent.name) || /limit input/.test(parent.name))); });
    walk(p.root, function (x) {
      if (x.incl == null) return;
      var kids = x.kids.reduce(function (a, k) { return a + (k.incl || 0); }, 0);
      x.self = Math.max(0, x.incl - kids);
    });
    total = p.extra && p.extra.exec != null ? p.extra.exec : (p.root.incl || 0);
    if (!p.analyzed) {
      f.push(F('tip', 'This plan has estimates only', 'Without ANALYZE the plan shows what the planner expected, not what happened. Most problems show up as a gap between the two.',
        p.engine === 'pg' ? 'Run EXPLAIN (ANALYZE, BUFFERS) on a copy or inside BEGIN ... ROLLBACK for writes.' : p.engine === 'my' ? 'Run EXPLAIN ANALYZE (MySQL 8.0.18 and later).' : 'Use .explain("executionStats").', null));
    }
    var worst = null;
    p.nodes.forEach(function (x) { if (x.self != null && (!worst || x.self > worst.self)) worst = x; });
    if (worst && total > 1 && worst.self > 0.3 * total && worst !== p.root) { worst.hot = true; }
    else if (worst && total > 1 && worst.self > 0.3 * total) worst.hot = true;
    if (p.engine === 'mo') return analyzeMo(p, f, total);
    p.nodes.forEach(function (x) {
      var nm = x.name, loops = x.loops || 1;
      var actualPer = x.rows, est = x.est;
      if (x.never) return;
      var stopsEarly = /^Limit\b/.test(nm) || /limit input/.test(nm) || x.limited;
      if (actualPer != null && est != null && Math.max(actualPer, est) >= 100 && !(stopsEarly && actualPer < est)) {
        var ratio = actualPer > est ? actualPer / Math.max(1, est) : est / Math.max(1, actualPer);
        if (ratio >= 10) f.push(F(ratio >= 100 ? 'slow' : 'tip', 'Row estimate off by ' + fmt(Math.round(ratio)) + '× at ' + short(nm),
          'The planner expected ' + fmt(est) + ' rows and got ' + fmt(actualPer) + (loops > 1 ? ' (per loop)' : '') + '. Join order, join method and index choice above this step were picked for the wrong size.',
          p.engine === 'pg' ? 'ANALYZE the table. If columns are correlated, CREATE STATISTICS on them. Check that the condition can use the statistics (no functions or casts on the column).' : 'ANALYZE TABLE; consider a histogram (ANALYZE TABLE t UPDATE HISTOGRAM ON col) for skewed columns.', x, L.sym + '#plan'));
      }
      var scan = p.engine === 'pg' ? /^(Parallel )?Seq Scan on/.test(nm) : /^Table scan on/.test(nm);
      if (scan) {
        var returned = (x.rows || 0) * loops, removed = (x.removed || 0) * loops;
        if (removed > 1000 && removed > 10 * Math.max(1, returned)) f.push(F('slow', 'Full scan keeps ' + fmt(returned) + ' of ' + fmt(returned + removed) + ' rows at ' + short(nm),
          'Every row is read and almost all are thrown away by the filter. Cost grows with the table, not with the answer.',
          'An index on the filtered columns, most selective (equality) columns first.', x, L.q));
        else if (p.engine === 'my' && x.rows != null && x.rows * loops > 10000) f.push(F('slow', 'Full table scan of ' + fmt(x.rows * loops) + ' rows at ' + short(nm), 'MySQL reads the whole table here.', 'Check the WHERE and JOIN columns for a usable index; look at the Filter step above it for what is thrown away.', x, L.q));
        if (loops > 100) f.push(F('risk', 'A full scan runs ' + fmt(loops) + ' times at ' + short(nm), 'It is the inner side of a nested loop, so the whole table is read once per outer row.', 'Index the join column on this table, or make the join a hash join (often a sign the estimate above is wrong).', x, L.q));
      }
      if (p.engine === 'my' && /^Filter:/.test(nm) && x.kids[0] && x.kids[0].rows != null && x.rows != null) {
        var inr = x.kids[0].rows * (x.kids[0].loops || 1), outr = x.rows * loops;
        if (inr > 1000 && inr > 10 * Math.max(1, outr)) f.push(F('slow', 'A filter keeps ' + fmt(outr) + ' of ' + fmt(inr) + ' rows', 'The rows are read first and thrown away afterwards.', 'An index that covers the filter columns lets MySQL read only matching rows.', x, L.q));
      }
      if (x.sortDisk) f.push(F('slow', 'Sort spilled ' + fmt(x.sortDisk) + ' kB to disk', 'The sort did not fit in work_mem, so it wrote temporary files (' + x.sortMethod + ').', 'An index in the ORDER BY order avoids the sort. Otherwise raise work_mem for this session or query.', x, L.pg));
      if (x.batches > 1) f.push(F('slow', 'Hash used ' + x.batches + ' batches', 'The hash table did not fit in memory and was split, with temporary files.', 'Raise work_mem (or hash_mem_multiplier) for this query, or join fewer rows.', x, L.pg));
      if (x.heapFetches > 1000 && /Index Only Scan/.test(nm)) f.push(F('tip', 'Index-only scan fetched ' + fmt(x.heapFetches) + ' rows from the table', 'Pages not marked all-visible must still be read from the table, so the index-only scan is not index-only.', 'VACUUM the table (or let autovacuum run more often) so the visibility map is current.', x, L.pg));
      if (x.lossy) f.push(F('tip', 'Bitmap became lossy at ' + short(nm), 'The bitmap did not fit in work_mem, so whole pages are rechecked.', 'Raise work_mem for this query.', x, L.pg));
      if (/^Nested Loop/.test(nm) && x.kids[1] && (x.kids[1].loops || 1) > 10000 && x.incl > 0.3 * total && total > 10) f.push(F('slow', 'Nested loop with ' + fmt(x.kids[1].loops) + ' inner lookups', 'Each outer row looks up the inner side again; at this many rows a hash join is usually cheaper.', 'Check the row estimate on the outer side; a wrong estimate is the usual reason for this choice.', x, L.q));
      if (x.read != null && x.read > 10000 && x.read > x.hit && !x.kids.length) f.push(F('tip', fmt(x.read) + ' pages read from outside shared buffers at ' + short(nm), 'About ' + fmt(Math.round(x.read * 8 / 1024)) + ' MB came from the OS cache or the disk. A second run may be much faster.', 'Compare a warm run. If it stays cold, the working set does not fit in memory.', x, L.sym + '#io'));
      if (p.engine === 'my' && /^Sort:/.test(nm) && x.rows != null && x.kids[0] && (x.kids[0].rows || 0) * (x.kids[0].loops || 1) > 10000) f.push(F('tip', 'Sorts ' + fmt(x.kids[0].rows * (x.kids[0].loops || 1)) + ' rows', 'The rows are sorted after they are read (a filesort).', 'An index in the ORDER BY order lets MySQL read rows already sorted and stop at the LIMIT.', x, L.q));
    });
    if (p.extra && p.extra.jitMs && total && p.extra.jitMs > 0.2 * total) f.push(F('tip', 'JIT took ' + ms(p.extra.jitMs) + ' of ' + ms(total), 'Compiling the query cost more than it saved. Common for short queries that the planner thought were expensive.', 'SET jit = off for this workload, or raise jit_above_cost.', null, L.pg));
    if (worst && worst.hot && total > 1) f.unshift(F(worst.self > 0.6 * total ? 'slow' : 'tip', 'Most of the time is in ' + short(worst.name), ms(worst.self) + ' of ' + ms(total) + ' (' + Math.round(100 * worst.self / total) + '%) is spent in this step itself.', 'Start here. The other findings below say why it may be slow.', worst));
    return finish(p, f, total);
  }
  function analyzeMo(p, f, total) {
    var e = p.extra || {};
    p.nodes.forEach(function (x) {
      if (x.stage === 'COLLSCAN') f.push(F('slow', 'Collection scan', 'Every document is read' + (x.docs != null ? ' (' + fmt(x.docs) + ' here)' : '') + '. Cost grows with the collection, not the result.', 'Create an index on the filtered fields: equality fields first, then sort fields, then range fields (the ESR rule).', x, L.mo));
      if (x.stage === 'SORT') f.push(F(x.usedDisk ? 'slow' : 'tip', x.usedDisk ? 'Blocking sort spilled to disk' : 'Blocking sort in memory', 'All matching documents are collected and sorted before the first one is returned.', 'Add the sort fields to the index, after the equality fields.', x, L.mo));
      if (x.stage === 'FETCH' && x.docs != null && x.rows != null && x.docs > 1000 && x.docs > 10 * Math.max(1, x.rows)) f.push(F('slow', 'Fetched ' + fmt(x.docs) + ' documents to return ' + fmt(x.rows), 'The index narrowed the search, but a filter after the fetch throws most documents away.', 'Add the filtered field to the index so it is checked before the fetch.', x, L.mo));
    });
    if (e.docs != null && e.nReturned != null && e.docs > 1000 && e.docs > 10 * Math.max(1, e.nReturned)) f.unshift(F('slow', 'Examined ' + fmt(e.docs) + ' documents to return ' + fmt(e.nReturned), 'A ratio far above 1 means the query reads much more than it needs.', 'Look for the COLLSCAN or the FETCH filter below; an index that matches the query shape brings the ratio near 1.', null, L.mo));
    if (e.keys != null && e.nReturned != null && e.keys > 1000 && e.keys > 10 * Math.max(1, e.nReturned)) f.push(F('tip', 'Examined ' + fmt(e.keys) + ' index keys to return ' + fmt(e.nReturned), 'The index is used, but a range on an early field makes it walk many keys.', 'Put equality fields before range fields in the index.', null, L.mo));
    return finish(p, f, e.exec != null ? e.exec : total);
  }
  function short(nm) { return nm.length > 60 ? nm.slice(0, 57) + '…' : nm; }
  function finish(p, f, total) {
    var order = { risk: 0, slow: 1, tip: 2 }, first = f[0] && /^Most of the time/.test(f[0].title) ? f.shift() : null;
    f.sort(function (a, b) { return order[a.sev] - order[b.sev]; });
    if (first) f.unshift(first);
    // one finding per node and title kind is enough
    var seen = {}; f = f.filter(function (x) { var k = x.title; if (seen[k]) return false; seen[k] = 1; return true; });
    return { engine: p.engine, root: p.root, nodes: p.nodes, findings: f, analyzed: p.analyzed, total: total, extra: p.extra };
  }
  function read(text, engine) {
    engine = engine && engine !== 'auto' ? engine : detect(text || '');
    var p = engine === 'pg' ? readPg(text) : engine === 'my' ? readMy(text) : engine === 'mo' ? readMo(text) : null;
    if (!p) return { engine: engine, root: null, nodes: [], findings: [], unreadable: true };
    return analyze(p);
  }
  var api = { read: read, detect: detect };
  root.HDW_PLAN = api;
  if (typeof module !== 'undefined') module.exports = api;

  /* ---------- page UI ---------- */
  if (typeof document === 'undefined') return;
  var EX = {
    pg: "Limit  (cost=0.00..2041.00 rows=20 width=48) (actual time=58.112..58.120 rows=20 loops=1)\n  Buffers: shared hit=1203 read=6170\n  ->  Sort  (cost=0.00..2041.00 rows=20 width=48) (actual time=58.110..58.114 rows=20 loops=1)\n        Sort Key: created_at DESC\n        Sort Method: top-N heapsort  Memory: 27kB\n        Buffers: shared hit=1203 read=6170\n        ->  Seq Scan on orders  (cost=0.00..20406.00 rows=95 width=48) (actual time=0.031..57.600 rows=4870 loops=1)\n              Filter: (customer_id = 4242)\n              Rows Removed by Filter: 995130\n              Buffers: shared hit=1203 read=6170\nPlanning Time: 0.140 ms\nExecution Time: 58.161 ms",
    my: "-> Limit: 20 row(s)  (cost=101225 rows=20) (actual time=412..412 rows=20 loops=1)\n    -> Sort: orders.created_at DESC, limit input to 20 row(s) per chunk  (cost=101225 rows=997116) (actual time=412..412 rows=20 loops=1)\n        -> Filter: (orders.customer_id = 4242)  (cost=101225 rows=99712) (actual time=0.9..410 rows=4870 loops=1)\n            -> Table scan on orders  (cost=101225 rows=997116) (actual time=0.06..355 rows=1000000 loops=1)",
    mo: '{"queryPlanner":{"winningPlan":{"stage":"SORT","sortPattern":{"created_at":-1},"inputStage":{"stage":"COLLSCAN","filter":{"customer_id":{"$eq":4242}}}}},"executionStats":{"nReturned":20,"executionTimeMillis":436,"totalKeysExamined":0,"totalDocsExamined":1000000,"executionStages":{"stage":"SORT","nReturned":20,"executionTimeMillisEstimate":430,"sortPattern":{"created_at":-1},"usedDisk":false,"inputStage":{"stage":"COLLSCAN","nReturned":4870,"executionTimeMillisEstimate":410,"docsExamined":1000000,"filter":{"customer_id":{"$eq":4242}}}}}}'
  };
  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function mount(el) {
    el.innerHTML = '<div class="cc-row"><label>Engine <select class="pr-eng"><option value="auto">Detect it</option><option value="pg">PostgreSQL</option><option value="my">MySQL</option><option value="mo">MongoDB</option></select></label>' +
      '<span class="cc-ex"><span class="kicker">Examples</span><button type="button" data-ex="pg">PostgreSQL</button><button type="button" data-ex="my">MySQL</button><button type="button" data-ex="mo">MongoDB</button></span></div>' +
      '<textarea class="cc-in pr-in" rows="12" spellcheck="false" aria-label="Plan to read" placeholder="Paste EXPLAIN (ANALYZE, BUFFERS) output, MySQL EXPLAIN ANALYZE, or explain(&quot;executionStats&quot;) JSON"></textarea>' +
      '<div class="cc-row"><button type="button" class="labbtn pr-go">Read the plan</button><span class="cc-meta pr-meta"></span></div><div class="pr-out" aria-live="polite"></div>';
    var ta = el.querySelector('.pr-in'), out = el.querySelector('.pr-out'), eng = el.querySelector('.pr-eng'), meta = el.querySelector('.pr-meta');
    function tree(r) {
      var tot = r.total || 0;
      function node(x) {
        var share = tot && x.self != null ? Math.min(100, 100 * x.self / tot) : 0;
        var stats = [];
        if (x.time != null && r.engine !== 'mo') stats.push(ms(x.time) + (x.loops > 1 ? ' × ' + fmt(x.loops) + ' loops' : ''));
        if (x.time != null && r.engine === 'mo') stats.push('~' + ms(x.time));
        if (x.rows != null) stats.push(fmt(x.rows) + ' rows' + (x.est != null ? ' (expected ' + fmt(x.est) + ')' : ''));
        else if (x.est != null) stats.push('expected ' + fmt(x.est) + ' rows');
        if (x.removed) stats.push(fmt(x.removed) + ' removed');
        if (x.docs != null) stats.push(fmt(x.docs) + ' docs examined');
        if (x.keys != null) stats.push(fmt(x.keys) + ' keys examined');
        if (x.never) stats.push('never executed');
        return '<li class="' + (x.hot ? 'pr-hot' : '') + (x.flag ? ' pr-flag' : '') + '"><div class="pr-n"><b>' + esc(x.name) + '</b><span>' + esc(stats.join(' · ')) + '</span>' +
          (share ? '<i class="pr-bar" style="width:' + share.toFixed(1) + '%" title="' + share.toFixed(0) + '% of the time in this step"></i>' : '') +
          (x.detail.length ? '<small>' + x.detail.slice(0, 4).map(esc).join('<br>') + '</small>' : '') + '</div>' +
          (x.kids.length ? '<ul>' + x.kids.map(node).join('') + '</ul>' : '') + '</li>';
      }
      return '<ul class="pr-tree">' + node(r.root) + '</ul>';
    }
    function run() {
      var r = read(ta.value, eng.value);
      if (r.unreadable) { meta.textContent = ''; out.innerHTML = '<p class="cc-empty">I could not read a plan there. Paste the full output, including the first line of the plan.</p>'; return; }
      r.findings.forEach(function (x) { if (x.node) x.node.flag = true; });
      var name = { pg: 'PostgreSQL', my: 'MySQL', mo: 'MongoDB' }[r.engine], lab = { risk: 'Risk', slow: 'Slow', tip: 'Tip' };
      meta.textContent = name + ' plan, ' + r.nodes.length + ' step' + (r.nodes.length > 1 ? 's' : '') + (r.total ? ', ' + ms(r.total) + ' in total' : '') + '.';
      out.innerHTML = '<h3 class="hc-h">What I would look at</h3>' + (r.findings.length ? r.findings.map(function (x) {
        return '<div class="qc-f qc-' + x.sev + '"><div class="qc-h"><span class="qc-tag">' + lab[x.sev] + '</span><b>' + esc(x.title) + '</b></div><p>' + esc(x.why) + '</p><p class="qc-fix"><b>Try:</b> ' + esc(x.fix) + '</p><a href="' + x.link + '">Why this matters →</a></div>';
      }).join('') : '<p class="cc-empty">Nothing stands out. The estimates match and no step dominates.</p>') +
        '<h3 class="hc-h">The plan, as a tree</h3><p class="cc-meta">Read it from the innermost step outward: data flows up. The bar shows the share of time spent in each step itself.</p>' + tree(r);
      if (root.HDW_GOALS) { root.HDW_GOALS.done('plan-reader', 'read'); if (r.findings.some(function (x) { return /^Most of the time/.test(x.title); })) root.HDW_GOALS.done('plan-reader', 'hot'); }
    }
    el.querySelector('.pr-go').addEventListener('click', run);
    Array.prototype.forEach.call(el.querySelectorAll('[data-ex]'), function (b) { b.addEventListener('click', function () { var k = b.getAttribute('data-ex'); ta.value = EX[k]; eng.value = k; run(); }); });
    if (root.HDW_GOALS) root.HDW_GOALS.attach(el, 'plan-reader', [['read', 'Read a plan, yours or an example'], ['hot', 'Find the step where most of the time goes']]);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.planreader'), mount);
})(typeof window !== 'undefined' ? window : globalThis);
