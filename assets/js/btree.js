/* Build an index: insert keys into a B+tree and watch pages fill and split.
   Sequential ids, random UUIDs (v4) or time-ordered UUIDs (v7).
   Markup: <div class="btlab" id="btreeLab"></div> */
(function () {
  var root = document.getElementById('btreeLab');
  if (!root) return;
  var NS = 'http://www.w3.org/2000/svg';
  var ENG = {
    pg: { name: 'PostgreSQL', tree: 'Index on id (users_pkey)', rows: 'The rows go into the table (the heap) in arrival order. Only this index cares about key order.' },
    my: { name: 'MySQL · InnoDB', tree: 'The table itself (clustered on id)', rows: 'In InnoDB the rows live in these leaves. A split here moves half the table\'s rows on that page.' },
    mo: { name: 'MongoDB', tree: 'Index on _id', rows: 'Documents are stored by an internal record id in arrival order. Only the _id index cares about key order.' }
  };
  var MODES = {
    seq: { name: 'Sequential ids', sub: 'BIGINT auto-increment' },
    rand: { name: 'Random UUIDs', sub: 'UUID v4' },
    v7: { name: 'Time-ordered UUIDs', sub: 'UUID v7, or UUID_TO_BIN(u, 1)' }
  };
  var st = { eng: 'pg', mode: 'rand', C: 4, busy: false };
  var saved = window.HDW_ENGINE && HDW_ENGINE.get(); if (saved && ENG[saved]) st.eng = saved;

  // ---------- the tree ----------
  var T, seq, used, recent, lastPath, lastSplit, nid;
  function node(leaf) { return { id: ++nid, leaf: leaf, keys: [], children: leaf ? null : [] }; }
  function reset() { nid = 0; T = { root: node(true), splits: 0, n: 0 }; seq = 0; used = {}; recent = []; lastPath = []; lastSplit = []; }
  function nextKey() {
    var k;
    if (st.mode === 'seq') return ++seq;
    if (st.mode === 'rand') { do { k = Math.floor(Math.random() * 65536); } while (used[k]); used[k] = 1; return k; }
    do { k = 4096 + Math.floor(seq / 4) * 64 + Math.floor(Math.random() * 64); } while (used[k]); used[k] = 1; seq++; return k;
  }
  function insert(k) {
    var path = [], n = T.root, rightmost = true, visited = [n.id];
    while (!n.leaf) { path.push(n); var i = 0; while (i < n.keys.length && k >= n.keys[i]) i++; if (i < n.children.length - 1) rightmost = false; n = n.children[i]; visited.push(n.id); }
    var i2 = 0; while (i2 < n.keys.length && n.keys[i2] < k) i2++; n.keys.splice(i2, 0, k);
    T.n++; recent.push(n.id); if (recent.length > 20) recent.shift();
    var child = n, split = [];
    while (child.keys.length > st.C) {
      T.splits++;
      var right, sep;
      if (child.leaf) {
        var cut = rightmost ? st.C : Math.ceil(child.keys.length / 2);
        right = node(true); right.keys = child.keys.splice(cut); sep = right.keys[0];
      } else {
        var mid = rightmost ? child.keys.length - 1 : Math.floor(child.keys.length / 2);
        sep = child.keys[mid]; right = node(false); right.keys = child.keys.splice(mid + 1); right.children = child.children.splice(mid + 1); child.keys.pop();
      }
      split.push(child.id, right.id);
      var p = path.pop();
      if (!p) { var r = node(false); r.keys = [sep]; r.children = [child, right]; T.root = r; split.push(r.id); break; }
      var j = p.children.indexOf(child); p.keys.splice(j, 0, sep); p.children.splice(j + 1, 0, right); child = p;
    }
    lastPath = visited; lastSplit = split;
  }
  function levels() { var out = [], lv = [T.root]; while (lv.length) { out.push(lv); var nx = []; lv.forEach(function (n) { if (!n.leaf) nx = nx.concat(n.children); }); lv = nx; } return out; }
  function stats() {
    var L = levels(), leaves = L[L.length - 1], keys = 0; leaves.forEach(function (l) { keys += l.keys.length; });
    var hot = {}; recent.forEach(function (id) { hot[id] = 1; });
    return { rows: T.n, leaves: leaves.length, full: leaves.length ? keys / (leaves.length * st.C) : 0, splits: T.splits, depth: L.length, hot: Object.keys(hot).length, recentN: recent.length };
  }
  function keyW() { var chars = st.mode === 'seq' ? 3 : 4; return st.C * (chars + 2) * 8.6 + 14; }
  function label(k) { return st.mode === 'seq' ? String(k) : ('000' + k.toString(16)).slice(-4); }

  // ---------- drawing ----------
  function el(name, a, p, t) { var e = document.createElementNS(NS, name); for (var k in a) e.setAttribute(k, a[k]); if (t != null) e.textContent = t; if (p) p.appendChild(e); return e; }
  function draw() {
    var stage = root.querySelector('.bt-stage'); stage.innerHTML = '';
    var L = levels(), nl = L[L.length - 1].length, W = Math.min(2000, Math.max(1000, nl * (keyW() + 8))), rowH = 92, H = L.length * rowH + 20;
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'B-tree with ' + L[L.length - 1].length + ' leaf pages' }, stage);
    var pos = {}, onPath = {}, onSplit = {};
    lastPath.forEach(function (id) { onPath[id] = 1; }); lastSplit.forEach(function (id) { onSplit[id] = 1; });
    L.forEach(function (lv, d) {
      var slot = W / lv.length, w = Math.max(4, Math.min(keyW(), slot - 6)), y = 10 + d * rowH;
      lv.forEach(function (n, i) { pos[n.id] = { x: i * slot + (slot - w) / 2, y: y, w: w }; });
    });
    var edges = el('g', { 'class': 'bt-edges' }, svg);
    L.forEach(function (lv) { lv.forEach(function (n) { if (n.leaf) return; var a = pos[n.id]; n.children.forEach(function (c) { var b = pos[c.id]; el('line', { x1: a.x + a.w / 2, y1: a.y + 40, x2: b.x + b.w / 2, y2: b.y, 'class': onPath[n.id] && onPath[c.id] ? 'bt-e on' : 'bt-e' }, edges); }); }); });
    L.forEach(function (lv, d) {
      lv.forEach(function (n) {
        var p = pos[n.id], g = el('g', { 'class': 'bt-n' + (n.leaf ? ' leaf' : '') + (onPath[n.id] ? ' path' : '') + (onSplit[n.id] ? ' split' : '') }, svg);
        var fill = n.keys.length / st.C;
        el('rect', { x: p.x, y: p.y, width: p.w, height: 40, rx: 6 }, g);
        if (n.leaf) el('rect', { x: p.x, y: p.y + 36, width: p.w * Math.min(1, fill), height: 4, 'class': 'bt-fill' + (fill <= 0.6 ? ' low' : '') }, g);
        if (p.w >= keyW() - 2) {
          el('text', { x: p.x + 10, y: p.y + 25, 'class': 'bt-k' }, g, n.keys.map(label).join('  '));
        } else if (p.w >= 30) {
          el('text', { x: p.x + p.w / 2, y: p.y + 25, 'text-anchor': 'middle', 'class': 'bt-k' }, g, n.keys.length + '/' + st.C);
        }
      });
    });
    var s = stats();
    var tiles = [
      [s.rows, 'rows inserted', false],
      [s.leaves, 'leaf pages', false],
      [Math.round(s.full * 100) + '%', 'average leaf page fullness', s.rows > 20 && s.full < 0.8],
      [s.splits, 'page splits so far', false],
      [s.depth, 'levels in the tree', false],
      [s.recentN ? s.hot + ' of ' + s.recentN : '-', 'leaf pages touched by the last ' + (s.recentN || 20) + ' inserts', s.recentN >= 10 && s.hot > s.recentN / 2]
    ];
    root.querySelector('.bt-stats').innerHTML = tiles.map(function (t) { return '<div class="es-tile' + (t[2] ? ' warn' : '') + '"><div class="es-v">' + t[0] + '</div><div class="es-k">' + t[1] + '</div></div>'; }).join('');
    root.querySelector('.bt-what').textContent = ENG[st.eng].tree + '. ' + ENG[st.eng].rows;
    root.querySelector('.bt-last').textContent = lastPath.length ? (lastSplit.length ? 'Last insert split ' + (lastSplit.length / 2 | 0 || 1) + ' page' + (lastSplit.length > 2 ? 's' : '') + ' (amber).' : 'Last insert fit in a page (green path).') : 'Press Insert to add rows.';
    root.dispatchEvent(new CustomEvent('bt-change', { detail: { stats: s, mode: st.mode, eng: st.eng } }));
  }

  function many(n, ms) {
    if (st.busy) return; st.busy = true;
    var left = n;
    (function step() {
      var batch = ms ? 1 : n; for (var i = 0; i < batch && left > 0; i++, left--) insert(nextKey());
      draw();
      if (left > 0) setTimeout(step, ms); else st.busy = false;
    })();
  }

  // ---------- compare all three ----------
  function compare() {
    var keep = { mode: st.mode }, rows = [];
    ['seq', 'rand', 'v7'].forEach(function (m) {
      st.mode = m; reset(); for (var i = 0; i < 300; i++) insert(nextKey());
      var s = stats(); rows.push([MODES[m].name, s.leaves, Math.round(s.full * 100) + '%', s.splits, s.hot + ' of 20']);
    });
    st.mode = keep.mode; reset(); draw();
    root.querySelector('.bt-cmp').innerHTML = '<table class="famtable"><thead><tr><th>300 rows, ' + st.C + ' per page</th><th>Leaf pages</th><th>Fullness</th><th>Splits</th><th>Pages touched by the last 20 inserts</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td><b>' + r[0] + '</b></td><td>' + r.slice(1).join('</td><td>') + '</td></tr>'; }).join('') + '</tbody></table>';
    root.dispatchEvent(new CustomEvent('bt-compare'));
  }

  root.innerHTML =
    '<div class="bt-ctl"><div class="seg bt-eng" role="group" aria-label="Database">' + Object.keys(ENG).map(function (k) { return '<button type="button" data-e="' + k + '" aria-pressed="' + (k === st.eng) + '">' + ENG[k].name + '</button>'; }).join('') + '</div>' +
    '<div class="seg bt-mode" role="group" aria-label="Key type">' + Object.keys(MODES).map(function (k) { return '<button type="button" data-m="' + k + '" aria-pressed="' + (k === st.mode) + '">' + MODES[k].name + '</button>'; }).join('') + '</div></div>' +
    '<p class="bt-what"></p>' +
    '<div class="bt-ctl"><button type="button" class="bt-go" data-n="1">Insert 1</button><button type="button" class="labbtn" data-n="10">Insert 10</button><button type="button" class="labbtn" data-n="100">Insert 100</button><button type="button" class="labbtn bt-reset">Start over</button>' +
    '<label class="bt-cap">Rows per page <input type="range" min="3" max="8" step="1" value="' + st.C + '" aria-label="Rows per page"> <b>' + st.C + '</b></label></div>' +
    '<div class="bt-stage"></div><p class="bt-last labnote"></p><div class="es-res bt-stats"></div>' +
    '<div class="bt-ctl" style="margin-top:14px"><button type="button" class="labbtn bt-compare">Compare all three key types, 300 rows each</button></div><div class="bt-cmp"></div>';
  if (window.HDW_GOALS) {
    HDW_GOALS.attach(root, 'btree', [['splits', 'Insert 30 or more random UUIDs and watch pages split in the middle'], ['v7', 'Find the key type that keeps UUIDs and full pages'], ['compare', 'Compare all three key types side by side']]);
    root.addEventListener('bt-change', function (e) { var d = e.detail; if (d.mode === 'rand' && d.stats.rows >= 30 && d.stats.splits > 0) HDW_GOALS.done('btree', 'splits'); if (d.mode === 'v7' && d.stats.rows >= 30) HDW_GOALS.done('btree', 'v7'); });
    root.addEventListener('bt-compare', function () { HDW_GOALS.done('btree', 'compare'); });
  }
  reset(); draw();

  root.querySelectorAll('[data-n]').forEach(function (b) { b.addEventListener('click', function () { var n = +b.getAttribute('data-n'); many(n, n === 1 ? 0 : (n === 10 ? 120 : 12)); }); });
  root.querySelector('.bt-reset').addEventListener('click', function () { if (st.busy) return; reset(); draw(); });
  root.querySelector('.bt-compare').addEventListener('click', function () { if (!st.busy) compare(); });
  root.querySelector('.bt-mode').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b || st.busy) return; st.mode = b.getAttribute('data-m'); root.querySelectorAll('.bt-mode button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); reset(); draw(); });
  root.querySelector('.bt-eng').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; st.eng = b.getAttribute('data-e'); root.querySelectorAll('.bt-eng button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); if (window.HDW_ENGINE) HDW_ENGINE.set(st.eng); draw(); });
  var cap = root.querySelector('.bt-cap input');
  cap.addEventListener('input', function () { if (st.busy) { cap.value = st.C; return; } st.C = +cap.value; root.querySelector('.bt-cap b').textContent = st.C; reset(); draw(); });
})();
