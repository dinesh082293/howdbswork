/* A small Redis simulator in the browser: the common commands, with replies
   shaped like redis-cli's. It is not Redis: no persistence, no replication,
   one keyspace in this tab. Mount: <div class="redissim"></div> */
(function () {
  function glob(p) { return new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); }
  function Store() { this.m = new Map(); }
  Store.prototype.get = function (k) {
    var e = this.m.get(k);
    if (e && e.exp && e.exp <= Date.now()) { this.m.delete(k); return null; }
    return e || null;
  };
  function err(t) { return { err: t }; }
  var WT = err('WRONGTYPE Operation against a key holding the wrong kind of value');
  function int(n) { return { int: n }; }
  function isInt(s) { return /^-?\d+$/.test(s); }
  function zsorted(z, rev) {
    var a = Array.from(z.entries());
    a.sort(function (x, y) { return x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0); });
    if (rev) a.reverse();
    return a;
  }
  function range(arr, s, e) {
    var n = arr.length; s = +s; e = +e;
    if (s < 0) s = Math.max(0, n + s); if (e < 0) e = n + e; if (e >= n) e = n - 1;
    return s > e ? [] : arr.slice(s, e + 1);
  }
  function fmtNum(x) { return String(+x); }
  function exec(db, argv) {
    var c = (argv[0] || '').toUpperCase(), a = argv.slice(1), e, k = a[0], i, n;
    function need(min) { return a.length < min ? err("ERR wrong number of arguments for '" + c.toLowerCase() + "' command") : null; }
    function typed(t, create) {
      e = db.get(k);
      if (!e) { if (!create) return null; e = { t: t, v: t === 'zset' || t === 'hash' ? new Map() : t === 'list' ? [] : '' }; db.m.set(k, e); }
      if (e.t !== t) return WT;
      return e;
    }
    var bad;
    switch (c) {
      case 'PING': return a.length ? a[0] : { st: 'PONG' };
      case 'SET':
        if ((bad = need(2))) return bad;
        var ex = 0, nx = false, xx = false;
        for (i = 2; i < a.length; i++) {
          var o = a[i].toUpperCase();
          if (o === 'EX') { if (!isInt(a[i + 1] || '')) return err('ERR value is not an integer or out of range'); ex = +a[++i] * 1000; }
          else if (o === 'PX') { ex = +a[++i]; } else if (o === 'NX') nx = true; else if (o === 'XX') xx = true; else return err('ERR syntax error');
        }
        var cur = db.get(k);
        if ((nx && cur) || (xx && !cur)) return null;
        db.m.set(k, { t: 'string', v: a[1], exp: ex ? Date.now() + ex : 0 });
        return { st: 'OK' };
      case 'GET': if ((bad = need(1))) return bad; e = db.get(k); if (!e) return null; if (e.t !== 'string') return WT; return e.v;
      case 'DEL': case 'UNLINK': if ((bad = need(1))) return bad; n = 0; a.forEach(function (x) { if (db.get(x)) { db.m.delete(x); n++; } }); return int(n);
      case 'EXISTS': if ((bad = need(1))) return bad; return int(a.filter(function (x) { return !!db.get(x); }).length);
      case 'TYPE': e = db.get(k); return { st: e ? e.t : 'none' };
      case 'INCR': case 'INCRBY': case 'DECR':
        if ((bad = need(c === 'INCRBY' ? 2 : 1))) return bad;
        e = db.get(k); var by = c === 'INCRBY' ? a[1] : c === 'DECR' ? '-1' : '1';
        if (!isInt(by)) return err('ERR value is not an integer or out of range');
        if (e && e.t !== 'string') return WT;
        if (e && !isInt(e.v)) return err('ERR value is not an integer or out of range');
        var v = (e ? +e.v : 0) + +by;
        if (e) e.v = String(v); else db.m.set(k, { t: 'string', v: String(v), exp: 0 });
        return int(v);
      case 'EXPIRE': if ((bad = need(2))) return bad; e = db.get(k); if (!e) return int(0); if (!isInt(a[1])) return err('ERR value is not an integer or out of range'); e.exp = Date.now() + a[1] * 1000; return int(1);
      case 'PERSIST': e = db.get(k); if (!e || !e.exp) return int(0); e.exp = 0; return int(1);
      case 'TTL': e = db.get(k); if (!e) return int(-2); if (!e.exp) return int(-1); return int(Math.max(0, Math.ceil((e.exp - Date.now()) / 1000)));
      case 'KEYS':
        if ((bad = need(1))) return bad;
        var re = glob(k), ks = []; db.m.forEach(function (_, kk) { if (db.get(kk) && re.test(kk)) ks.push(kk); });
        return { arr: ks.sort(), note: 'KEYS walks every key on the one main thread. On millions of keys it blocks every client; use SCAN in production.' };
      case 'SCAN':
        if ((bad = need(1))) return bad;
        var pat = '*'; for (i = 1; i < a.length; i++) if (a[i].toUpperCase() === 'MATCH') pat = a[++i]; else if (a[i].toUpperCase() === 'COUNT') i++;
        var r2 = glob(pat), out = []; db.m.forEach(function (_, kk) { if (db.get(kk) && r2.test(kk)) out.push(kk); });
        return { arr: ['0', { arr: out.sort() }], note: 'Real SCAN returns a few keys per call and a cursor; here everything fits in one call, so the cursor comes back as 0.' };
      case 'DBSIZE': n = 0; db.m.forEach(function (_, kk) { if (db.get(kk)) n++; }); return int(n);
      case 'FLUSHALL': case 'FLUSHDB': db.m.clear(); return { st: 'OK' };
      case 'ZADD':
        if (a.length < 3 || a.length % 2 === 0) return err("ERR wrong number of arguments for 'zadd' command");
        e = typed('zset', true); if (e && e.err) return e; n = 0;
        for (i = 1; i < a.length; i += 2) { if (isNaN(+a[i])) return err('ERR value is not a valid float'); if (!e.v.has(a[i + 1])) n++; e.v.set(a[i + 1], +a[i]); }
        return int(n);
      case 'ZINCRBY':
        if ((bad = need(3))) return bad; if (isNaN(+a[1])) return err('ERR value is not a valid float');
        e = typed('zset', true); if (e.err) return e; var nv = (e.v.get(a[2]) || 0) + +a[1]; e.v.set(a[2], nv); return fmtNum(nv);
      case 'ZSCORE': e = typed('zset'); if (!e) return null; if (e.err) return e; return e.v.has(a[1]) ? fmtNum(e.v.get(a[1])) : null;
      case 'ZCARD': e = typed('zset'); if (!e) return int(0); if (e.err) return e; return int(e.v.size);
      case 'ZRANGE': case 'ZREVRANGE':
        if ((bad = need(3))) return bad;
        e = typed('zset'); if (!e) return { arr: [] }; if (e.err) return e;
        var ws = (a[3] || '').toUpperCase() === 'WITHSCORES', items = range(zsorted(e.v, c === 'ZREVRANGE'), a[1], a[2]), res = [];
        items.forEach(function (p) { res.push(p[0]); if (ws) res.push(fmtNum(p[1])); });
        return { arr: res };
      case 'ZRANK': case 'ZREVRANK':
        e = typed('zset'); if (!e) return null; if (e.err) return e; if (!e.v.has(a[1])) return null;
        return int(zsorted(e.v, c === 'ZREVRANK').map(function (p) { return p[0]; }).indexOf(a[1]));
      case 'HSET':
        if (a.length < 3 || a.length % 2 === 0) return err("ERR wrong number of arguments for 'hset' command");
        e = typed('hash', true); if (e.err) return e; n = 0; for (i = 1; i < a.length; i += 2) { if (!e.v.has(a[i])) n++; e.v.set(a[i], a[i + 1]); } return int(n);
      case 'HGET': e = typed('hash'); if (!e) return null; if (e.err) return e; return e.v.has(a[1]) ? e.v.get(a[1]) : null;
      case 'HGETALL': e = typed('hash'); if (!e) return { arr: [] }; if (e.err) return e; var hv = []; e.v.forEach(function (v2, f) { hv.push(f, v2); }); return { arr: hv };
      case 'HINCRBY':
        if ((bad = need(3))) return bad; e = typed('hash', true); if (e.err) return e;
        var hn = (+(e.v.get(a[1]) || 0)) + +a[2]; e.v.set(a[1], String(hn)); return int(hn);
      case 'HDEL': e = typed('hash'); if (!e) return int(0); if (e.err) return e; n = 0; a.slice(1).forEach(function (f) { if (e.v.delete(f)) n++; }); return int(n);
      case 'LPUSH': case 'RPUSH':
        if ((bad = need(2))) return bad; e = typed('list', true); if (e.err) return e;
        a.slice(1).forEach(function (x) { if (c === 'LPUSH') e.v.unshift(x); else e.v.push(x); }); return int(e.v.length);
      case 'LPOP': case 'RPOP': e = typed('list'); if (!e) return null; if (e.err) return e; var pv = c === 'LPOP' ? e.v.shift() : e.v.pop(); if (!e.v.length) db.m.delete(k); return pv === undefined ? null : pv;
      case 'LRANGE': if ((bad = need(3))) return bad; e = typed('list'); if (!e) return { arr: [] }; if (e.err) return e; return { arr: range(e.v, a[1], a[2]) };
      case 'LLEN': e = typed('list'); if (!e) return int(0); if (e.err) return e; return int(e.v.length);
      case 'LTRIM': if ((bad = need(3))) return bad; e = typed('list'); if (!e) return { st: 'OK' }; if (e.err) return e; e.v = range(e.v, a[1], a[2]); return { st: 'OK' };
      case 'MEMORY':
        if ((a[0] || '').toUpperCase() !== 'USAGE') return err('ERR only MEMORY USAGE is simulated');
        k = a[1]; e = db.get(k); if (!e) return null;
        var b = 56 + k.length;
        if (e.t === 'string') b += e.v.length;
        else if (e.t === 'zset') b += 96 * e.v.size;
        else if (e.t === 'hash') e.v.forEach(function (v2, f) { b += 24 + f.length + v2.length; });
        else if (e.t === 'list') e.v.forEach(function (x) { b += 12 + x.length; });
        return { int: b, note: 'An estimate. Sorted sets use the 96 bytes per member measured in Notebook 7; real Redis reports its own allocator\'s numbers.' };
      case 'HELP': case 'COMMAND':
        return { st: 'Simulated: SET GET DEL EXISTS TYPE INCR INCRBY DECR EXPIRE TTL PERSIST KEYS SCAN DBSIZE FLUSHALL ZADD ZINCRBY ZSCORE ZCARD ZRANGE ZREVRANGE ZRANK ZREVRANK HSET HGET HGETALL HINCRBY HDEL LPUSH RPUSH LPOP RPOP LRANGE LLEN LTRIM MEMORY USAGE PING' };
      default: return err("ERR unknown command '" + argv[0] + "' (this simulator knows the common ones; type HELP)");
    }
  }
  function parse(line) {
    var out = [], m, re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
    while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
    return out;
  }
  function render(r, ind) {
    ind = ind || '';
    if (r === null || r === undefined) return '(nil)';
    if (typeof r === 'string') return '"' + r + '"';
    if (r.err) return '(error) ' + r.err;
    if (r.st !== undefined) return r.st;
    if (r.int !== undefined) return '(integer) ' + r.int;
    if (r.arr) {
      if (!r.arr.length) return '(empty array)';
      return r.arr.map(function (x, i) { return (i ? ind : '') + (i + 1) + ') ' + render(x, ind + '   '); }).join('\n');
    }
    return String(r);
  }
  var EX = [
    ['A session that expires', ['SET session:42 "user=7" EX 30', 'TTL session:42', 'GET session:42']],
    ['A leaderboard', ['ZINCRBY board 120 ana', 'ZINCRBY board 95 ben', 'ZINCRBY board 140 chen', 'ZINCRBY board 30 ben', 'ZREVRANGE board 0 2 WITHSCORES', 'ZREVRANK board ben']],
    ['A rate limit: 5 a minute', ['INCR rl:ip:1.2.3.4', 'EXPIRE rl:ip:1.2.3.4 60', 'INCR rl:ip:1.2.3.4', 'TTL rl:ip:1.2.3.4']],
    ['A cart in a hash', ['HSET cart:42 sku:1 2 sku:9 1', 'HINCRBY cart:42 sku:1 1', 'HGETALL cart:42', 'MEMORY USAGE cart:42']],
    ['KEYS against SCAN', ['KEYS *', 'SCAN 0 MATCH session:* COUNT 100']]
  ];
  function mount(el) {
    var db = new Store(), hist = [], hi = 0;
    el.innerHTML = '<div class="rs-ex" role="group" aria-label="Examples"><span class="kicker">Try an example</span></div>' +
      '<div class="rs-term" role="log" aria-live="polite"><div class="rs-out"></div><form class="rs-line"><span class="rs-p">redis&gt;</span><input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Redis command" placeholder="type a command, or HELP"></form></div>' +
      '<p class="rs-note">A simulation in your browser, not a real Redis: replies are shaped like redis-cli\'s, data lives only in this tab, and nothing is saved.</p>';
    var out = el.querySelector('.rs-out'), inp = el.querySelector('input'), ex = el.querySelector('.rs-ex'), term = el.querySelector('.rs-term');
    function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
    function run(line) {
      line = line.trim(); if (!line) return;
      hist.push(line); hi = hist.length;
      var argv = parse(line), r = exec(db, argv), cls = r && r.err ? ' rs-err' : '';
      out.insertAdjacentHTML('beforeend', '<div class="rs-cmd">redis&gt; ' + esc(line) + '</div><div class="rs-r' + cls + '">' + esc(render(r)) + '</div>' + (r && r.note ? '<div class="rs-tip">' + esc(r.note) + '</div>' : ''));
      term.scrollTop = term.scrollHeight;
      goals(argv, r);
    }
    var G = window.HDW_GOALS, key = 'redis-console', st = { ttlKey: false, zinc: 0 };
    function goals(argv, r) {
      if (!G) return; var c = (argv[0] || '').toUpperCase();
      if ((c === 'SET' && /\bEX\b/i.test(argv.join(' '))) || c === 'EXPIRE') st.ttlKey = true;
      if (c === 'TTL' && st.ttlKey && r && r.int > 0) G.done(key, 'ttl');
      if (c === 'ZINCRBY') st.zinc++;
      if (c === 'ZREVRANGE' && st.zinc >= 3 && r && r.arr && r.arr.length) G.done(key, 'board');
      if (c === 'INCR' && r && r.int !== undefined && r.int > 1) { var e = db.get(argv[1]); if (e && e.exp) G.done(key, 'rate'); }
      if (c === 'SCAN') G.done(key, 'scan');
    }
    EX.forEach(function (x) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = x[0];
      b.addEventListener('click', function () { x[1].forEach(run); inp.focus({ preventScroll: true }); });
      ex.appendChild(b);
    });
    el.querySelector('form').addEventListener('submit', function (ev) { ev.preventDefault(); run(inp.value); inp.value = ''; });
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowUp' && hi > 0) { inp.value = hist[--hi]; ev.preventDefault(); }
      else if (ev.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); inp.value = hist[hi] || ''; ev.preventDefault(); }
    });
    out.innerHTML = '<div class="rs-tip">Type a command and press Enter, or pick an example above. Up and down arrows recall earlier commands.</div>';
    if (G) G.attach(el, key, [['ttl', 'Set a key that expires, and watch TTL count down'], ['board', 'Add three scores with ZINCRBY, then read the top with ZREVRANGE'], ['rate', 'Build a rate limit: INCR a key that has an expiry'], ['scan', 'List keys with SCAN instead of KEYS']]);
  }
  window.HDW_REDIS = { exec: exec, Store: Store, parse: parse, render: render };
  document.querySelectorAll('.redissim').forEach(mount);
})();
