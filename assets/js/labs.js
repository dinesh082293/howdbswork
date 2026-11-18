/* Labs page: four small simulations. Each one is a model, not a benchmark.
   The point is the shape of the behavior, so the numbers are round on purpose. */
(function () {
  function $(id) { return document.getElementById(id); }
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  function fmt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function dur(sec) {
    if (!isFinite(sec)) return 'never';
    if (sec < 90) return Math.round(sec) + ' s';
    if (sec < 5400) return Math.round(sec / 60) + ' min';
    return (sec / 3600).toFixed(1) + ' h';
  }

  /* ---------- 1. Crash lab ---------- */
  function crashLab() {
    var root = $('crashLab'); if (!root) return;
    var eng = $('crashEng'), dur_ = $('crashDurable'), out = $('crashOut'), row = $('crashRow');
    var st;
    var NAMES = {
      pg: { log: 'pg_wal/', data: 'base/', off: 'synchronous_commit = off' },
      my: { log: '#innodb_redo/', data: 'users.ibd', off: 'innodb_flush_log_at_trx_commit = 0' },
      mo: { log: 'journal/WiredTigerLog.*', data: 'collection-*.wt', off: 'w: 1 without j: true' }
    };
    function reset() { st = { txs: [], open: false, crashed: false, next: 1 }; write('Ready. Commit a few transactions, then pull the plug.'); draw(); }
    function write(t) { out.textContent = t; }
    function draw() {
      var e = eng.value, h = '';
      for (var i = 0; i < st.txs.length; i++) {
        var t = st.txs[i], c = 'tx' + (t.inLog ? ' inlog' : '') + (t.onDisk ? ' ondisk' : '') + (t.lost ? ' lost' : '');
        h += '<span class="' + c + '">T' + t.id + '</span>';
      }
      if (st.open) h += '<span class="tx open">T' + st.next + ' open</span>';
      row.innerHTML = h || '<span class="labnote">No transactions yet.</span>';
      $('crashCommit').disabled = st.crashed;
      $('crashOpen').disabled = st.crashed || st.open;
      $('crashTick').disabled = st.crashed;
      $('crashCkpt').disabled = st.crashed;
      $('crashKill').disabled = st.crashed;
      $('crashRestart').disabled = !st.crashed;
      var d = NAMES[e];
      $('crashLegend').innerHTML = 'Teal fill: the commit is in the log (' + d.log + '). Teal bar underneath: the change is also in the data file (' + d.data + '). Red and struck through: lost in the crash.';
      $('crashOffLabel').textContent = 'Commit waits for the log flush (turn off to model ' + d.off + ')';
    }
    function commit() {
      st.txs.push({ id: st.next++, inLog: dur_.checked, onDisk: false, lost: false });
      if (st.open) st.open = false;
      write(dur_.checked ? 'COMMIT returned after the log flush. This one is safe.' : 'COMMIT returned at once. The log record is still in memory until the next flush.');
      draw();
    }
    function openTx() { st.open = true; write('A transaction is open and has changed rows in memory. It has not committed.'); draw(); }
    function tick() {
      var n = 0; st.txs.forEach(function (t) { if (!t.inLog && !t.lost) { t.inLog = true; n++; } });
      write(n ? 'About a second passed. The background flush wrote ' + n + ' waiting log record(s) to disk.' : 'About a second passed. Nothing was waiting.');
      draw();
    }
    function ckpt() {
      var n = 0; st.txs.forEach(function (t) { if (!t.lost) { t.inLog = true; if (!t.onDisk) { t.onDisk = true; n++; } } });
      write('Checkpoint. The log is flushed first, then ' + n + ' transaction(s) are written into the data files. Replay after a crash now starts after this point.');
      draw();
    }
    function kill() {
      var lost = 0; st.txs.forEach(function (t) { if (!t.inLog) { t.lost = true; lost++; } });
      st.crashed = true;
      write('CRASH. Memory is gone.\nLog on disk: ' + st.txs.filter(function (t) { return t.inLog; }).length + ' commit(s).\nData files hold only what the last checkpoint wrote.' + (lost ? '\n' + lost + ' commit(s) were acknowledged but never reached the log. They are lost.' : ''));
      draw();
    }
    function restart() {
      var e = eng.value, replay = st.txs.filter(function (t) { return t.inLog && !t.onDisk && !t.lost; }).length;
      var openN = st.open ? 1 : 0, L = [];
      if (e === 'pg') {
        L.push('pg_control: last checkpoint found, redo starts there.');
        L.push('Replaying ' + replay + ' WAL record(s) forward into the data pages.');
        L.push(openN ? '1 transaction never committed. Its row versions stay invisible. No undo needed. VACUUM cleans them later.' : 'No open transactions at the crash.');
      } else if (e === 'my') {
        L.push('Checking pages against the doublewrite files, repairing any torn page.');
        L.push('Applying ' + replay + ' redo record(s) after the last checkpoint.');
        L.push(openN ? '1 open transaction. Rolling it back with the undo log, in the background.' : 'No open transactions to roll back.');
        L.push('Settling prepared transactions against the binlog.');
      } else {
        L.push('WiredTiger restores the last checkpoint.');
        L.push('Replaying ' + replay + ' journal record(s) written after it.');
        L.push(openN ? '1 open transaction. It is aborted. Its writes were never visible.' : 'No open transactions at the crash.');
        L.push('On a replica set, the member now catches up from the oplog.');
      }
      L.push('');
      L.push(replay === 0 ? 'Nothing to replay, so the restart is fast.' : 'Recovery work is proportional to the ' + replay + ' record(s) after the checkpoint. Run a checkpoint before the crash and watch this number go to 0.');
      st.txs.forEach(function (t) { if (!t.lost) { t.onDisk = true; } });
      st.open = false; st.crashed = false;
      write(L.join('\n'));
      draw();
    }
    $('crashCommit').addEventListener('click', commit);
    $('crashOpen').addEventListener('click', openTx);
    $('crashTick').addEventListener('click', tick);
    $('crashCkpt').addEventListener('click', ckpt);
    $('crashKill').addEventListener('click', kill);
    $('crashRestart').addEventListener('click', restart);
    $('crashReset').addEventListener('click', reset);
    eng.addEventListener('change', function () { draw(); });
    reset();
  }

  /* ---------- 2. Replica lag lab ---------- */
  function lagLab() {
    if (!$('lagLab')) return;
    var ids = ['lagW', 'lagA', 'lagT', 'lagO'];
    function calc() {
      var w = +$('lagW').value, a = +$('lagA').value, t = +$('lagT').value * 60, oplog = +$('lagO').value * 60, e = $('lagEng').value;
      $('lagWv').textContent = fmt(w); $('lagAv').textContent = fmt(a); $('lagTv').textContent = $('lagT').value + ' min'; $('lagOv').textContent = $('lagO').value + ' min';
      var backlog = Math.max(0, (w - a) * t);
      var lagSec = backlog / a;
      var drain = a - w * 0.5;
      var catchup = backlog === 0 ? 0 : (drain > 0 ? backlog / drain : Infinity);
      $('lagBacklog').textContent = fmt(backlog);
      $('lagLag').textContent = dur(lagSec);
      $('lagCatch').textContent = dur(catchup);
      var note, bad = false;
      if (w <= a) { note = 'The replica keeps up. Lag stays near zero. Remember this is the average: a burst above ' + fmt(a) + ' tx/s still builds a short queue.'; }
      else if (e === 'mo') {
        $('lagOrow').style.display = '';
        if (lagSec > oplog) { note = 'Lag (' + dur(lagSec) + ') is longer than the oplog window (' + dur(oplog) + '). The entries the secondary needs are gone. It needs a full resync.'; bad = true; }
        else { note = 'Lag is inside the oplog window, so the secondary can still catch up. Flow control may also slow the primary to protect it.'; }
      } else if (e === 'my') {
        note = 'The replica needs the binlog to still exist on the source. Keep binlog retention longer than ' + dur(lagSec) + ' of lag, or the replica needs a rebuild.';
      } else {
        note = 'The standby needs the WAL from ' + dur(lagSec) + ' ago. With a replication slot, the primary keeps all of it, so the primary disk fills at the write rate. With synchronous replication, every commit waits as well.';
        bad = lagSec > 600;
      }
      if (e !== 'mo') $('lagOrow').style.display = 'none';
      $('lagNote').textContent = note;
      $('lagStatLag').className = bad || lagSec > 300 ? 'bad' : '';
    }
    ids.forEach(function (i) { $(i).addEventListener('input', calc); });
    $('lagEng').addEventListener('change', calc);
    calc();
  }

  /* ---------- 3. Lock pile-up lab ---------- */
  function lockLab() {
    if (!$('lockLab')) return;
    function calc() {
      var r = +$('lockR').value, h = +$('lockH').value, pool = +$('lockP').value, ms = +$('lockMs').value, e = $('lockEng').value;
      $('lockRv').textContent = r + ' /s'; $('lockHv').textContent = h + ' s'; $('lockPv').textContent = pool; $('lockMsv').textContent = ms + ' ms';
      var waiters = r * h;
      var exhaustAt = pool / r;
      var util = r * ms / 1000;
      var drain = util < 1 ? (waiters * ms / 1000) / (1 - util) : Infinity;
      $('lockWait').textContent = fmt(waiters);
      $('lockExh').textContent = waiters > pool ? dur(exhaustAt) : 'not reached';
      $('lockDrain').textContent = dur(drain);
      $('lockStatExh').className = waiters > pool ? 'bad' : '';
      var bars = '', n = 40, maxv = Math.max(waiters, pool) || 1;
      for (var i = 0; i < n; i++) {
        var tt = h * (i + 1) / n, w = r * tt, hot = w > pool;
        bars += '<i class="' + (hot ? 'hit' : '') + '" style="height:' + Math.max(2, Math.round(60 * Math.min(w, maxv) / maxv)) + 'px;align-self:end"></i>';
      }
      $('lockBars').innerHTML = bars;
      var tip = e === 'pg' ? 'PostgreSQL waits without a limit by default (lock_timeout = 0). Set lock_timeout for application sessions.'
        : e === 'my' ? 'MySQL waits innodb_lock_wait_timeout, 50 s by default, then fails the waiting statement. That is longer than most pools can afford.'
        : 'MongoDB retries write conflicts on the same document internally. A caller can bound the wait with maxTimeMS, but a hot document still serializes its writers.';
      $('lockNote').textContent = (waiters > pool ? 'The pool runs out ' + dur(exhaustAt) + ' after the lock is taken. Everything else that needs a connection, including unrelated queries, now waits too. ' : 'The pool survives this one. ') + tip;
    }
    ['lockR', 'lockH', 'lockP', 'lockMs'].forEach(function (i) { $(i).addEventListener('input', calc); });
    $('lockEng').addEventListener('change', calc);
    calc();
  }

  /* ---------- 4. Page count demo ---------- */
  function pageLab() {
    if (!$('pageLab')) return;
    var grid = $('pageGrid'), cells = [], N = 400, timer = null;
    var h = ''; for (var i = 0; i < N; i++) h += '<i></i>'; grid.innerHTML = h; cells = grid.children;
    function cfg() {
      var rows = Math.pow(10, +$('pageExp').value), rs = +$('pageRow').value, ps = +$('pageEng').value;
      var perPage = Math.max(1, Math.floor(ps / rs)), pages = Math.ceil(rows / perPage), fan = Math.floor(ps / 20);
      var depth = Math.max(1, Math.ceil(Math.log(rows) / Math.log(fan)));
      return { rows: rows, rs: rs, ps: ps, pages: pages, depth: depth };
    }
    function clear() { if (timer) { clearInterval(timer); timer = null; } for (var i = 0; i < N; i++) cells[i].className = ''; }
    function stats() {
      var c = cfg();
      $('pageExpv').textContent = '10^' + $('pageExp').value + ' rows (' + fmt(c.rows) + ')';
      $('pageRowv').textContent = c.rs + ' bytes';
      $('pageTotal').textContent = fmt(c.pages);
      $('pageScanBytes').textContent = c.pages * c.ps >= 1e9 ? (c.pages * c.ps / 1e9).toFixed(1) + ' GB' : Math.round(c.pages * c.ps / 1e6) + ' MB';
      $('pageIdx').textContent = c.depth + (c.ps === 8192 ? ' + 1' : '');
      $('pageScanTime').textContent = dur(c.pages * c.ps / 3e9);
      $('pageCount').textContent = '-';
      $('pageNote').textContent = 'Each square stands for ' + fmt(Math.ceil(c.pages / N)) + ' page(s). The index lookup touches ' + c.depth + ' index page(s)' + (c.ps === 8192 ? ' plus one heap page' : ', and the last one already holds the row') + '. Scan time assumes about 3 GB/s of sequential reads with a cold cache, the same assumption as the table-growth slider on the Staff Path.';
    }
    function scan() {
      clear(); var c = cfg(), i = 0;
      function step() { if (i < N) { cells[i].className = 'hit'; i++; $('pageCount').textContent = fmt(Math.round(c.pages * i / N)); } else { clearInterval(timer); timer = null; $('pageCount').textContent = fmt(c.pages); } }
      if (reduce) { for (var j = 0; j < N; j++) cells[j].className = 'hit'; $('pageCount').textContent = fmt(c.pages); return; }
      timer = setInterval(step, 12);
    }
    function look() {
      clear(); var c = cfg(), n = c.depth + (c.ps === 8192 ? 1 : 0), k = 0, picks = [];
      var seed = 7; for (var i = 0; i < n; i++) { seed = (seed * 37 + 11) % N; picks.push((seed + i * 53) % N); }
      function step() { if (k < n) { cells[picks[k]].className = 'path'; k++; $('pageCount').textContent = k; } else { clearInterval(timer); timer = null; } }
      if (reduce) { picks.forEach(function (p) { cells[p].className = 'path'; }); $('pageCount').textContent = n; return; }
      timer = setInterval(step, 350);
    }
    $('pageScan').addEventListener('click', scan);
    $('pageLook').addEventListener('click', look);
    ['pageExp', 'pageRow', 'pageEng'].forEach(function (i) { $(i).addEventListener('input', function () { clear(); stats(); }); });
    stats();
  }

  crashLab(); lagLab(); lockLab(); pageLab();
})();
