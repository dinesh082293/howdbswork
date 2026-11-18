/* Reading time under the page title, and print buttons for the cheat sheet.
   Runs on every page. Reading time appears only on pages that have a question line. */
(function () {
  function readingTime() {
    var hero = document.querySelector('.hero .wrap') || (document.querySelector('h1') && document.querySelector('h1').parentNode);
    if (!hero || !hero.querySelector('.qline') || hero.querySelector('.readtime')) return;
    var clone = document.body.cloneNode(true), drop = ['nav', 'footer', 'script', 'style', 'pre', '.sitesearch', '.labctl', '.nextpage'];
    drop.forEach(function (sel) { Array.prototype.forEach.call(clone.querySelectorAll(sel), function (n) { n.remove(); }); });
    var words = (clone.textContent || '').trim().split(/\s+/).length;
    var min = Math.max(1, Math.round(words / 220));
    var p = document.createElement('p');
    p.className = 'readtime';
    p.textContent = min + ' min read';
    var anchor = hero.querySelector('.learn') || hero.querySelector('.qline');
    anchor.insertAdjacentElement('afterend', p);
  }
  function printButtons() {
    var btns = document.querySelectorAll('[data-print-engine]');
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-print-engine');
        if (v === 'all') document.body.removeAttribute('data-print'); else document.body.setAttribute('data-print', v);
        window.print();
      });
    });
    window.addEventListener('afterprint', function () { document.body.removeAttribute('data-print'); });
  }
  try { readingTime(); } catch (e) {}
  try { printButtons(); } catch (e) {}
})();
