/* Five minutes of review: questions from the lessons you have read come back
   on a schedule (1, 3, 7, 16, 35 days), so they stick. Kept in this browser. */
(function () {
  var box = document.getElementById('reviewDeck'), sec = document.getElementById('review');
  if (!box || !sec) return;
  var GAP = [1, 3, 7, 16, 35], DAY = 864e5, KEY = 'hdw-review-v1';
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { return {}; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var read = load('hdw-read-v1'), st = load(KEY);
  var xhr = new XMLHttpRequest();
  try { xhr.open('GET', box.getAttribute('data-src')); } catch (e) { return; }
  xhr.onload = function () { if (xhr.status !== 200) return; var cards; try { cards = JSON.parse(xhr.responseText); } catch (e) { return; } start(cards); };
  try { xhr.send(); } catch (e) {}

  function when(t) {
    var d = Math.round((t - Date.now()) / DAY);
    return d <= 0 ? 'today' : (d === 1 ? 'tomorrow' : 'in ' + d + ' days');
  }
  function start(cards) {
    var mine = cards.filter(function (c) { return read[c.page]; });
    if (!mine.length) return;
    sec.hidden = false;
    var now = Date.now();
    var due = mine.filter(function (c) { return !st[c.id] || st[c.id].due <= now; });
    due.sort(function (a, b) { return (st[a.id] ? st[a.id].due : 9e15) - (st[b.id] ? st[b.id].due : 9e15); });
    var lessons = {}; mine.forEach(function (c) { lessons[c.page] = 1; });
    var session = due.slice(0, 5), i = 0, right = 0;
    function grade(c, ok) {
      var b = st[c.id] ? st[c.id].box : -1;
      b = ok ? Math.min(b + 1, GAP.length - 1) : 0;
      st[c.id] = { box: b, due: Date.now() + (ok ? GAP[b] : 1) * DAY };
      save(KEY, st); if (ok) right++;
    }
    function summary() {
      var later = mine.filter(function (c) { return st[c.id]; }).map(function (c) { return st[c.id].due; }).sort(function (a, b) { return a - b; });
      var more = mine.filter(function (c) { return !st[c.id] || st[c.id].due <= Date.now(); }).length;
      box.innerHTML = '<div class="rv-card rv-end"><div class="rv-meta">' + (session.length ? 'Done for now' : 'Nothing due') + '</div>' +
        (session.length ? '<p class="rv-q">You knew ' + right + ' of ' + session.length + '.</p>' : '<p class="rv-q">You are up to date.</p>') +
        '<p class="rv-sub">' + mine.length + ' questions from the ' + Object.keys(lessons).length + ' lessons you have read. ' + (later.length ? 'The next one comes back ' + when(later[0]) + '.' : '') + '</p>' +
        (more ? '<button type="button" class="labbtn rv-more">Review ' + Math.min(5, more) + ' more</button>' : '') + '</div>';
      var m = box.querySelector('.rv-more');
      if (m) m.addEventListener('click', function () { start(cards); });
    }
    function show() {
      if (i >= session.length) { summary(); return; }
      var c = session[i], h = '<div class="rv-card"><div class="rv-meta">' + (i + 1) + ' of ' + session.length + ' · from <a href="/' + esc(c.page.replace('index.html', '')) + '">' + esc(c.title) + '</a>' + (st[c.id] ? '' : ' · new') + '</div><p class="rv-q">' + esc(c.q) + '</p>';
      if (c.kind === 'mc') h += '<div class="rv-opts">' + c.opts.map(function (o, k) { return '<button type="button" class="rv-opt" data-k="' + k + '">' + esc(o) + '</button>'; }).join('') + '</div><div class="rv-after" hidden></div>';
      else h += '<p class="rv-sub">Answer it in your head first.</p><button type="button" class="labbtn rv-show">Show my answer</button><div class="rv-after" hidden></div>';
      box.innerHTML = h + '</div>';
      var after = box.querySelector('.rv-after');
      if (c.kind === 'mc') {
        box.querySelector('.rv-opts').addEventListener('click', function (e) {
          var b = e.target.closest('.rv-opt'); if (!b || after.hidden === false) return;
          var k = +b.getAttribute('data-k'), ok = k === c.a;
          Array.prototype.forEach.call(box.querySelectorAll('.rv-opt'), function (x, n) { x.disabled = true; if (n === c.a) x.classList.add('right'); else if (n === k) x.classList.add('wrong'); });
          grade(c, ok);
          after.hidden = false;
          after.innerHTML = '<p class="rv-why"><b>' + (ok ? 'Right.' : 'Not quite.') + '</b> ' + esc(c.why) + '</p><button type="button" class="rv-next">Next</button>';
          after.querySelector('.rv-next').addEventListener('click', function () { i++; show(); });
          after.querySelector('.rv-next').focus();
        });
      } else {
        box.querySelector('.rv-show').addEventListener('click', function () {
          this.hidden = true; after.hidden = false;
          after.innerHTML = '<div class="rv-ans">' + c.ans + '</div><div class="rv-grade"><button type="button" class="rv-next" data-ok="1">I knew it</button><button type="button" class="labbtn" data-ok="0">Not yet</button></div>';
          Array.prototype.forEach.call(after.querySelectorAll('[data-ok]'), function (b) { b.addEventListener('click', function () { grade(c, b.getAttribute('data-ok') === '1'); i++; show(); }); });
        });
      }
    }
    show();
  }
})();
