/* Show one engine at a time on long pages.
   Markup: a bar  <div class="ev-bar"><button data-eng="pg">… <button data-eng="all">…</div>
   and blocks     <div class="ev-block" data-eng="pg">…</div>
   Starts on the engine of the block a link points into, else the bar's
   data-default, else the reader's engine (HDW_ENGINE), else all. Without JavaScript every block shows. */
(function () {
  var bars = document.querySelectorAll('.ev-bar');
  if (!bars.length) return;
  document.body.classList.add('ev-js');
  function show(e) {
    document.body.setAttribute('data-ev', e);
    Array.prototype.forEach.call(document.querySelectorAll('.ev-bar button'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-eng') === e));
    });
    var n = document.querySelectorAll('.ev-block').length, shown = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.ev-block'), function (b) { if (e === 'all' || b.getAttribute('data-eng') === e) shown++; });
    Array.prototype.forEach.call(document.querySelectorAll('.ev-count'), function (c) { c.textContent = e === 'all' ? 'All engines' : 'Showing ' + shown + ' of ' + n; });
    document.dispatchEvent(new CustomEvent('ev-change', { detail: e }));
  }
  Array.prototype.forEach.call(document.querySelectorAll('.ev-bar button'), function (b) {
    b.addEventListener('click', function () {
      var e = b.getAttribute('data-eng'); show(e);
      if (e !== 'all' && window.HDW_ENGINE) HDW_ENGINE.set(e);
    });
  });
  function fromHash() {
    var id = location.hash.slice(1), t = id && document.getElementById(id);
    var blk = t && t.closest && t.closest('.ev-block');
    return blk ? blk.getAttribute('data-eng') : null;
  }
  var start = fromHash() || bars[0].getAttribute('data-default') || (window.HDW_ENGINE && HDW_ENGINE.get()) || bars[0].getAttribute('data-fallback') || 'all';
  show(start);
  window.addEventListener('hashchange', function () { var e = fromHash(); if (e && document.body.getAttribute('data-ev') !== 'all') show(e); });
})();
