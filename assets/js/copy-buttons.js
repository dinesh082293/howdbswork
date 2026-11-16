/* Copy buttons for every command block on the site.
   Runs on every page. Adds one small button to each .lookcmd,
   pre.term, and pre.evidence block. Clicking copies the block text
   with the clipboard API, falling back to a textarea selection.
   Written from scratch for this site. */
(function () {
  function blocks() {
    var out = [];
    var sels = ['.lookcmd', 'pre.term', 'pre.evidence'];
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length; j++) out.push(nodes[j]);
    }
    return out;
  }
  function copyText(text, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, btn, done); });
    } else {
      fallback(text, btn, done);
    }
  }
  function fallback(text, btn, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'Copy failed'; }
    document.body.removeChild(ta);
  }
  var list = blocks();
  for (var k = 0; k < list.length; k++) {
    (function (el) {
      if (el.querySelector('.copybtn')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copybtn';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy this command');
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        copyText(el.innerText, btn);
      });
      el.style.position = 'relative';
      el.appendChild(btn);
    })(list[k]);
  }
})();
