/* Animated commit: one change moving from memory to the log to the data file.
   Step through it, or press Play. With reduced motion, the dot jumps instead of sliding. */
(function () {
  var fig = document.getElementById('commitAnim');
  if (!fig) return;
  var reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var E = {
    pg: { names: ['shared_buffers', 'WAL buffers', 'pg_wal/', 'base/'], cap: [
      'Press Play, or step through it.',
      'The new row version goes into an 8 KB page in shared_buffers. The page is now dirty, and nothing on disk has changed.',
      'A WAL record describing the change goes into the WAL buffers, still in memory.',
      'COMMIT: the WAL is written to pg_wal/ and flushed with fsync. This is the wait the client feels.',
      'COMMIT returns to the client. The table file has still not changed, and it does not need to: the WAL can rebuild the change after a crash.',
      'Later, the checkpointer or the background writer writes the dirty page to base/. WAL from before the checkpoint can then be recycled.'] },
    my: { names: ['buffer pool', 'log buffer', 'redo + binlog', 'users.ibd'], cap: [
      'Press Play, or step through it.',
      'The row changes in a 16 KB page in the buffer pool. The old version goes to the undo log.',
      'A redo record goes into the log buffer, and the change is staged for the binlog.',
      'COMMIT: the redo log and the binlog are flushed in a two-phase commit, so the two agree after a crash.',
      'COMMIT returns to the client. users.ibd has not changed yet.',
      'Later, page cleaner threads write the page, first to the doublewrite files, then to users.ibd.'] },
    mo: { names: ['WiredTiger cache', 'journal buffer', 'journal/', 'collection-*.wt'], cap: [
      'Press Play, or step through it.',
      'The document change is applied in the WiredTiger cache. On a replica set, its oplog entry is written in the same transaction.',
      'A journal record is written to the journal buffer.',
      'With j: true, the journal is flushed to journal/ before the write is acknowledged. Without it, the flush happens within about 100 ms.',
      'The write is acknowledged to the client. collection-*.wt has not changed yet.',
      'Later, a checkpoint, about every 60 seconds, writes the cache to collection-*.wt.'] }
  };
  // dot positions: client, memory, log buffer, log on disk, client (ack), data file
  var P = [[85, 72], [250, 72], [425, 72], [600, 152], [85, 72], [775, 152]];
  var eng = 'pg', step = 0, timer = null, raf = null;
  var dot = fig.querySelector('.ca-dot'), cap = fig.querySelector('.ca-cap'), cnt = fig.querySelector('.ca-count');
  var boxes = fig.querySelectorAll('.ca-box'), labels = fig.querySelectorAll('.ca-name'), ok = fig.querySelector('.ca-ok');
  function place(x, y) { dot.setAttribute('cx', x); dot.setAttribute('cy', y); }
  function move(to) {
    if (raf && window.cancelAnimationFrame) cancelAnimationFrame(raf);
    var x0 = +dot.getAttribute('cx'), y0 = +dot.getAttribute('cy'), t0 = null, d = 650;
    if (reduce || !window.requestAnimationFrame) { place(to[0], to[1]); return; }
    function f(t) {
      if (!t0) t0 = t;
      var k = Math.min(1, (t - t0) / d), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      place(x0 + (to[0] - x0) * e, y0 + (to[1] - y0) * e);
      if (k < 1) raf = requestAnimationFrame(f);
    }
    raf = requestAnimationFrame(f);
  }
  function render() {
    var n = E[eng].names;
    for (var i = 0; i < 4; i++) labels[i].textContent = n[i];
    for (var j = 0; j < boxes.length; j++) {
      var active = (step === 1 && j === 0) || (step === 2 && j === 1) || (step === 3 && j === 2) || (step === 5 && j === 3);
      boxes[j].classList.toggle('on', active);
    }
    ok.style.opacity = step >= 4 ? 1 : 0;
    cap.textContent = E[eng].cap[step];
    cnt.textContent = step === 0 ? 'Step 0 of 5' : 'Step ' + step + ' of 5';
    move(P[step]);
  }
  function next() { if (step < 5) { step++; render(); } else stop(); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } fig.querySelector('.ca-play').textContent = 'Play'; }
  fig.querySelector('.ca-play').addEventListener('click', function () {
    if (timer) { stop(); return; }
    if (step === 5) { step = 0; render(); }
    this.textContent = 'Pause';
    timer = setInterval(function () { if (step >= 5) stop(); else next(); }, reduce ? 2600 : 2200);
    next();
  });
  fig.querySelector('.ca-step').addEventListener('click', function () { stop(); if (step === 5) step = 0; else step++; render(); });
  fig.querySelector('.ca-reset').addEventListener('click', function () { stop(); step = 0; render(); });
  Array.prototype.forEach.call(fig.querySelectorAll('input[name="caEng"]'), function (r) {
    r.addEventListener('change', function () { eng = r.value; render(); });
  });
  render();
})();
