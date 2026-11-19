/* One insert, end to end, as an animation: the row travels from the app into
   memory, its log record goes to disk first, COMMIT, the replica, and the
   checkpoint. Markup: <div class="insanim" id="insAnim"></div> */
(function () {
  var root = document.getElementById('insAnim');
  if (!root) return;
  var NS = 'http://www.w3.org/2000/svg';
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var ENG = {
    pg: { name: 'PostgreSQL', sql: "INSERT INTO users (id, name) VALUES (42, 'Asha');",
      server: 'backend process', mem: 'Memory · shared_buffers', page: 'Table page · 8 KB', index: 'Index · users_pkey',
      logbuf: 'WAL buffers', logfile: 'pg_wal/', datafile: 'base/16384/16397', replica: 'Standby', stream: 'WAL stream',
      keys: ['10', '25', '42', '87'], order: ['send', 'check', 'log', 'place', 'index', 'commit', 'ack', 'replicate', 'ckpt'] },
    my: { name: 'MySQL', sql: "INSERT INTO users (id, name) VALUES (42, 'Asha');",
      server: 'server thread', mem: 'Memory · buffer pool', page: 'Leaf page of users.ibd · 16 KB', index: 'Index on name',
      logbuf: 'Log buffer', logfile: 'redo log + binlog', datafile: 'shop/users.ibd', replica: 'Replica', stream: 'binlog',
      keys: ['Ana', 'Ben', 'Asha', 'Zoe'], order: ['send', 'check', 'log', 'place', 'index', 'commit', 'ack', 'replicate', 'ckpt'] },
    mo: { name: 'MongoDB', sql: "db.users.insertOne({ _id: 42, name: 'Asha' })",
      server: 'mongod, the primary', mem: 'Memory · WiredTiger cache', page: 'Collection page', index: 'Index · _id',
      logbuf: 'Log buffer', logfile: 'journal + oplog', datafile: 'collection-2-….wt', replica: 'Secondaries', stream: 'oplog',
      keys: ['10', '25', '42', '87'], order: ['send', 'check', 'log', 'place', 'index', 'commit', 'replicate', 'ack', 'ckpt'] }
  };
  var CAP = {
    start: { t: 'One new row: id 42, Asha', s: 'Press play and watch where it goes. On a real server all of this takes about a millisecond.' },
    send: { t: 'The app sends the INSERT', s: 'One statement over an open connection. Nothing is saved yet.' },
    check: { t: 'The server finds the right page, in memory', s: 'It checks the table and the types, then looks for the page in memory first. Disk only if it is not there.' },
    log: { t: 'First, the change is written to the log', s: 'Before the page is touched, a record of the change goes into the log buffer. Log first, always.' },
    place: { pg: { t: 'Then the row goes into the page', s: 'The row is added to the table page in memory. The page is now "dirty": changed in memory, not yet on disk.' },
      my: { t: 'Then the row goes into its sorted place', s: 'In InnoDB the table is the primary-key tree, so row 42 lands between 25 and 87. The page is now "dirty".' },
      mo: { t: 'Then the document goes into the page', s: 'The document is added to the collection page in memory. The page is now "dirty": changed, not yet on disk.' } },
    index: { pg: { t: 'The index gets a pointer to the row', s: 'users_pkey gets the key 42, pointing at the row. Every extra index is one more step like this.' },
      my: { t: 'Each secondary index gets an entry', s: 'The index on name gets "Asha → 42". It stores the primary key, not the row.' },
      mo: { t: 'The _id index gets an entry', s: 'Key 42 now points at the document. Every extra index is one more step like this.' } },
    commit: { pg: { t: 'COMMIT: the log is flushed to disk', s: 'PostgreSQL waits until the WAL record is on disk. This wait is the cost of a durable commit.' },
      my: { t: 'COMMIT: redo log and binlog are flushed together', s: 'Both logs reach disk in one coordinated step, so a crash cannot leave them disagreeing.' },
      mo: { t: 'The journal is flushed, and the oplog gets an entry', s: 'The write is now on disk in the journal, and in the oplog that secondaries copy from.' } },
    ack: { pg: { t: 'Done. The app hears back', s: 'The row is safe now, though the data file has not changed. A crash here is repaired from the log.' },
      my: { t: 'Done. The app hears back', s: 'The row is safe now, though users.ibd has not changed. A crash here is repaired from the redo log.' },
      mo: { t: 'Done, once a majority has it', s: 'With write concern "majority", MongoDB answers only after most members have the write, so a failover cannot lose it.' } },
    replicate: { pg: { t: 'The standby replays the same log', s: 'The WAL record is streamed to the standby, which applies it and gets row 42 too, usually within milliseconds.' },
      my: { t: 'The replica pulls the binlog and applies it', s: 'Each replica copies the binlog event and replays it, so it ends up with row 42 too.' },
      mo: { t: 'The secondaries copy the oplog entry', s: 'Each secondary applies it and reports back. MongoDB waits for a majority before saying done.' } },
    ckpt: { t: 'Later: a checkpoint writes the page to the data file', s: 'In the background, maybe a minute later. The insert was already safe at COMMIT; this is housekeeping.' }
  };
  var DETAIL = {
    send: 'The driver (libpq, JDBC, the MongoDB driver) sends one message over a connection that is already open. Opening a new connection for every statement would cost more than the insert itself.',
    check: 'The server checks that the table exists, that 42 and "Asha" fit the column types, and that you may write here. Then it looks for a page with room. Found in memory: no disk read at all.',
    log: 'This is the write-ahead rule. If the page could reach disk before its log record, a crash at the wrong moment would leave a change that recovery cannot check or undo.',
    place: 'The data file on disk has not changed. Only the copy of the page in memory has. That is fine, because the log describes the change.',
    index: 'If 42 already existed in a unique index, the insert would fail right here and everything before it would be undone.',
    commit: 'This flush is why a durable commit costs about a fraction of a millisecond on local NVMe and a few milliseconds on network storage. Notebook 2 on this site measures it.',
    ack: 'The data page is still only in memory. If the server crashes now, recovery replays the log and row 42 comes back.',
    replicate: 'The replica receives the same log the primary wrote, not the SQL. That is why it ends up with the same bytes. The delay between the two is replication lag.',
    ckpt: 'After the checkpoint, the log up to this point is no longer needed for crash recovery and can be recycled.'
  };

  // Layouts: [x, y, w, h] in SVG units
  var L = {
    wide: { W: 1000, H: 470, app: [20, 34, 150, 62], server: [215, 34, 200, 62], mem: [215, 128, 545, 196],
      page: [232, 166, 230, 142], index: [478, 166, 140, 142], logbuf: [634, 166, 110, 142],
      disk: [215, 352, 545, 112], datafile: [232, 384, 250, 70], logfile: [500, 384, 244, 70],
      replica: [800, 128, 180, 196], wire: [[744, 419], [890, 419], [890, 324]] },
    narrow: { W: 440, H: 900, app: [16, 18, 190, 62], server: [234, 18, 190, 62], mem: [16, 112, 408, 360],
      page: [30, 150, 186, 148], index: [234, 150, 176, 148], logbuf: [30, 318, 380, 136],
      disk: [16, 500, 408, 170], datafile: [30, 538, 186, 116], logfile: [234, 538, 176, 116],
      replica: [16, 708, 408, 176], wire: [[322, 654], [322, 708]] }
  };

  var st = { eng: 'pg', i: -1, playing: false, timer: null, layout: null, seen: false };
  var PRED = { q: 'Before you watch: when is row 42 safe from a crash?', right: 'commit', opts: [
    ['page', 'When the row is written into the page in memory'],
    ['commit', 'When the log record reaches disk, at COMMIT'],
    ['ckpt', 'When a checkpoint writes it to the data file']] };
  function getPred() { try { return localStorage.getItem('hdw-pred-insert'); } catch (e) { return null; } }
  function setPred(v) { try { localStorage.setItem('hdw-pred-insert', v); } catch (e) {} st.pred = v; }
  st.pred = getPred();
  var pref = window.HDW_ENGINE && HDW_ENGINE.get(); if (pref && ENG[pref]) st.eng = pref;
  var DUR = 2600;

  function el(name, attrs, parent, text) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function center(r) { return [r[0] + r[2] / 2, r[1] + r[3] / 2]; }

  var svg, N = {};
  function build() {
    var lay = root.clientWidth < 620 ? 'narrow' : 'wide';
    st.layout = lay;
    var G = L[lay], E = ENG[st.eng];
    root.querySelector('.ia-stage').innerHTML = '';
    svg = el('svg', { viewBox: '0 0 ' + G.W + ' ' + G.H, role: 'img', 'aria-label': 'Animation of one insert travelling through ' + E.name }, root.querySelector('.ia-stage'));
    N = {};
    function box(key, label, sub, cls) {
      var r = G[key], g = el('g', { 'class': 'ia-box ' + (cls || ''), 'data-k': key }, svg);
      el('rect', { x: r[0], y: r[1], width: r[2], height: r[3], rx: 12 }, g);
      el('text', { x: r[0] + 12, y: r[1] + 22, 'class': 'ia-lab' }, g, label);
      if (sub) el('text', { x: r[0] + 12, y: r[1] + 42, 'class': 'ia-sub' }, g, sub);
      N[key] = g; return g;
    }
    box('mem', E.mem, null, 'ia-region ia-memr');
    box('disk', 'Disk', null, 'ia-region ia-diskr');
    box('app', 'Your app', 'driver');
    box('server', E.name, E.server);
    box('page', E.page, null);
    box('index', E.index, null);
    box('logbuf', E.logbuf, null);
    box('datafile', 'Data file', E.datafile);
    box('logfile', 'Log on disk', E.logfile);
    box('replica', E.replica, 'replays the ' + E.stream);
    var w = G.wire;
    el('polyline', { points: w.map(function (p) { return p.join(','); }).join(' '), 'class': 'ia-wire' }, svg);
    // rows in the page and on the replica
    function rows(key, list, prefix) {
      var r = G[key], out = {};
      list.forEach(function (k, n) {
        var y = r[1] + 62 + n * 20;
        var t = el('text', { x: r[0] + 14, y: y, 'class': 'ia-row' + (k === '42' ? ' ia-new' : '') }, svg, (prefix || '') + rowLabel(k));
        out[k] = t;
      });
      return out;
    }
    function rowLabel(k) { return { '10': 'id 10 · Ben', '25': 'id 25 · Chen', '42': 'id 42 · Asha', '87': 'id 87 · Zoe' }[k]; }
    N.pageRows = rows('page', ['10', '25', '42', '87']);
    N.repRows = rows('replica', ['10', '25', '42', '87']);
    // index keys
    var ir = G.index; N.keys = {};
    E.keys.forEach(function (k, n) {
      var isNew = (k === '42' || k === 'Asha');
      N.keys[k] = el('text', { x: ir[0] + 14, y: ir[1] + 62 + (st.eng === 'my' ? [0, 2, 1, 3][n] : n) * 20, 'class': 'ia-row' + (isNew ? ' ia-new' : '') }, svg, isNew ? (st.eng === 'my' ? 'Asha → 42' : '42 → row') : k);
    });
    // dirty tag, data file contents, fsync bar, log contents
    var pr = G.page;
    N.dirty = el('g', { 'class': 'ia-dirty' }, svg);
    el('rect', { x: pr[0] + pr[2] - 64, y: pr[1] + pr[3] - 30, width: 54, height: 20, rx: 10 }, N.dirty);
    el('text', { x: pr[0] + pr[2] - 37, y: pr[1] + pr[3] - 16, 'text-anchor': 'middle' }, N.dirty, 'dirty');
    var dr = G.datafile;
    N.dataOld = el('text', { x: dr[0] + 12, y: dr[1] + dr[3] - 12, 'class': 'ia-sub' }, svg, 'rows 10, 25, 87');
    N.dataNew = el('text', { x: dr[0] + 12, y: dr[1] + dr[3] - 12, 'class': 'ia-sub ia-ok' }, svg, 'rows 10, 25, 42, 87 ✓');
    var lf = G.logfile;
    N.fsync = el('rect', { x: lf[0] + 12, y: lf[1] + lf[3] - 14, width: lf[2] - 24, height: 6, rx: 3, 'class': 'ia-fsync' }, svg);
    // moving pieces
    function pill(cls, label, w) {
      var g = el('g', { 'class': 'ia-pill ' + cls }, svg);
      el('rect', { x: -w / 2, y: -14, width: w, height: 28, rx: 14 }, g);
      el('text', { x: 0, y: 5, 'text-anchor': 'middle' }, g, label);
      return g;
    }
    N.token = pill('ia-token', '42 · Asha', 112);
    N.rec = pill('ia-rec', 'log: +42', 92);
    N.ack = pill('ia-ack', '✓ done', 84);
    N.rep = pill('ia-rec', 'log: +42', 92);
    N.ck = pill('ia-ck', 'page', 70);
  }

  function pos(name) {
    var G = L[st.layout], c;
    if (name === 'app') return [G.app[0] + G.app[2] - 50, G.app[1] + G.app[3] - 16];
    if (name === 'server') return center(G.server);
    if (name === 'pageTop') { c = center(G.page); return [c[0], G.page[1] - 2]; }
    if (name === 'slot') { return [G.page[0] + G.page[2] / 2, G.page[1] + 57 + 2 * 20]; }
    if (name === 'logbuf') return [center(G.logbuf)[0], G.logbuf[1] + 70];
    if (name === 'logfile') return st.layout === 'wide' ? [G.logfile[0] + G.logfile[2] - 58, G.logfile[1] + 30] : [center(G.logfile)[0], G.logfile[1] + 76];
    if (name === 'replica') return [center(G.replica)[0], G.replica[1] + 57 + 2 * 20];
    if (name === 'datafile') return st.layout === 'wide' ? [G.datafile[0] + G.datafile[2] - 46, G.datafile[1] + 30] : [center(G.datafile)[0], G.datafile[1] + 70];
    return [-200, -200];
  }

  // What the scene looks like after scene index i (cumulative).
  function stateAt(i) {
    var order = ENG[st.eng].order, S = { token: 'app', tokenOn: true, rec: null, ack: null, rep: null, ck: null, row: false, idx: false, dirty: false, logbuf: false, logdisk: false, acked: false, repRow: false, data: false, hl: [], fsync: false, from: {} };
    for (var k = 0; k <= i; k++) {
      var sc = order[k], last = k === i;
      S.hl = []; S.from = {}; S.fsync = false;
      if (sc === 'send') { S.token = 'server'; S.hl = ['app', 'server']; if (last) S.from.token = 'app'; }
      if (sc === 'check') { S.token = 'pageTop'; S.hl = ['server', 'page']; if (last) S.from.token = 'server'; }
      if (sc === 'log') { S.rec = 'logbuf'; S.logbuf = true; S.hl = ['logbuf']; if (last) S.from.rec = 'pageTop'; }
      if (sc === 'place') { S.token = 'slot'; S.row = true; S.dirty = true; S.hl = ['page']; if (last) S.from.token = 'pageTop'; }
      if (sc === 'index') { S.idx = true; S.hl = ['index']; }
      if (sc === 'commit') { S.rec = 'logfile'; S.logdisk = true; S.hl = ['logbuf', 'logfile']; S.fsync = last; if (last) S.from.rec = 'logbuf'; }
      if (sc === 'ack') { S.ack = 'app'; S.acked = true; S.hl = ['app']; if (last) S.from.ack = 'server'; }
      if (sc === 'replicate') { S.rep = 'replica'; S.repRow = true; S.hl = ['logfile', 'replica']; if (last) S.from.rep = 'logfile'; }
      if (sc === 'ckpt') { S.ck = 'datafile'; S.data = true; S.dirty = false; S.hl = ['page', 'datafile']; if (last) S.from.ck = 'slot'; }
    }
    if (S.row && order[i] !== 'place') S.tokenOn = false;
    if (S.rep && i >= 0 && order[i] !== 'replicate') S.rep = null;
    if (S.ck && order[i] !== 'ckpt') S.ck = null;
    return S;
  }

  function place(g, name, animate, fromName) {
    if (!name) { g.style.opacity = '0'; return; }
    var p = pos(name);
    if (animate && fromName && !reduce) {
      var f = pos(fromName);
      g.style.transition = 'none';
      g.style.transform = 'translate(' + f[0] + 'px,' + f[1] + 'px)';
      g.style.opacity = '1';
      g.getBoundingClientRect();
      g.style.transition = '';
    }
    g.style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px)';
    g.style.opacity = '1';
  }

  function render(animate) {
    var E = ENG[st.eng], order = E.order, i = st.i, S = stateAt(i);
    if (!animate || reduce) svg.classList.add('ia-instant'); else svg.classList.remove('ia-instant');
    ['app', 'server', 'page', 'index', 'logbuf', 'datafile', 'logfile', 'replica'].forEach(function (k) { N[k].classList.toggle('ia-hl', S.hl.indexOf(k) >= 0); });
    place(N.token, S.tokenOn ? S.token : null, animate, S.from.token);
    place(N.rec, S.rec, animate, S.from.rec);
    place(N.ack, S.ack, animate, S.from.ack);
    place(N.rep, S.rep, animate, S.from.rep);
    place(N.ck, S.ck, animate, S.from.ck);
    N.pageRows['42'].classList.toggle('ia-on', S.row);
    N.repRows['42'].classList.toggle('ia-on', S.repRow);
    Object.keys(N.keys).forEach(function (k) { if (/42|Asha/.test(k)) N.keys[k].classList.toggle('ia-on', S.idx); });
    N.dirty.classList.toggle('ia-on', S.dirty);
    N.dataOld.style.opacity = S.data ? '0' : '1';
    N.dataNew.style.opacity = S.data ? '1' : '0';
    N.fsync.classList.remove('ia-run'); N.fsync.classList.toggle('ia-full', S.logdisk && !S.fsync);
    if (S.fsync) { N.fsync.getBoundingClientRect(); N.fsync.classList.add('ia-run'); }
    var cap = i < 0 ? CAP.start : CAP[order[i]];
    if (cap[st.eng]) cap = cap[st.eng];
    var pq = root.querySelector('.ia-pred'), asking = i < 0 && !st.pred;
    pq.hidden = !asking; root.querySelector('.ia-capbody').hidden = asking;
    var verdict = root.querySelector('.ia-verdict');
    if (st.pred && st.pred !== 'skip' && i >= 0 && order[i] === 'commit') {
      var ok = st.pred === PRED.right;
      verdict.hidden = false; verdict.className = 'ia-verdict ' + (ok ? 'ok' : 'no');
      verdict.textContent = ok ? 'You said at COMMIT. That is it: the data file has not changed yet, and it does not need to.' : 'You said ' + (st.pred === 'page' ? 'when the page changes in memory' : 'at the checkpoint') + '. Not quite: it is safe here, when the log reaches disk. ' + (st.pred === 'page' ? 'A page in memory is lost in a crash.' : 'The checkpoint comes later and is only housekeeping.');
    } else verdict.hidden = true;
    root.querySelector('.ia-capbody .ia-step').textContent = i < 0 ? 'Ready' : 'Step ' + (i + 1) + ' of ' + order.length;
    root.querySelector('.ia-capbody .ia-title').textContent = cap.t;
    root.querySelector('.ia-text').textContent = cap.s;
    var det = root.querySelector('.ia-more');
    det.hidden = i < 0; if (i >= 0) det.querySelector('p').textContent = DETAIL[order[i]];
    var dots = root.querySelectorAll('.ia-dot');
    Array.prototype.forEach.call(dots, function (d, k) { d.classList.toggle('on', k === i); d.classList.toggle('done', k < i); d.setAttribute('aria-current', k === i ? 'step' : 'false'); });
    root.querySelector('.ia-play').textContent = st.playing ? 'Pause' : (i >= order.length - 1 ? 'Replay' : (i < 0 ? 'Play' : 'Continue'));
    root.querySelector('.ia-prev').disabled = i < 0;
    root.querySelector('.ia-next').disabled = i >= order.length - 1;
    root.querySelector('.ia-sql').textContent = E.sql;
    root.querySelector('.ia-safe').classList.toggle('on', S.logdisk);
    if (i >= 0 && window.HDW_GOALS) {
      st.engSeen = st.engSeen || {}; st.engSeen[st.eng] = 1;
      if (order[i] === 'commit') HDW_GOALS.done('insert', 'safe');
      if (Object.keys(st.engSeen).length >= 2) HDW_GOALS.done('insert', 'two');
      if (st.eng === 'mo' && order[i] === 'ack') HDW_GOALS.done('insert', 'mongo');
    }
  }

  function stop() { st.playing = false; clearTimeout(st.timer); }
  function tick() {
    var n = ENG[st.eng].order.length;
    if (st.i >= n - 1) { stop(); render(false); return; }
    st.i++; render(true);
    st.timer = setTimeout(tick, DUR);
  }
  function play() {
    var n = ENG[st.eng].order.length;
    if (st.i >= n - 1) { st.i = -1; render(false); }
    st.playing = true; clearTimeout(st.timer);
    st.timer = setTimeout(tick, st.i < 0 ? 400 : 0);
    render(false);
  }
  function go(i, animate) { stop(); st.i = Math.max(-1, Math.min(ENG[st.eng].order.length - 1, i)); render(animate); }

  function dotsHtml() {
    return ENG[st.eng].order.map(function (k, n) { return '<button type="button" class="ia-dot" data-i="' + n + '" aria-label="Step ' + (n + 1) + '"></button>'; }).join('');
  }
  root.innerHTML =
    '<div class="ia-top"><div class="seg ia-eng" role="group" aria-label="Database">' +
    Object.keys(ENG).map(function (k) { return '<button type="button" data-e="' + k + '" aria-pressed="' + (k === st.eng) + '">' + ENG[k].name + '</button>'; }).join('') +
    '</div><code class="ia-sql"></code></div>' +
    '<div class="ia-stage"></div>' +
    '<div class="ia-cap" aria-live="polite"><div class="ia-pred" hidden><div class="ia-step">Predict first</div><div class="ia-title">' + PRED.q + '</div><div class="ia-opts">' +
    PRED.opts.map(function (o) { return '<button type="button" class="ia-opt" data-p="' + o[0] + '">' + o[1] + '</button>'; }).join('') +
    '</div><button type="button" class="ia-skip">Skip, just play it</button></div>' +
    '<div class="ia-capbody"><div class="ia-step"></div><div class="ia-title"></div><p class="ia-text"></p><p class="ia-verdict" hidden></p>' +
    '<details class="ia-more" hidden><summary>More on this step</summary><p></p></details></div></div>' +
    '<div class="ia-ctl"><button type="button" class="labbtn ia-prev" aria-label="Previous step">←</button><button type="button" class="ia-play"></button><button type="button" class="labbtn ia-next" aria-label="Next step">→</button>' +
    '<div class="ia-dots">' + dotsHtml() + '</div><span class="ia-safe">Row 42 is safe</span></div>';

  build(); render(false);
  if (window.HDW_GOALS) HDW_GOALS.attach(root, 'insert', [['safe', 'Find the step where row 42 becomes safe from a crash'], ['two', 'Watch the same insert in a second database'], ['mongo', 'Find the step where MongoDB waits for the other members before it says done']]);

  root.querySelector('.ia-play').addEventListener('click', function () { if (st.playing) { stop(); render(false); } else { if (!st.pred) setPred('skip'); play(); } });
  root.querySelector('.ia-pred').addEventListener('click', function (e) {
    var b = e.target.closest('.ia-opt, .ia-skip'); if (!b) return;
    setPred(b.classList.contains('ia-skip') ? 'skip' : b.getAttribute('data-p')); play();
  });
  root.querySelector('.ia-prev').addEventListener('click', function () { go(st.i - 1, false); });
  root.querySelector('.ia-next').addEventListener('click', function () { if (!st.pred) setPred('skip'); go(st.i + 1, true); });
  root.querySelector('.ia-dots').addEventListener('click', function (e) { var b = e.target.closest('.ia-dot'); if (b) { if (!st.pred) setPred('skip'); go(+b.getAttribute('data-i'), false); } });
  root.querySelector('.ia-eng').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    stop(); st.eng = b.getAttribute('data-e'); st.i = -1; if (window.HDW_ENGINE) HDW_ENGINE.set(st.eng);
    Array.prototype.forEach.call(root.querySelectorAll('.ia-eng button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    root.querySelector('.ia-dots').innerHTML = dotsHtml();
    build(); render(false);
  });
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { var lay = root.clientWidth < 620 ? 'narrow' : 'wide'; if (lay !== st.layout) { build(); render(false); } }, 150); });
  // Start playing the first time it scrolls into view.
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting && !st.seen) { st.seen = true; if (st.pred) play(); io.disconnect(); } }); }, { threshold: 0.45 });
    io.observe(root.querySelector('.ia-stage'));
  }
})();
