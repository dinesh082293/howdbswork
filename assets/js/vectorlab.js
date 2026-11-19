/* Vector search lab: the recall/speed curve and the filter strategies measured
   in Notebook 8, and an index-size estimate built from its measured bytes.
   Mount: <div class="vectorlab"></div> */
(function () {
  var EF = [10, 20, 40, 80, 160, 400];
  var REC = [0.797, 0.863, 0.950, 0.985, 1.000, 1.000];
  var MED = [0.60, 0.59, 0.65, 0.71, 0.81, 2.64];
  var P95 = [1.10, 0.85, 1.08, 2.17, 1.40, 3.62];
  var FILT = [
    ['HNSW, then filter (ef_search 40)', 1.3, 0.130, 0.76, 'The index hands back about 40 candidates; 99% belong to other tenants.'],
    ['HNSW, then filter (ef_search 400)', 4.8, 0.477, 3.89, 'Ten times the candidates, still under half the rows, five times slower.'],
    ['HNSW with iterative scan (relaxed_order)', 10, 0.906, 8.96, 'Keeps scanning until ten rows pass the filter. Complete, slower.'],
    ['Tenant index, then exact distance', 10, 1.000, 2.66, '1,000 rows per tenant: exact and fast. The best choice for small tenants.']
  ];
  function chart(vals, fmt, yMin, yMax, sel, label) {
    var W = 320, H = 150, L = 40, R = 10, T = 12, B = 28;
    var x = function (i) { return L + (W - L - R) * i / (EF.length - 1); };
    var y = function (v) { return T + (H - T - B) * (1 - (v - yMin) / (yMax - yMin)); };
    var g = '', ticks = [yMin, (yMin + yMax) / 2, yMax];
    ticks.forEach(function (t) { g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(t) + '" y2="' + y(t) + '" class="vl-grid"/><text x="' + (L - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end" class="vl-ax">' + fmt(t) + '</text>'; });
    EF.forEach(function (e, i) { g += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" class="vl-ax">' + e + '</text>'; });
    var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + x(i) + ',' + y(v); }).join(' ');
    g += '<path d="' + d + '" class="vl-line"/>';
    vals.forEach(function (v, i) {
      g += '<circle cx="' + x(i) + '" cy="' + y(v) + '" r="' + (i === sel ? 6 : 4) + '" class="vl-pt' + (i === sel ? ' on' : '') + '"><title>ef_search ' + EF[i] + ': ' + fmt(v) + '</title></circle>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + label + '">' + g + '</svg>';
  }
  function fmtB(b) { var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0; while (b >= 1000 && i < 4) { b /= 1000; i++; } return (b >= 100 ? b.toFixed(0) : b.toFixed(1)) + ' ' + u[i]; }
  function mount(el) {
    el.innerHTML =
      '<div class="vl-card"><h3>1. Recall against speed</h3><p class="vl-sub">100,000 vectors, top 10, 200 searches at each setting. Move the slider.</p>' +
      '<label class="vl-sl">hnsw.ef_search = <b class="vl-ef">40</b><input type="range" min="0" max="5" step="1" value="2" aria-label="ef_search"></label>' +
      '<div class="vl-tiles"><div><span>Recall at 10</span><b class="vl-rec"></b></div><div><span>Median</span><b class="vl-med"></b></div><div><span>95th percentile</span><b class="vl-p95"></b></div></div>' +
      '<div class="vl-charts"><figure><figcaption>Recall at 10</figcaption><div class="vl-c1"></div></figure><figure><figcaption>Median time, ms</figcaption><div class="vl-c2"></div></figure></div>' +
      '<p class="vl-read"></p></div>' +
      '<div class="vl-card"><h3>2. One tenant\'s top 10</h3><p class="vl-sub">Each tenant holds 1% of the vectors. Pick how the filter is applied.</p><div class="vl-opts" role="radiogroup"></div><div class="vl-tiles vl-ft"></div><p class="vl-read vl-fr"></p></div>' +
      '<div class="vl-card"><h3>3. Will the index fit in memory?</h3><p class="vl-sub">An estimate from Notebook 8\'s measured sizes: the vector itself, plus about 512 bytes of graph links at m = 16, scaled with m.</p>' +
      '<div class="vl-form"><label>Vectors<input type="number" class="vl-n" value="20000000" min="1000" step="1000000"></label><label>Dimensions<select class="vl-d"><option>384</option><option>768</option><option>1024</option><option selected>1536</option><option>3072</option></select></label>' +
      '<label>Stored as<select class="vl-t"><option value="4" selected>vector (4 bytes)</option><option value="2">halfvec (2 bytes)</option></select></label><label>m<select class="vl-m"><option>8</option><option selected>16</option><option>32</option></select></label><label>Server memory, GB<input type="number" class="vl-ram" value="128" min="1"></label></div>' +
      '<div class="vl-tiles vl-mt"></div><p class="vl-read vl-mr"></p></div>' +
      '<p class="vl-note">Numbers from <a href="../notebooks/index.html#agent-memory">Notebook 8</a>: PostgreSQL 18.7, pgvector 0.8.7, generated 384-dimension vectors. Treat recall as the shape of the curve, not a promise for your data.</p>';
    var sl = el.querySelector('input[type=range]');
    function draw() {
      var i = +sl.value;
      el.querySelector('.vl-ef').textContent = EF[i];
      el.querySelector('.vl-rec').textContent = REC[i].toFixed(3);
      el.querySelector('.vl-med').textContent = MED[i].toFixed(2) + ' ms';
      el.querySelector('.vl-p95').textContent = P95[i].toFixed(2) + ' ms';
      el.querySelector('.vl-c1').innerHTML = chart(REC, function (v) { return v.toFixed(2); }, 0.75, 1, i, 'Recall at 10 by ef_search');
      el.querySelector('.vl-c2').innerHTML = chart(MED, function (v) { return v.toFixed(1); }, 0, 3, i, 'Median milliseconds by ef_search');
      var msg = i < 2 ? 'Fast, and it misses ' + Math.round((1 - REC[i]) * 100) + '% of the true neighbours. Fine for suggestions; poor for retrieval an AI answer depends on.'
        : i < 4 ? 'The usual sweet spot: nearly every true neighbour, still under a millisecond at the median.'
        : i === 4 ? 'Every true neighbour found, for about a third more time than the default.'
        : 'No better than 160 here, and three times slower. Past the point of full recall, a bigger ef_search only costs time.';
      el.querySelector('.vl-read').textContent = msg;
      if (i >= 4 && window.HDW_GOALS) HDW_GOALS.done('vector-lab', 'full');
    }
    sl.addEventListener('input', draw);
    var opts = el.querySelector('.vl-opts');
    FILT.forEach(function (f, k) {
      var b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = f[0];
      b.addEventListener('click', function () { pick(k); }); opts.appendChild(b);
    });
    function pick(k) {
      Array.prototype.forEach.call(opts.children, function (b, j) { b.setAttribute('aria-checked', String(j === k)); });
      var f = FILT[k];
      el.querySelector('.vl-ft').innerHTML = '<div><span>Rows returned</span><b>' + f[1] + ' of 10</b></div><div><span>Recall at 10</span><b>' + f[2].toFixed(3) + '</b></div><div><span>Median</span><b>' + f[3].toFixed(2) + ' ms</b></div>';
      el.querySelector('.vl-fr').textContent = f[4];
      if (k >= 2 && window.HDW_GOALS) HDW_GOALS.done('vector-lab', 'filter');
    }
    function mem() {
      var n = +el.querySelector('.vl-n').value || 0, d = +el.querySelector('.vl-d').value, t = +el.querySelector('.vl-t').value, m = +el.querySelector('.vl-m').value, ram = (+el.querySelector('.vl-ram').value || 0) * 1e9;
      var idx = n * (d * t + 32 * m), tbl = n * (d * t + 105);
      el.querySelector('.vl-mt').innerHTML = '<div><span>HNSW index</span><b>' + fmtB(idx) + '</b></div><div><span>Table</span><b>' + fmtB(tbl) + '</b></div><div><span>Index as share of memory</span><b>' + (ram ? Math.round(100 * idx / ram) + '%' : 'n/a') + '</b></div>';
      var r = !ram ? '' : idx > ram ? 'The index alone is bigger than the server\'s memory, so searches would read from disk and slow down badly. Try halfvec, fewer dimensions, or splitting the data.'
        : idx > ram * 0.6 ? 'It fits, barely. The table, the rest of the database and the operating system also need memory. Plan for halfvec or more memory before it grows.'
        : 'It fits with room to spare.';
      el.querySelector('.vl-mr').textContent = r;
      if (ram && idx > ram && window.HDW_GOALS) el.dataset.over = '1';
      if (ram && idx <= ram * 0.6 && el.dataset.over && window.HDW_GOALS) HDW_GOALS.done('vector-lab', 'fit');
    }
    el.querySelectorAll('.vl-form input,.vl-form select').forEach(function (x) { x.addEventListener('input', mem); x.addEventListener('change', mem); });
    draw(); pick(0); mem();
    if (window.HDW_GOALS) HDW_GOALS.attach(el, 'vector-lab', [['full', 'Find the lowest ef_search that reaches full recall'], ['filter', 'Find a filter strategy that returns all 10 rows'], ['fit', 'Start from a server where the index does not fit, then change one setting until it does']]);
  }
  document.querySelectorAll('.vectorlab').forEach(mount);
})();
