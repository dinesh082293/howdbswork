/* Where the bill goes: enter your monthly bill lines, see them sorted, with the share
   of the total and the first lever for each. The starting numbers are an example. */
(function () {
  var root = document.getElementById('billChart');
  if (!root) return;
  var LINES = [
    ['bCompute', 'Compute', 'Patterns 1 and 6: size for the measured load, pool connections', '#patterns'],
    ['bStorage', 'Storage', 'Patterns 4 and 5: drop unused indexes, let old data leave', '#patterns'],
    ['bIO', 'I/O', 'Pattern 2: provision to the peak plus a margin, fix scans', '#patterns'],
    ['bBackup', 'Backups', 'Review retention against what is actually required', '#breaks'],
    ['bNet', 'Network', 'Keep applications in the same zone as the primary', '#where'],
    ['bNonprod', 'Non-production', 'Smaller copies, stopped at night and on weekends', '#where']
  ];
  function v(id) { var n = parseFloat(document.getElementById(id).value); return isFinite(n) && n > 0 ? n : 0; }
  function money(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function esc(s) { return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function draw() {
    var rows = LINES.map(function (l) { return { name: l[1], lever: l[2], href: l[3], val: v(l[0]) }; })
      .sort(function (a, b) { return b.val - a.val; });
    var total = rows.reduce(function (s, r) { return s + r.val; }, 0) || 1, max = rows[0].val || 1;
    var W = 760, L = 130, R = 150, bh = 22, gap = 12, H = rows.length * (bh + gap) + 10;
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Monthly bill by line, largest first" xmlns="http://www.w3.org/2000/svg" style="font-family:IBM Plex Sans,sans-serif">';
    rows.forEach(function (r, i) {
      var y = 6 + i * (bh + gap), w = Math.max(2, (W - L - R) * r.val / max), rr = Math.min(4, w);
      s += '<text x="' + (L - 10) + '" y="' + (y + 15) + '" text-anchor="end" style="fill:var(--ink);font-size:13px;font-weight:600">' + esc(r.name) + '</text>';
      s += '<path d="M' + L + ',' + y + ' H' + (L + w - rr) + ' Q' + (L + w) + ',' + y + ' ' + (L + w) + ',' + (y + rr) + ' V' + (y + bh - rr) + ' Q' + (L + w) + ',' + (y + bh) + ' ' + (L + w - rr) + ',' + (y + bh) + ' H' + L + ' Z" style="fill:var(--' + (i === 0 ? 'viz-b' : 'viz-a') + ')"><title>' + esc(r.name) + ': ' + money(r.val) + ' per month, ' + Math.round(100 * r.val / total) + '% of the bill</title></path>';
      s += '<text x="' + (L + w + 8) + '" y="' + (y + 15) + '" style="fill:var(--ink);font-size:12px">' + money(r.val) + ' (' + Math.round(100 * r.val / total) + '%)</text>';
    });
    s += '<line x1="' + L + '" x2="' + L + '" y1="2" y2="' + (H - 2) + '" style="stroke:var(--muted)"/></svg>';
    document.getElementById('billSvg').innerHTML = s;
    var top = rows[0];
    document.getElementById('billNote').innerHTML = 'Total per month: <b>' + money(total) + '</b>. The largest line is <b>' + esc(top.name) + '</b>, ' +
      Math.round(100 * top.val / total) + '% of the bill. Start there: ' + esc(top.lever) + ' (<a href="' + top.href + '">see below</a>).';
    document.getElementById('billLevers').innerHTML = rows.map(function (r) {
      return '<li><b>' + esc(r.name) + ':</b> ' + esc(r.lever) + '</li>';
    }).join('');
  }
  LINES.forEach(function (l) { document.getElementById(l[0]).addEventListener('input', draw); });
  draw();
})();
