/* Real stories: fold each story after its opening, and filter by kind of
   failure (the engine filter is engineview.js). Links into a story open it. */
(function () {
  var stories = document.querySelectorAll('.incident[data-kind]');
  Array.prototype.forEach.call(stories, function (st) {
    var kids = Array.prototype.slice.call(st.children), h3 = st.querySelector('h3');
    var start = kids.indexOf(h3) + 2;           // keep the tag, the title and the opening block
    var rest = kids.slice(start);
    if (rest.length < 2) return;
    var words = rest.map(function (k) { return k.textContent; }).join(' ').split(/\s+/).length;
    var d = document.createElement('details'); d.className = 'st-more';
    var sm = document.createElement('summary'); sm.textContent = 'Read the whole story · ' + Math.max(1, Math.round(words / 220)) + ' min';
    d.appendChild(sm);
    rest.forEach(function (k) { d.appendChild(k); });
    st.appendChild(d);
  });
  function openFor(id) { var t = id && document.getElementById(id); if (!t) return; var d = t.querySelector('details.st-more'); if (d) d.open = true; }
  openFor(location.hash.slice(1));
  window.addEventListener('hashchange', function () { openFor(location.hash.slice(1)); });
  document.addEventListener('click', function (e) { var a = e.target.closest && e.target.closest('a[href^="#"]'); if (a) openFor(a.getAttribute('href').slice(1)); });
  var kind = '';
  function apply() {
    var any = 0;
    Array.prototype.forEach.call(stories, function (st) {
      var on = !kind || (' ' + st.getAttribute('data-kind') + ' ').indexOf(' ' + kind + ' ') >= 0;
      st.classList.toggle('st-off', !on);
      var sec = st.closest('.ev-block'), ev = document.body.getAttribute('data-ev') || 'all';
      if (on && (ev === 'all' || (sec && sec.getAttribute('data-eng') === ev))) any++;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.ev-block'), function (sec) {
      sec.classList.toggle('st-off', !sec.querySelector('.incident[data-kind]:not(.st-off)'));
    });
    var em = document.getElementById('stEmpty'); if (em) em.hidden = any > 0;
  }
  Array.prototype.forEach.call(document.querySelectorAll('.st-kinds button'), function (b) {
    b.addEventListener('click', function () {
      kind = b.getAttribute('data-kind');
      Array.prototype.forEach.call(document.querySelectorAll('.st-kinds button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      apply();
    });
  });
  document.addEventListener('ev-change', apply);
  apply();
})();
