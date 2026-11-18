/* Capacity calculator. Round-number assumptions, all stated on the page. */
(function () {
  var ids = ['cRows', 'cRowB', 'cIdx', 'cIdxB', 'cDay', 'cRet', 'cMon', 'cHot', 'cW', 'cConn', 'cCopies'];
  if (!document.getElementById('cOut')) return;
  function v(id) { var n = parseFloat(document.getElementById(id).value); return isFinite(n) && n >= 0 ? n : 0; }
  function sz(b) {
    var u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (b >= 100 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i];
  }
  function fmt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function calc() {
    var rows = v('cRows'), rowB = v('cRowB'), idx = v('cIdx'), idxB = v('cIdxB'), day = v('cDay'), ret = v('cRet'),
        mon = v('cMon'), hot = Math.min(100, v('cHot')) / 100, w = v('cW'), conn = v('cConn'), copies = Math.max(1, v('cCopies'));
    var days = mon * 30.4;
    var rowsH = ret > 0 ? (days >= ret ? day * ret : Math.min(rows + day * days, Math.max(rows, day * ret))) : rows + day * days;
    var perRow = rowB * 1.25 + (idx + 1) * idxB * 1.4;
    var now = rows * perRow, later = rowsH * perRow;
    var peak = Math.max(now, later); // with retention, today's data can be the larger of the two
    var ws = peak * hot;
    var mem = ws * 1.3 + 2 * Math.pow(1024, 3) + conn * 10 * Math.pow(1024, 2);
    var disk = peak * 1.3 / 0.7;
    var logDay = w * (rowB + idx * idxB) * 1.5 * 86400;
    var cards = [
      ['Rows in ' + mon + ' months', fmt(rowsH)],
      ['Data and indexes today', sz(now)],
      ['Data and indexes in ' + mon + ' months', sz(later)],
      ['Working set (hot share)', sz(ws)],
      ['Memory per server', sz(mem)],
      ['Disk per server', sz(disk)],
      ['Disk across ' + copies + ' copies', sz(disk * copies)],
      ['Log volume per day at peak rate', sz(logDay)]
    ];
    document.getElementById('cOut').innerHTML = cards.map(function (c) { return '<div><b>' + c[1] + '</b>' + c[0] + '</div>'; }).join('');
    var notes = [];
    if (ret === 0) notes.push('No retention: the data grows for as long as the system runs. Decide what happens to rows older than you need.');
    if (ws > 256 * Math.pow(1024, 3)) notes.push('The working set is over 256 GB. Check whether the hot share is really this large, or plan to partition or shard.');
    if (w > 5000) notes.push('Above a few thousand writes per second, batch inserts where you can. One commit per row caps the rate (Notebook 2).');
    notes.push('Peak log volume runs all day here, so treat it as an upper bound. It is what replicas, backups and CDC consumers must keep up with.');
    document.getElementById('cNotes').innerHTML = '<ul style="margin:6px 0 0;padding-left:20px">' + notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>';
  }
  ids.forEach(function (i) { document.getElementById(i).addEventListener('input', calc); });
  calc();
})();
