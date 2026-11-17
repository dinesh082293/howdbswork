/* Animated failover for the Decisions page, section 5.
   A scripted walkthrough of a primary dying: detect, decide by LSN,
   promote the most advanced standby, resume writes. The numbers are the
   page's own: 2,000 commits/s, 5 s of lag, 20 to 30 s detection on
   Patroni defaults. Sync mode loses 0, async loses lag times rate. */
(function () {
  'use strict';

  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('failoverWidget')) { return; }

  var widget = document.getElementById('failoverWidget');
  var statusEl = document.getElementById('foStatus');
  var commitsEl = document.getElementById('foCommits');
  var lostEl = document.getElementById('foLost');
  var mode = 'sync';

  var nodes = {
    p: { el: document.getElementById('foNodeP'), lsn: document.getElementById('foLsnP'), state: document.getElementById('foStateP') },
    s1: { el: document.getElementById('foNodeS1'), lsn: document.getElementById('foLsnS1'), state: document.getElementById('foStateS1') },
    s2: { el: document.getElementById('foNodeS2'), lsn: document.getElementById('foLsnS2'), state: document.getElementById('foStateS2') }
  };

  var commits = 0;
  var lsnP = 0x3A4F900;
  var lsnS1 = 0x3A4F900;
  var lsnS2 = 0x3A4F800;
  var ticker = null;
  var timers = [];
  var running = false;

  function hex(n) { return '0/' + n.toString(16).toUpperCase(); }

  function setStatus(text) { if (statusEl) { statusEl.textContent = text; } }

  function paint() {
    if (nodes.p.lsn) { nodes.p.lsn.textContent = 'LSN ' + hex(lsnP); }
    if (nodes.s1.lsn) { nodes.s1.lsn.textContent = 'LSN ' + hex(lsnS1); }
    if (nodes.s2.lsn) { nodes.s2.lsn.textContent = 'LSN ' + hex(lsnS2); }
    if (commitsEl) { commitsEl.textContent = commits.toLocaleString('en-US') + ' commits accepted'; }
  }

  function setNode(key, cls, state) {
    var n = nodes[key];
    if (!n || !n.el) { return; }
    n.el.classList.remove('fo-primary', 'fo-standby', 'fo-dead', 'fo-winner');
    if (cls) { n.el.classList.add(cls); }
    if (n.state) { n.state.textContent = state; }
  }

  function clearTimers() {
    for (var i = 0; i < timers.length; i++) { clearTimeout(timers[i]); }
    timers = [];
  }

  function stopTicker() {
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(function () {
      commits += 1000;
      lsnP += 1000;
      lsnS1 += 1000;
      lsnS2 += 800;
      paint();
    }, 500);
  }

  function step(delay, fn) {
    timers.push(setTimeout(fn, delay));
  }

  function kill() {
    if (running) { return; }
    running = true;
    stopTicker();
    var killBtn = document.getElementById('foKill');
    if (killBtn) { killBtn.disabled = true; }
    setNode('p', 'fo-dead', 'DEAD, no heartbeat');
    setNode('s1', 'fo-standby', 'standby, waiting');
    setNode('s2', 'fo-standby', 'standby, waiting');
    if (lostEl) { lostEl.textContent = ''; }
    setStatus('The primary is gone. Commits stop. Nothing is accepted anywhere until a new primary exists.');
    step(2200, function () {
      setStatus('Detect: 20 to 30 seconds pass. Patroni\'s leader key expires. This is the longest part of the outage, and it is just waiting.');
    });
    step(4600, function () {
      setStatus('Decide: the standbys compare LSNs. S1 is at ' + hex(lsnS1) + ', S2 at ' + hex(lsnS2) + '. S1 is the most advanced, so S1 wins. Picking the standby that answers first would lose writes.');
    });
    step(7000, function () {
      setNode('s1', 'fo-winner', 'WINNER, promoting');
      setStatus('Promote: S1 replays its small backlog and becomes the new primary. The old primary is fenced, so it cannot accept writes when it comes back.');
    });
    step(9400, function () {
      setNode('s1', 'fo-primary', 'PRIMARY, accepting writes');
      setNode('p', 'fo-dead', 'fenced, old primary');
      setNode('s2', 'fo-standby', 'standby, following S1');
      startTicker();
      if (mode === 'sync') {
        if (lostEl) { lostEl.textContent = 'Lost: 0 commits. Every commit had been ACKed by S1 before it returned.'; }
        setStatus('Writes resume. Total outage: tens of seconds, dominated by detection. Synchronous replication bought RPO 0 at the price of one ACK per commit.');
      } else {
        var lagSeconds = 5;
        var lost = 2000 * lagSeconds;
        if (lostEl) { lostEl.textContent = 'Lost: ' + lost.toLocaleString('en-US') + ' acknowledged commits. 5 s of lag at 2,000 commits/s, and none of them were on S1.'; }
        setStatus('Writes resume. Total outage: tens of seconds, dominated by detection. Async replication cost nothing per commit, and this failover is where the bill arrives.');
      }
      running = false;
      if (killBtn) { killBtn.disabled = false; }
    });
  }

  function reset() {
    clearTimers();
    stopTicker();
    running = false;
    commits = 0;
    lsnP = 0x3A4F900;
    lsnS1 = 0x3A4F900;
    lsnS2 = 0x3A4F800;
    setNode('p', 'fo-primary', 'PRIMARY, accepting writes');
    setNode('s1', 'fo-standby', 'standby, synchronous');
    setNode('s2', 'fo-standby', 'standby, asynchronous');
    if (lostEl) { lostEl.textContent = ''; }
    setStatus('Healthy: the primary accepts writes, S1 ACKs every commit before it returns, S2 trails a little behind. Press Kill the primary to watch the failover.');
    var killBtn = document.getElementById('foKill');
    if (killBtn) { killBtn.disabled = false; }
    paint();
    startTicker();
  }

  var killBtn = document.getElementById('foKill');
  if (killBtn) { killBtn.addEventListener('click', kill); }
  var resetBtn = document.getElementById('foReset');
  if (resetBtn) { resetBtn.addEventListener('click', reset); }

  var seg = document.getElementById('foSeg');
  if (seg) {
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || running) { return; }
      seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
      b.setAttribute('aria-pressed', 'true');
      mode = b.getAttribute('data-mode');
      reset();
      setStatus(mode === 'sync'
        ? 'Synchronous: S1 ACKs every commit before it returns. A failover loses nothing. Press Kill the primary.'
        : 'Asynchronous: commits return at once, S1 trails by about 5 s. A failover loses that window. Press Kill the primary.');
    });
  }

  reset();
})();
