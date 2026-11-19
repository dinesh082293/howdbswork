/* Query coach: reads a SQL query, optional table definitions and an optional
   EXPLAIN plan, and lists what to look at, with the reason, the fix and the
   lesson. Pattern checks and a light parser, not an optimizer. Runs in the
   browser (and in the MCP server); nothing is sent anywhere. */
(function (root) {
  var L = {
    colorder: ['../queries/index.html#column-order', 'Why is my query slow when the index exists?'],
    covering: ['../queries/index.html#covering', 'Can a query skip the table entirely?'],
    paging: ['../queries/index.html#paging', 'Why does page 25,000 take a hundred times longer than page 1?'],
    nb5: ['../notebooks/index.html#queries', 'Notebook 5: five query shapes on a million orders'],
    nb3: ['../notebooks/index.html#scan-vs-index', 'Notebook 3: one lookup without and with an index'],
    nb2: ['../notebooks/index.html#commit-cost', 'Notebook 2: what waiting for the log costs per commit'],
    lost: ['../isolation/index.html#lost-update', 'Lost updates'],
    fixes: ['../isolation/index.html#fixes', 'How to fix lost updates and write skew'],
    anti: ['../designs/anti-patterns/index.html', 'Anti-patterns'],
    explain: ['../reference/index.html#evidence', 'Explain output, annotated line by line'],
    migr: ['../designs/migrations/index.html', 'Migration playbooks'],
    pg: ['../postgresql/index.html', 'PostgreSQL internals'],
    my: ['../mysql/index.html', 'MySQL internals']
  };
  var SEV = { risk: 0, slow: 1, tip: 2 };
  var KW = 'select from where and or not on join left right inner outer full cross natural using group order by having limit offset fetch for update share set values into as in is null like ilike between exists union all distinct returning with case when then else end asc desc nulls first last lateral window over partition'.split(' ');
  var KWS = {}; KW.forEach(function (k) { KWS[k] = 1; });
  var AGG = /\b(count|sum|avg|min|max|string_agg|group_concat|array_agg|json_agg|jsonb_agg|bool_and|bool_or|every|stddev|variance)\s*\(/;
  var FN = 'lower|upper|date|year|month|day|hour|trim|ltrim|rtrim|coalesce|ifnull|nvl|substr|substring|left|right|to_char|date_format|cast|convert|abs|round|floor|ceil|unix_timestamp|md5|length|char_length|concat';

  // ---------- lexing ----------
  function clean(sql, eng) {
    var strs = [], out = '', i = 0, n = sql.length;
    while (i < n) {
      var c = sql[i], d = sql[i + 1];
      if (c === '-' && d === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
      if (c === '#' && eng === 'my') { while (i < n && sql[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { var e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
      if (c === "'") {
        var j = i + 1, v = '';
        while (j < n) {
          if (sql[j] === "'") { if (sql[j + 1] === "'") { v += "'"; j += 2; continue; } break; }
          if (sql[j] === '\\' && eng === 'my') { v += sql[j + 1] || ''; j += 2; continue; }
          v += sql[j]; j++;
        }
        strs.push(v); out += ' §' + (strs.length - 1) + '§ '; i = j + 1; continue;
      }
      if (c === '$') {
        var m = /^\$([a-zA-Z_]\w*)?\$/.exec(sql.slice(i, i + 40));
        if (m) { var tag = m[0], e2 = sql.indexOf(tag, i + tag.length); if (e2 < 0) e2 = n; strs.push(sql.slice(i + tag.length, e2)); out += ' §' + (strs.length - 1) + '§ '; i = e2 + tag.length; continue; }
      }
      if (c === '"' || c === '`') { var e3 = sql.indexOf(c, i + 1); if (e3 < 0) e3 = n; out += sql.slice(i + 1, e3).toLowerCase().replace(/\s+/g, '_'); i = e3 + 1; continue; }
      out += c; i++;
    }
    out = out.toLowerCase().replace(/\s+/g, ' ');
    return { stmts: out.split(';').map(function (s) { return s.trim(); }).filter(Boolean), strs: strs };
  }
  function mask(s) {
    var d = 0, o = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(') { d++; o += d === 1 ? '(' : '_'; continue; }
      if (c === ')') { o += d === 1 ? ')' : (d > 1 ? '_' : ')'); d = Math.max(0, d - 1); continue; }
      o += d > 0 ? '_' : c;
    }
    return o;
  }
  function find(m, re, from) { re.lastIndex = from || 0; var r = re.exec(m); return r ? r.index : -1; }
  function clause(s, m, kw, enders) {
    var i = find(m, new RegExp('\\b' + kw + '\\b', 'g'));
    if (i < 0) return null;
    var start = i + kw.length, end = s.length;
    enders.forEach(function (e) { var k = find(m, new RegExp('\\b' + e + '\\b', 'g'), start); if (k >= 0 && k < end) end = k; });
    return s.slice(start, end).trim();
  }
  var W_END = ['group by', 'having', 'order by', 'limit', 'offset', 'fetch', 'for update', 'for share', 'for no key update', 'union', 'returning', 'window', 'except', 'intersect'];
  function splitTop(s, sepRe) {
    var m = mask(s), parts = [], last = 0, r; sepRe.lastIndex = 0;
    while ((r = sepRe.exec(m))) { parts.push(s.slice(last, r.index)); last = r.index + r[0].length; }
    parts.push(s.slice(last)); return parts.map(function (p) { return p.trim(); }).filter(Boolean);
  }
  function stmtType(s) {
    var first = (s.match(/^\(?\s*([a-z]+)/) || [])[1] || '';
    if (first === 'with') { var m = mask(s), k = find(m, /\b(select|insert|update|delete)\b/g, 4); return k >= 0 ? s.slice(k).match(/^[a-z]+/)[0] : 'select'; }
    if (first === 'explain') return 'explain';
    return first;
  }
  function bareName(t) { t = t.replace(/^only\s+/, ''); var p = t.split('.'); return p[p.length - 1]; }

  // ---------- schema ----------
  function parseSchema(stmts, strs) {
    var T = {};
    function tbl(n) { n = bareName(n); return T[n] || (T[n] = { name: n, cols: {}, order: [], pk: null, idx: [], fks: [] }); }
    function cols(list) {
      return splitTop(list, /,/g).map(function (c) {
        c = c.trim();
        var m = c.match(/^([a-z_][\w$]*)(\s|$)/);
        if (m && !/^\w+\s*\(/.test(c)) return m[1];
        return c.replace(/\s+(asc|desc).*$/, '').replace(/\s+/g, '');
      });
    }
    stmts.forEach(function (s) {
      var m;
      if ((m = s.match(/^create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w.$]+)\s*\(/))) {
        var t = tbl(m[1]), open = s.indexOf('(', m[0].length - 1), d = 0, end = open;
        for (var i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) { end = i; break; } } }
        var body = s.slice(open + 1, end), after = s.slice(end + 1);
        t.partitioned = /partition\s+by/.test(after);
        splitTop(body, /,/g).forEach(function (part) {
          var p = part.trim(), mm;
          if ((mm = p.match(/^(?:constraint\s+\w+\s+)?primary\s+key\s*\(([^)]*)\)/))) { t.pk = cols(mm[1]); t.idx.push({ cols: t.pk, unique: true, name: 'primary key' }); return; }
          if ((mm = p.match(/^(?:constraint\s+\w+\s+)?unique(?:\s+(?:key|index))?(?:\s+\w+)?\s*\(([^)]*)\)/))) { t.idx.push({ cols: cols(mm[1]), unique: true, name: 'unique' }); return; }
          if ((mm = p.match(/^(?:fulltext\s+|spatial\s+)?(?:key|index)\s*(\w+)?\s*\(([^)]*)\)/))) { t.idx.push({ cols: cols(mm[2]), name: mm[1] || 'index', fulltext: /^fulltext/.test(p) }); return; }
          if ((mm = p.match(/^(?:constraint\s+\w+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([\w.]+)/))) { t.fks.push({ cols: cols(mm[1]), ref: bareName(mm[2]) }); return; }
          if (/^(constraint|check|exclude|period)\b/.test(p)) return;
          if ((mm = p.match(/^([a-z_][\w$]*)\s+([a-z][\w ]*?(?:\([^)]*\))?(?:\s*\[\])?)(?=\s|$)/))) {
            var name = mm[1], rest = p.slice(mm[1].length).trim();
            var type = (rest.match(/^(timestamp\s+(?:with|without)\s+time\s+zone|time\s+(?:with|without)\s+time\s+zone|double\s+precision|character\s+varying(?:\s*\([^)]*\))?|[a-z_][\w]*(?:\s*\([^)]*\))?)/) || [''])[0];
            t.cols[name] = { type: type, notnull: /not\s+null|primary\s+key/.test(rest) };
            t.order.push(name);
            if (/primary\s+key/.test(rest)) { t.pk = [name]; t.idx.push({ cols: [name], unique: true, name: 'primary key' }); }
            else if (/\bunique\b/.test(rest)) t.idx.push({ cols: [name], unique: true, name: 'unique' });
            var rf = rest.match(/references\s+([\w.]+)/); if (rf) t.fks.push({ cols: [name], ref: bareName(rf[1]) });
          }
        });
      } else if ((m = s.match(/^create\s+(unique\s+)?index\s+(concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:([\w$]+)\s+)?on\s+(?:only\s+)?([\w.$]+)\s*(?:using\s+(\w+)\s*)?\((.*)\)/))) {
        tbl(m[4]).idx.push({ cols: cols(m[6].replace(/\)\s*(include|where|with)\b.*$/, '')), unique: !!m[1], name: m[3] || 'index', method: m[5] || '' });
      } else if ((m = s.match(/^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w.$]+)\s+add\s+(?:constraint\s+\w+\s+)?(primary\s+key|unique|index|key)\s*(?:\w+\s*)?\(([^)]*)\)/))) {
        var t2 = tbl(m[1]), cs = cols(m[3]); t2.idx.push({ cols: cs, unique: m[2] !== 'index' && m[2] !== 'key', name: m[2] }); if (/primary/.test(m[2])) t2.pk = cs;
      }
    });
    return T;
  }

  // ---------- query pieces ----------
  function tablesOf(s) {
    var out = [], re = /\b(from|join|update|into)\s+(?:only\s+)?([a-z_][\w.$]*)(?:\s+(?:as\s+)?([a-z_]\w*))?/g, r;
    while ((r = re.exec(s))) {
      if (r[2] === 'select' || r[2] === 'lateral' || /^§/.test(r[2])) continue;
      var a = r[3] && !KWS[r[3]] ? r[3] : null;
      out.push({ table: bareName(r[2]), alias: a, kind: r[1] });
    }
    var from = clause(s, mask(s), 'from', ['where', 'group by', 'having', 'order by', 'limit', 'offset', 'for update', 'union', 'window', 'join', 'left', 'right', 'inner', 'cross', 'full']);
    if (from && from.indexOf(',') >= 0) {
      splitTop(from, /,/g).slice(1).forEach(function (p) { var mm = p.match(/^([a-z_][\w.$]*)(?:\s+(?:as\s+)?([a-z_]\w*))?/); if (mm && mm[1] !== 'lateral') out.push({ table: bareName(mm[1]), alias: mm[2] && !KWS[mm[2]] ? mm[2] : null, kind: 'from' }); });
    }
    return out;
  }
  function resolve(ref, tabs, schema) {
    var p = ref.split('.');
    if (p.length >= 2) {
      var q = p[p.length - 2], col = p[p.length - 1];
      for (var i = 0; i < tabs.length; i++) if (tabs[i].alias === q || tabs[i].table === q) return { table: tabs[i].table, col: col };
      return { table: q, col: col };
    }
    var uniq = {}; tabs.forEach(function (t) { uniq[t.table] = 1; }); var names = Object.keys(uniq);
    if (names.length === 1) return { table: names[0], col: ref };
    for (var k = 0; k < names.length; k++) if (schema[names[k]] && schema[names[k]].cols[ref]) return { table: names[k], col: ref };
    return { table: null, col: ref };
  }
  function predicates(where) {
    var out = [], hasOr = false;
    splitTop(where, /\band\b/g).forEach(function (p) {
      var raw = p.replace(/^\(\s*/, '').replace(/\s*\)$/, '');
      if (/\bor\b/.test(mask(raw))) { hasOr = true; return; }
      var m = raw.match(/^([a-z_][\w.$]*)\s*(=|<=>|<=|>=|<>|!=|<|>|\bnot\s+in\b|\bin\b|\bbetween\b|\bnot\s+like\b|\blike\b|\bilike\b|\bis\b|@@|@>|<@|&&)\s*(.*)$/);
      if (!m) { var m2 = raw.match(/^(.*?)\s*(=|<=|>=|<|>)\s*([a-z_][\w.$]*)$/); if (m2 && !/[()]/.test(m2[3]) && !KWS[m2[3]] && /^(§\d+§|\$\d+|\?|:\w+|[\d.]+|now\(\)|current_\w+)$/.test(m2[1].trim())) m = [raw, m2[3], m2[2] === '=' ? '=' : '<', m2[1]]; }
      if (!m || KWS[m[1]]) return;
      var op = m[2], kind = (op === '=' || op === '<=>' || op === 'in' || op === 'is') ? 'eq' : (/like/.test(op) ? 'like' : (/^(<=|>=|<|>|between)$/.test(op) ? 'range' : 'other'));
      out.push({ col: m[1], op: op, rhs: (m[3] || '').trim(), kind: kind, text: raw });
    });
    return { preds: out, hasOr: hasOr };
  }

  // ---------- review ----------
  function review(input) {
    var eng = input.engine === 'my' || input.engine === 'mysql' ? 'my' : 'pg';
    var EN = eng === 'my' ? 'MySQL' : 'PostgreSQL';
    var F = [], seen = {};
    function add(id, sev, title, why, fix, link, key) {
      var k = id + '|' + (key || ''); if (seen[k]) return; seen[k] = 1;
      F.push({ id: id, sev: sev, title: title, why: why, fix: fix || '', link: link ? L[link] : null });
    }
    var Q = clean(input.sql || '', eng), SC = clean(input.schema || '', eng);
    var strs = Q.strs;
    function lit(s) { return s.replace(/§(\d+)§/g, function (_, n) { return "'" + (strs[+n] || '') + "'"; }); }
    var schema = parseSchema(SC.stmts.concat(Q.stmts.filter(function (s) { return /^(create|alter)\b/.test(s); })), SC.strs);
    var hasSchema = Object.keys(schema).length > 0;
    var stmts = Q.stmts;

    stmts.forEach(function (s, si) {
      var m = mask(s), type = stmtType(s);
      var where = clause(s, m, 'where', W_END);
      var tabs = tablesOf(s);
      var whole = s;

      // --- writes that touch everything
      if ((type === 'update' || type === 'delete') && !/\bwhere\b/.test(m) && !/\bwhere\b/.test(s.slice(s.search(/\b(update|delete)\b/)))) {
        add('no-where', 'risk', (type === 'update' ? 'UPDATE' : 'DELETE') + ' with no WHERE changes every row',
          'Without a WHERE clause this ' + type + 's every row of ' + (tabs[0] ? tabs[0].table : 'the table') + ', in one transaction that holds a lock on each row until it commits, and writes every change to the log.',
          'Add the WHERE you meant. If you really mean every row, do it in batches of a few thousand rows' + (type === 'delete' ? (eng === 'pg' ? ', or use TRUNCATE if nothing else must see the old rows.' : ', or TRUNCATE if nothing else must see the old rows.') : '.'), null, si);
      }
      if (where && /^(1\s*=\s*1|true)\s*$/.test(where) && (type === 'update' || type === 'delete')) add('no-where', 'risk', 'WHERE 1=1 on an ' + type.toUpperCase() + ' changes every row', 'The condition is always true, so this is the same as no WHERE at all.', 'Put the real condition in, or remove the statement.', null, si);
      if (type === 'truncate') add('truncate', 'risk', 'TRUNCATE removes every row and cannot be filtered', eng === 'pg' ? 'In PostgreSQL TRUNCATE takes an ACCESS EXCLUSIVE lock and empties the table at once. It can be rolled back inside a transaction, but once committed only a backup brings the rows back.' : 'In MySQL TRUNCATE is DDL: it commits implicitly and cannot be rolled back.', 'Check you are connected to the right database and that a recent backup exists.', null, si);

      // --- SELECT shapes
      if (/\bselect\s+(distinct\s+)?\*/.test(s) || /\bselect\s+(?:[^§]*?,\s*)?[a-z_]\w*\.\*/.test(s)) {
        var onlyExists = s.replace(/exists\s*\(\s*select\s+\*/g, '').search(/\bselect\s+(distinct\s+)?\*|\bselect\s+(?:[^§]*?,\s*)?[a-z_]\w*\.\*/) < 0;
        if (!onlyExists) add('select-star', 'tip', 'SELECT * returns every column', 'Every column is read and sent, including large ones, and no index can cover the query, so the engine has to visit the table for every row. Code that reads columns by position also breaks when someone adds one.', 'Name the columns you use. If they all fit in one index, the engine can answer from the index alone.', 'covering');
      }
      if (type === 'select') {
        var limitC = clause(s, m, 'limit', ['offset', 'for update', 'for share', 'union']);
        var hasLimit = !!limitC || /\bfetch\s+(first|next)\b/.test(m) || /\btop\s*\(?\d/.test(m);
        var selList = clause(s, m, 'select', ['from']) || '';
        var groupBy = clause(s, m, 'group by', ['having', 'order by', 'limit', 'offset', 'union', 'window']);
        var hasFrom = /\bfrom\b/.test(m);
        var aggOnly = AGG.test(selList) && !groupBy;
        if (hasFrom && !where && !hasLimit && !aggOnly && !groupBy && !/\bjoin\b/.test(m) && si === 0) {
          add('no-where-select', 'slow', 'No WHERE and no LIMIT: this reads the whole table', 'Fine for a small lookup table. On a table that grows, this query gets slower every day and returns more rows to the application every day.', 'Add the filter the screen actually needs, and a LIMIT. For exports, page through with keyset pagination.', 'paging');
        }
        if (aggOnly && /\bcount\s*\(\s*(\*|1)\s*\)/.test(selList) && !where) {
          add('count-all', 'tip', 'COUNT(*) on the whole table reads every row', eng === 'pg' ? 'PostgreSQL keeps no row count: MVCC means each transaction may see a different number, so it counts row by row (using an index-only scan if the visibility map allows).' : 'InnoDB keeps no exact row count: each transaction may see a different number, so it counts by scanning the smallest index.',
            eng === 'pg' ? "If an estimate is enough, read SELECT reltuples FROM pg_class WHERE relname = '" + (tabs[0] ? tabs[0].table : 't') + "'. Otherwise cache the count, or keep it in a counter table." : "If an estimate is enough, read TABLE_ROWS from information_schema.TABLES. Otherwise cache the count, or keep it in a counter table.", 'pg');
        }
        var off = null, mo;
        if ((mo = s.match(/\boffset\s+(\d+)/))) off = +mo[1];
        else if ((mo = s.match(/\blimit\s+(\d+)\s*,\s*\d+/))) off = +mo[1];
        if (off !== null && off >= 1000) add('offset', 'slow', 'OFFSET ' + off.toLocaleString('en-US') + ' reads and throws away ' + off.toLocaleString('en-US') + ' rows', 'The engine has to produce every skipped row before it can return the page you asked for, so deep pages get slower in a straight line. In Notebook 5, OFFSET 500,000 on a million orders took 64 ms in PostgreSQL, 99 ms in MySQL and 231 ms in MongoDB; the same page fetched by key took under a millisecond in all three.', keyset(s, m), 'paging');
        else if (/\boffset\s+(\$\d+|\?|:\w+)/.test(s) || /\blimit\s+(\$\d+|\?|:\w+)\s*,/.test(s)) add('offset', 'tip', 'OFFSET paging slows down as people page deeper', 'Each page reads all the rows before it. It is fine for the first few pages and slow for deep ones, which crawlers and exports reach.', 'Use keyset pagination: WHERE sort_key < last_seen ORDER BY sort_key DESC LIMIT n.', 'paging');
        if (/\border\s+by\s+(rand|random)\s*\(\s*\)/.test(s)) add('order-random', 'slow', 'ORDER BY ' + (eng === 'my' ? 'RAND()' : 'random()') + ' sorts the whole table to pick a few rows', 'Every row gets a random number and the full result is sorted, so the cost grows with the table, not with the rows you return.', eng === 'pg' ? 'Use TABLESAMPLE SYSTEM (1) for a rough sample, or pick random ids in the application and fetch them by primary key.' : 'Pick random ids in the application and fetch them by primary key, or keep a shuffled sample table.', null);
        var having = clause(s, m, 'having', ['order by', 'limit', 'offset', 'union', 'window']);
        if (having && !AGG.test(having)) add('having', 'tip', 'HAVING without an aggregate filters too late', 'This condition does not use an aggregate, so it filters rows after grouping when it could have removed them before.', 'Move it into WHERE, so fewer rows are grouped and an index can help.', null);
        if (/\bfor\s+update\b/.test(s) && hasLimit && /\border\s+by\b/.test(m) && !/skip\s+locked|nowait/.test(s)) add('skip-locked', 'tip', 'A queue read with FOR UPDATE makes workers wait for each other', 'Every worker locks the same first row, so they queue behind one another instead of taking different jobs.', 'Add SKIP LOCKED, so each worker takes the next row nobody holds. ' + (eng === 'my' ? 'MySQL supports it since 8.0.' : ''), 'anti');
        var fromC = clause(s, m, 'from', ['where', 'group by', 'having', 'order by', 'limit', 'offset', 'for update', 'union', 'window']);
        if (fromC && /,/.test(mask(fromC)) && !/\bjoin\b/.test(mask(fromC)) && !where && !/\blateral\b/.test(fromC) && !/unnest|generate_series|json_table/.test(fromC)) add('cartesian', 'risk', 'Tables listed with commas and no WHERE: every row is joined to every row', 'FROM a, b without a join condition is a cross join. Two tables of 10,000 rows give 100,000,000 result rows.', 'Write explicit JOIN ... ON with the join columns.', null);
      }
      if (/\bunion\b(?!\s+all)/.test(m)) add('union', 'tip', 'UNION removes duplicates, which costs a sort or a hash', 'UNION without ALL compares every row of the combined result to drop duplicates.', 'If the parts cannot overlap, or duplicates are fine, use UNION ALL.', null);

      // --- predicates that stop an index
      var fnRe = new RegExp('\\b(' + FN + ')\\s*\\(\\s*([a-z_][\\w.$]*)\\s*(?:,[^()]*?)?\\)\\s*(=|<=|>=|<>|!=|<|>|\\bin\\b|\\blike\\b|\\bilike\\b|\\bbetween\\b|\\bis\\b)', 'g'), r;
      while ((r = fnRe.exec(whole))) {
        var before = whole.slice(0, r.index), lastKw = (before.match(/\b(select|where|on|and|or|having|join|from|set|not|when)\b(?![\s\S]*\b(select|where|on|and|or|having|join|from|set|not|when)\b)/) || [])[1];
        if (['where', 'on', 'and', 'or', 'having', 'not'].indexOf(lastKw) < 0) continue;
        if (KWS[r[2]] || /^\d/.test(r[2])) continue;
        var fn = r[1], col = r[2], isDate = /^(date|year|month|day|hour|date_format|to_char|unix_timestamp)$/.test(fn);
        add('fn-col', 'slow', fn + '(' + col + ') in a filter stops a plain index on ' + col + ' from being used',
          'An index on ' + col + ' is sorted by the column\'s value, not by ' + fn + '() of it, so the engine has to compute ' + fn + '() for every row and compare.',
          isDate ? 'Compare the raw column with a range instead: ' + col + " >= '2026-11-01' AND " + col + " < '2026-11-02'." :
            (eng === 'pg' ? 'Either compare the raw column, or index the expression: CREATE INDEX ON table (' + fn + '(' + col + '));' + (fn === 'lower' ? ' For case-insensitive text, the citext type is another option.' : '') : 'Either compare the raw column, or index the expression (MySQL 8.0.13 and later): CREATE INDEX idx ON table ((' + fn + '(' + col + ')));' + (fn === 'lower' ? ' With a case-insensitive collation, which is the default, lower() is usually not needed at all.' : '')),
          'colorder', fn + col);
      }
      var castRe = /\b([a-z_][\w.$]*)\s*::\s*(date|text|varchar|int\w*|numeric|bigint|timestamp\w*)\s*(=|<=|>=|<|>|\bin\b|\bbetween\b)/g;
      while ((r = castRe.exec(whole))) {
        if (KWS[r[1]]) continue;
        add('fn-col', 'slow', r[1] + '::' + r[2] + ' in a filter stops a plain index on ' + r[1] + ' from being used', 'The cast is applied to every row before the comparison, so an index on the raw column does not match.', r[2] === 'date' ? 'Compare with a range on the raw column: ' + r[1] + " >= '2026-11-01' AND " + r[1] + " < '2026-11-02'." : 'Cast the value you compare with, not the column, or index the expression.', 'colorder', 'cast' + r[1]);
      }
      var arRe = /\b(where|and|on)\s+([a-z_][\w.$]*)\s*[+\-*/]\s*[\d.]+\s*(=|<=|>=|<|>)/g;
      while ((r = arRe.exec(whole))) add('fn-col', 'slow', 'Arithmetic on ' + r[2] + ' in a filter stops its index from being used', 'The engine computes the expression for every row before comparing.', 'Move the arithmetic to the other side: ' + r[2] + ' > 100 / 2 rather than ' + r[2] + ' * 2 > 100.', 'colorder', 'ar' + r[2]);
      var likeRe = /\b(not\s+)?(i?like)\s+(?:§(\d+)§|concat\s*\(\s*§(\d+)§|§(\d+)§\s*\|\|)/g;
      while ((r = likeRe.exec(whole))) {
        var v = strs[+(r[3] || r[4] || r[5])] || '';
        if (r[3] && v.charAt(0) !== '%') continue;
        if (!r[3] && v !== '%') continue;
        add('like-leading', 'slow', 'A pattern that starts with % cannot use a normal index', 'A B-tree index is sorted from the first character. With a wildcard first, the engine has to check every row.',
          eng === 'pg' ? 'For "contains" searches, use a trigram index: CREATE EXTENSION pg_trgm; CREATE INDEX ON table USING gin (col gin_trgm_ops);. For words, full-text search.' : 'For word searches, a FULLTEXT index with MATCH ... AGAINST. For true substring search on a large table, a search engine.', null);
      }
      if (/\bnot\s+in\s*\(\s*select\b/.test(whole)) add('not-in-null', 'risk', 'NOT IN (SELECT ...) returns nothing if the subquery returns a NULL', 'x NOT IN (1, 2, NULL) is never true, because comparing with NULL is unknown. One NULL in the subquery and the whole query silently returns zero rows.', 'Use NOT EXISTS (SELECT 1 FROM ... WHERE ... = outer.col), which handles NULLs the way people expect and usually plans better.', null);
      var inRe = /\bin\s*\(([^()]*)\)/g;
      while ((r = inRe.exec(whole))) { var cnt = r[1].split(',').length; if (cnt > 500) add('in-list', 'tip', 'An IN list of ' + cnt.toLocaleString('en-US') + ' values', 'Very long lists are slow to parse and plan, and every distinct length is a new statement for the plan cache and for monitoring.', eng === 'pg' ? 'Pass an array instead: WHERE id = ANY($1), or join to a temporary table.' : 'Load the values into a temporary table and join to it, or split into batches.', null); }

      // --- writes
      if ((type === 'update' || type === 'delete') && eng === 'my' && /\blimit\b/.test(m) && !/\border\s+by\b/.test(m)) add('limit-no-order', 'tip', type.toUpperCase() + ' ... LIMIT without ORDER BY picks rows in no fixed order', 'Which rows are changed is up to the engine, and with statement-based replication the replica may change different rows.', 'Add ORDER BY on the primary key.', null);
      if (type === 'delete' && where && /(<|<=|\binterval\b|now\(\)|current_date)/.test(where) && !/\blimit\b/.test(m)) add('retention-delete', 'tip', 'A retention DELETE should run in batches, or be a partition drop', 'One DELETE of millions of old rows is one long transaction: it holds locks, bloats the table (PostgreSQL) or the undo log (InnoDB), and makes replicas fall behind.',
        eng === 'pg' ? 'Delete in batches: DELETE FROM t WHERE id IN (SELECT id FROM t WHERE ... LIMIT 5000), in a loop. Better: partition by time and drop old partitions.' : 'Delete in batches with LIMIT 5000 in a loop, ordered by primary key. Better: partition by time and drop old partitions.', 'anti');

      // --- DDL
      if (/^create\s+(unique\s+)?index\b/.test(s)) {
        var tblName = (s.match(/\bon\s+(?:only\s+)?([\w.$]+)/) || [])[1];
        var newTable = Q.stmts.some(function (o) { return /^create\s+table/.test(o) && tblName && new RegExp('table\\s+(if\\s+not\\s+exists\\s+)?' + tblName.replace(/[.$]/g, '\\$&') + '\\b').test(o); });
        if (eng === 'pg' && !/\bconcurrently\b/.test(s) && !newTable) add('index-lock', 'risk', 'CREATE INDEX without CONCURRENTLY blocks writes to ' + (tblName || 'the table') + ' until it finishes', 'A plain CREATE INDEX takes a lock that lets reads continue but blocks every INSERT, UPDATE and DELETE on the table for as long as the build takes, which is minutes on a large table.', 'Use CREATE INDEX CONCURRENTLY. It takes longer, cannot run inside a transaction block, and if it fails it leaves an INVALID index to drop and retry.', 'migr');
        if (eng === 'my' && !newTable) add('mdl', 'tip', 'Index builds in MySQL are online, but wait for a metadata lock', 'InnoDB builds the index without blocking writes, but it needs a brief metadata lock at the start and the end. A long transaction on the table makes it wait, and every query behind it waits too.', 'Check for long transactions in information_schema.innodb_trx first, and set lock_wait_timeout low (for example 5 seconds) for the session.', 'migr');
      }
      if (/^alter\s+table\b/.test(s)) {
        var at = (s.match(/^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w.$]+)/) || [])[1] || 'the table';
        if (eng === 'pg') {
          if (/\balter\s+(column\s+)?[\w$]+\s+(set\s+data\s+)?type\b/.test(s)) add('alter-type', 'risk', 'Changing a column type rewrites ' + at + ' under an exclusive lock', 'Most type changes rewrite the whole table and its indexes while holding an ACCESS EXCLUSIVE lock, which blocks reads and writes. Some, such as making a varchar longer, do not.', 'For a large table: add a new column, backfill it in batches, switch the application, then drop the old column.', 'migr', at);
          if (/\badd\s+(column\s+)?[\w$]+\s+[^,]*\bdefault\s+(random|gen_random_uuid|uuid_generate_v4|clock_timestamp|timeofday)\s*\(/.test(s)) add('add-volatile-default', 'risk', 'A column with a volatile default rewrites ' + at, 'Since PostgreSQL 11 a constant default is instant, but a volatile one such as random() or gen_random_uuid() has to be computed for every existing row, so the table is rewritten under an exclusive lock.', 'Add the column with no default, set the default for new rows, and backfill existing rows in batches.', 'migr', at);
          if (/\badd\s+(constraint\s+\w+\s+)?(foreign\s+key|check)\b/.test(s) && !/\bnot\s+valid\b/.test(s)) add('constraint-valid', 'slow', 'Adding a constraint checks every existing row while holding a lock', 'A new FOREIGN KEY or CHECK constraint is validated against the whole table right away, and writes are blocked while that runs.', 'Add it with NOT VALID (instant, applies to new rows), then run ALTER TABLE ... VALIDATE CONSTRAINT, which checks old rows without blocking writes.', 'migr', at);
          if (/\bset\s+not\s+null\b/.test(s)) add('set-not-null', 'slow', 'SET NOT NULL scans ' + at + ' under an exclusive lock', 'PostgreSQL checks every row while holding an ACCESS EXCLUSIVE lock.', 'Since PostgreSQL 12: add CHECK (col IS NOT NULL) NOT VALID, VALIDATE it, then SET NOT NULL, which uses the valid check and skips the scan. Then drop the check.', 'migr', at);
          if (/\badd\s+(constraint\s+\w+\s+)?(unique|primary\s+key)\s*\(/.test(s)) add('add-unique', 'risk', 'Adding a UNIQUE or PRIMARY KEY constraint builds an index while blocking writes', 'The index is built under a lock that blocks writes, like CREATE INDEX without CONCURRENTLY.', 'Build it first with CREATE UNIQUE INDEX CONCURRENTLY, then ALTER TABLE ... ADD CONSTRAINT name UNIQUE USING INDEX idx_name.', 'migr', at);
          if (!/lock_timeout/.test(Q.stmts.join(' '))) add('lock-timeout', 'tip', 'Set lock_timeout before ALTER TABLE', 'Even an instant ALTER needs a brief exclusive lock. If a long transaction holds the table, the ALTER waits, and every query that arrives after it waits behind it. A one-second change becomes an outage.', "Run SET lock_timeout = '5s'; first, and retry if it times out.", 'migr');
        } else {
          if (/\b(modify|change)\s+(column\s+)?[\w$]+/.test(s)) add('alter-type', 'risk', 'MODIFY or CHANGE COLUMN usually copies ' + at, 'Changing a column\'s type rebuilds the table with ALGORITHM=COPY, which blocks writes for the whole copy. Some changes, such as extending a VARCHAR within the same length byte, are in place.', 'Add ALGORITHM=INPLACE, LOCK=NONE so the statement fails instead of quietly copying. For large tables use gh-ost or pt-online-schema-change.', 'migr', at);
          else if (!/\balgorithm\s*=/.test(s)) add('algorithm', 'tip', 'Say which ALTER algorithm you expect', 'Without ALGORITHM=..., MySQL picks one for you, and some changes silently fall back to copying the table while blocking writes.', 'Add ALGORITHM=INSTANT (or INPLACE), LOCK=NONE. If MySQL cannot do it that way, the statement errors instead of locking the table.', 'migr', at);
          add('mdl', 'tip', 'ALTER TABLE waits for a metadata lock', 'If any transaction has touched the table and not committed, the ALTER waits, and every new query on the table queues behind it.', 'Check information_schema.innodb_trx for long transactions, and SET lock_wait_timeout = 5 for the session.', 'migr');
        }
        if (/\bdrop\s+column\b/.test(s)) add('drop-column', 'risk', 'DROP COLUMN cannot be undone without a restore', 'Code that still reads the column fails as soon as it is gone.', 'Deploy code that no longer uses the column first, wait a release, then drop it.', 'migr', at);
      }
      if (/^drop\s+table\b/.test(s)) add('drop-table', 'risk', 'DROP TABLE cannot be undone without a restore', 'The table and its data are gone when this commits.', 'Rename it first and drop it a week later, once nothing has complained.', null);
    });

    // --- read, then write: lost updates
    stmts.forEach(function (s1, i) {
      if (stmtType(s1) !== 'select' || /\bfor\s+(update|share|no\s+key\s+update)\b/.test(s1)) return;
      var t1 = tablesOf(s1).map(function (t) { return t.table; }), sel = clause(s1, mask(s1), 'select', ['from']) || '';
      stmts.slice(i + 1).forEach(function (s2) {
        if (stmtType(s2) !== 'update') return;
        var t2 = (s2.match(/^update\s+(?:only\s+)?([\w.$]+)/) || [])[1]; if (!t2 || t1.indexOf(bareName(t2)) < 0) return;
        var set = clause(s2, mask(s2), 'set', ['where', 'from', 'returning', 'limit', 'order by']) || '';
        var w2 = clause(s2, mask(s2), 'where', W_END) || '';
        splitTop(set, /,/g).forEach(function (a) {
          var mm = a.match(/^([a-z_][\w.$]*)\s*=\s*(.*)$/); if (!mm) return;
          var col = bareName(mm[1]), expr = mm[2];
          if (new RegExp('\\b' + col + '\\b').test(expr)) return;
          if (!(sel.trim() === '*' || new RegExp('\\b' + col + '\\b').test(sel))) return;
          if (new RegExp('\\b' + col + '\\s*=').test(w2) || /\bversion\b/.test(w2)) return;
          add('lost-update', 'risk', 'Read ' + col + ', then write it back: two sessions can lose an update', 'Both sessions read the same value, both compute a new one, and the second write replaces the first. Neither PostgreSQL nor MySQL stops this at their default isolation level.',
            'Do it in one statement: UPDATE ' + bareName(t2) + ' SET ' + col + ' = ' + col + ' - 1 WHERE ... AND ' + col + ' >= 1. Or read with SELECT ... FOR UPDATE inside the same transaction, or add a version column and check it in the UPDATE.', 'lost', col);
        });
      });
    });
    var singles = stmts.filter(function (s) { return /^insert\b/.test(s) && /\bvalues\s*\(/.test(s) && !/\)\s*,\s*\(/.test(s); }).length;
    if (singles >= 3) add('batch-insert', 'tip', singles + ' single-row INSERTs: batch them', 'Each statement is a round trip, and outside a transaction each one waits for its own commit to reach the disk.', 'Send one INSERT with many rows: INSERT ... VALUES (...), (...), (...); or wrap the inserts in one transaction. ' + (eng === 'pg' ? 'For large loads, COPY.' : 'For large loads, LOAD DATA.'), 'nb2');

    // --- checks against the table definitions
    if (hasSchema) {
      Object.keys(schema).forEach(function (tn) {
        var t = schema[tn];
        if (!t.order.length) return;
        if (!t.pk && !t.partitioned) add('no-pk', 'risk', 'Table ' + tn + ' has no primary key', eng === 'my' ? 'InnoDB invents a hidden one you cannot use, row-based replication has to scan to find each changed row on the replica, and Group Replication refuses the table.' : 'Duplicate rows cannot be told apart, logical replication cannot send updates or deletes for it without a replica identity, and most tools assume one.', 'Add a primary key: an identity column if nothing else is unique.', null, tn);
        t.order.forEach(function (c) {
          var ty = t.cols[c].type;
          if (/^(float|double|real|double\s+precision)/.test(ty) && /(price|amount|total|balance|cost|fee|salary|money|tax)/.test(c)) add('money-float', 'risk', tn + '.' + c + ' stores money as ' + ty, 'Binary floating point cannot hold 0.10 exactly, so sums drift by fractions of a cent and comparisons fail.', 'Use NUMERIC(12,2) or DECIMAL, or store whole cents in a BIGINT.', 'anti', tn + c);
          if (eng === 'pg' && /^timestamp(\s+without\s+time\s+zone)?$/.test(ty)) add('tz', 'tip', tn + '.' + c + ' is a timestamp without time zone', 'It stores whatever local time the application sent, with no record of which zone that was. Servers in two zones, or a daylight saving change, and the data no longer lines up.', 'Use timestamptz. PostgreSQL stores it as UTC and converts on the way out.', 'anti', tn + c);
        });
        if (eng === 'my' && t.pk && t.pk.length === 1) { var pkt = (t.cols[t.pk[0]] || {}).type || ''; if (/^(char|varchar)\s*\(\s*36\s*\)/.test(pkt) || (/uuid/.test(t.pk[0]) && /^(char|varchar|binary)/.test(pkt))) add('uuid-pk', 'slow', tn + ' uses a UUID string as the InnoDB primary key', 'InnoDB stores the table in primary key order. Random UUIDs insert all over the index, and every secondary index stores the 36-character key again.', 'Use a BIGINT auto-increment key and keep the UUID as a unique column, or store it as BINARY(16) with UUID_TO_BIN(uuid, 1).', 'anti', tn); }
        if (eng === 'pg') t.fks.forEach(function (fk) { var ok = t.idx.some(function (ix) { return ix.cols[0] === fk.cols[0]; }); if (!ok) add('fk-index', 'tip', tn + '.' + fk.cols.join(', ') + ' references ' + fk.ref + ' but has no index', 'PostgreSQL does not index foreign key columns for you. Deleting or updating a row in ' + fk.ref + ' then scans ' + tn + ' to check for children, and joins on the column have no index.', 'CREATE INDEX CONCURRENTLY ON ' + tn + ' (' + fk.cols.join(', ') + ');', 'colorder', tn + fk.cols.join()); });
        t.idx.forEach(function (a, ai) { t.idx.forEach(function (b, bi) { if (ai === bi || a.unique || a.fulltext || b.fulltext || a.method || b.method) return; if (a.cols.length < b.cols.length && a.cols.every(function (c, k) { return b.cols[k] === c; })) add('redundant-index', 'tip', 'Index on ' + tn + ' (' + a.cols.join(', ') + ') is covered by (' + b.cols.join(', ') + ')', 'Any query that can use the shorter index can use the longer one, which starts with the same columns. The extra index costs space and slows every write.', 'Check it is unused (pg_stat_user_indexes or sys.schema_unused_indexes), then drop it.', 'colorder', tn + a.cols.join()); }); });
      });

      stmts.forEach(function (s) {
        var type = stmtType(s); if (['select', 'update', 'delete'].indexOf(type) < 0) return;
        var m = mask(s), tabs = tablesOf(s), where = clause(s, m, 'where', W_END);
        var per = {};
        function slot(tn) { return per[tn] || (per[tn] = { eq: [], range: [], order: [] }); }
        if (where) {
          var pp = predicates(where);
          pp.preds.forEach(function (p) {
            var rr = resolve(p.col, tabs, schema); if (!rr.table || !schema[rr.table]) return;
            var st = schema[rr.table];
            if (!st.cols[rr.col]) return;
            var ty = st.cols[rr.col].type;
            if (/^(char|varchar|text|character|nvarchar|tinytext|mediumtext|longtext)/.test(ty) && /^-?\d+(\.\d+)?$/.test(p.rhs)) add('type-mismatch', 'risk', rr.table + '.' + rr.col + ' is ' + ty + ' but is compared with the number ' + p.rhs,
              eng === 'my' ? 'MySQL converts the column to a number for every row, so the index on it is not used, and values like \'0012\' or \'12abc\' match 12.' : 'PostgreSQL refuses to compare text with an integer and the query fails with "operator does not exist".', "Quote the value: " + rr.col + " = '" + p.rhs + "'.", 'colorder', rr.table + rr.col);
            if (p.kind === 'eq') slot(rr.table).eq.push(rr.col);
            else if (p.kind === 'range' || (p.kind === 'like' && /^§\d+§$/.test(p.rhs) && (strs[+p.rhs.slice(1, -1)] || '').charAt(0) !== '%')) slot(rr.table).range.push(rr.col);
          });
        }
        var ord = clause(s, m, 'order by', ['limit', 'offset', 'fetch', 'for update', 'for share']);
        var lim = /\blimit\b|\bfetch\s+first\b/.test(m);
        if (ord) splitTop(ord, /,/g).forEach(function (o) { var mm = o.match(/^([a-z_][\w.$]*)/); if (!mm || /\(/.test(o)) return; var rr = resolve(mm[1], tabs, schema); if (rr.table && schema[rr.table]) slot(rr.table).order.push(rr.col); });
        Object.keys(per).forEach(function (tn) {
          var p = per[tn], st = schema[tn], eq = p.eq.filter(function (c, k) { return p.eq.indexOf(c) === k; }), rg = p.range[0];
          if (!eq.length && !rg) {
            if (lim && p.order.length && !st.idx.some(function (ix) { return ix.cols[0] === p.order[0]; })) add('order-index', 'slow', 'ORDER BY ' + p.order.join(', ') + ' with LIMIT, but no index starts with ' + p.order[0], 'To return the first rows the engine has to read and sort every row of ' + tn + ' first.', 'CREATE INDEX ON ' + tn + ' (' + p.order.join(', ') + '); lets it read the first rows in order and stop.', 'colorder', tn + 'ord');
            return;
          }
          var best = 0, bestIx = null;
          st.idx.forEach(function (ix) { var k = 0; while (k < ix.cols.length && eq.indexOf(ix.cols[k]) >= 0) k++; var sc = k + (rg && ix.cols[k] === rg ? 1 : 0); if (sc > best) { best = sc; bestIx = ix; } });
          var want = eq.concat(rg ? [rg] : []);
          if (!best) {
            var inside = st.idx.filter(function (ix) { return want.some(function (c) { return ix.cols.indexOf(c) > 0; }); })[0];
            var orderTail = (!rg && p.order.length && lim) ? p.order.filter(function (c) { return eq.indexOf(c) < 0; }) : [];
            add('missing-index', 'slow', 'No index on ' + tn + ' starts with ' + want.join(' or '), (inside ? 'There is an index on (' + inside.cols.join(', ') + '), but ' + want.filter(function (c) { return inside.cols.indexOf(c) > 0; })[0] + ' is not its first column, and an index is sorted by its first column first. In Notebook 5, that meant a full scan of a million rows in all three engines. So the engine' : 'So the engine') + ' reads every row of ' + tn + ' and checks the condition.',
              (eng === 'pg' ? 'CREATE INDEX CONCURRENTLY ON ' : 'CREATE INDEX idx_' + tn + '_' + want[0] + ' ON ') + tn + ' (' + want.concat(orderTail).join(', ') + ');' + (eq.length && rg ? ' Equality columns first, the range column last.' : ''), inside ? 'nb5' : 'colorder', tn + want.join());
          } else if (lim && p.order.length && !rg) {
            var k2 = 0; while (k2 < bestIx.cols.length && eq.indexOf(bestIx.cols[k2]) >= 0) k2++;
            var o0 = p.order.filter(function (c) { return eq.indexOf(c) < 0; });
            if (o0.length && bestIx.cols[k2] !== o0[0]) add('order-index', 'slow', 'The index finds the rows but not in ORDER BY order', 'The index on (' + bestIx.cols.join(', ') + ') narrows the rows, then every match is sorted before LIMIT can apply. For a customer with many orders, that is a sort of all of them to show 20.', 'An index on (' + eq.concat(o0).join(', ') + ') returns the rows already in order, so the engine stops after the LIMIT.', 'colorder', tn + 'ord2');
          }
        });
        // joins
        var onRe = /\bjoin\s+(?:only\s+)?([\w.$]+)(?:\s+(?:as\s+)?([a-z_]\w*))?\s+on\s+([a-z_][\w.$]*)\s*=\s*([a-z_][\w.$]*)/g, r;
        while ((r = onRe.exec(s))) {
          var jt = bareName(r[1]), ja = r[2] && !KWS[r[2]] ? r[2] : jt;
          [r[3], r[4]].forEach(function (ref) {
            var p = ref.split('.'); if (p.length < 2) return;
            if (p[0] !== ja && p[0] !== jt) return;
            var stj = schema[jt]; if (!stj || !stj.cols[p[1]]) return;
            if (!stj.idx.some(function (ix) { return ix.cols[0] === p[1]; })) add('join-index', 'slow', 'The join reaches ' + jt + ' through ' + p[1] + ', which has no index', 'For each row on the other side, the engine has to find matching rows in ' + jt + ' without an index: a hash of the whole table, or a scan per row.', (eng === 'pg' ? 'CREATE INDEX CONCURRENTLY ON ' : 'CREATE INDEX idx_' + jt + '_' + p[1] + ' ON ') + jt + ' (' + p[1] + ');', 'colorder', jt + p[1]);
          });
        }
      });
    }

    // --- the plan
    var plan = (input.plan || '').trim(), planKind = null;
    if (plan) {
      if (/\(cost=[\d.]+\.\.[\d.]+ rows=\d+ width=\d+\)/.test(plan)) { planKind = 'pg'; pgPlan(plan, add); }
      else if (/\|\s*select_type\s*\|/i.test(plan) || /^\s*id\s+select_type\s+table/im.test(plan)) { planKind = 'my-table'; myTable(plan, add); }
      else if (/->\s+[A-Z][\w ]+.*\(cost=|->\s+(Table scan|Index|Filter|Sort|Nested loop)/.test(plan)) { planKind = 'my-tree'; myTree(plan, add); }
      else add('plan-unknown', 'tip', 'I could not read the plan', 'Paste the text output of EXPLAIN ANALYZE (PostgreSQL), or EXPLAIN / EXPLAIN ANALYZE in table or tree format (MySQL).', '', 'explain');
    }

    F.sort(function (a, b) { return SEV[a.sev] - SEV[b.sev]; });
    return { findings: F, engine: eng, statements: stmts.length, tables: Object.keys(schema), planKind: planKind };
  }

  function keyset(s, m) {
    var ord = clause(s, m, 'order by', ['limit', 'offset', 'fetch', 'for update']) || '';
    var cols = splitTop(ord, /,/g).map(function (o) { var mm = o.match(/^([a-z_][\w.$]*)(?:\s+(asc|desc))?/); return mm ? { c: mm[1].split('.').pop(), d: mm[2] === 'desc' } : null; }).filter(Boolean);
    if (!cols.length) return 'Use keyset pagination: order by a unique key, remember the last value you showed, and ask for WHERE key > last_value ORDER BY key LIMIT 20.';
    var op = cols[0].d ? '<' : '>', dir = cols[0].d ? ' DESC' : '';
    if (cols.length === 1) return 'Use keyset pagination: remember the last ' + cols[0].c + ' on the page and ask for WHERE ' + cols[0].c + ' ' + op + ' :last_' + cols[0].c + ' ORDER BY ' + cols[0].c + dir + ' LIMIT 20. If ' + cols[0].c + ' is not unique, add the primary key as a tie-breaker.';
    var names = cols.map(function (c) { return c.c; });
    return 'Use keyset pagination: remember the last row\'s values and ask for WHERE (' + names.join(', ') + ') ' + op + ' (' + names.map(function (c) { return ':last_' + c; }).join(', ') + ') ORDER BY ' + names.map(function (c) { return c + dir; }).join(', ') + ' LIMIT 20, with an index on (' + names.join(', ') + ').';
  }
  function n(x) { return (+x).toLocaleString('en-US'); }
  function pgPlan(text, add) {
    var lines = text.split('\n'), nodes = [], cur = null;
    lines.forEach(function (ln) {
      var m = ln.match(/^(\s*)(?:->\s*)?([A-Z][A-Za-z ]+?)(?:\s+using\s+([\w.]+))?(?:\s+on\s+([\w.]+)(?:\s+(\w+))?)?\s+\(cost=[\d.]+\.\.([\d.]+) rows=(\d+) width=\d+\)(?:\s+\(actual time=[\d.]+\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\))?/);
      if (m) { cur = { indent: m[1].length, type: m[2].trim(), idx: m[3], rel: m[4], est: +m[7], actual: m[9] !== undefined ? +m[9] : null, loops: m[10] ? +m[10] : 1, time: m[8] ? +m[8] : null, extra: [] }; nodes.push(cur); return; }
      if (cur) cur.extra.push(ln.trim());
    });
    if (!nodes.length) return;
    nodes.forEach(function (nd, i) { nd.underLimit = nodes.slice(0, i).some(function (p) { return /^Limit/.test(p.type) && p.indent < nd.indent; }); });
    nodes.forEach(function (nd) {
      var x = nd.extra.join('\n'), rem = +((x.match(/Rows Removed by Filter: (\d+)/) || [])[1] || 0), filt = (x.match(/Filter: (.*)/) || [])[1];
      var out = nd.actual !== null ? nd.actual * nd.loops : nd.est;
      if (/Seq Scan/.test(nd.type) && (rem + out) >= 10000) add('plan-seq', 'slow', 'Seq Scan on ' + nd.rel + (rem ? ': read ' + n(rem + out) + ' rows to return ' + n(out) : ' over about ' + n(out) + ' rows'),
        'The whole table was read' + (filt ? ' and each row checked against ' + filt : '') + '.', rem > out * 10 ? 'An index on the filtered columns lets it read only the matching rows. Check the Query section above for which index.' : 'If most rows match, a scan is the right plan; the fix is to ask for fewer rows.', 'nb3', nd.rel);
      if (nd.actual !== null && !(nd.underLimit && nd.actual < nd.est) && Math.max(nd.est, nd.actual) >= 100) {
        var ratio = nd.est ? Math.max(nd.est / Math.max(nd.actual, 1), Math.max(nd.actual, 1) / nd.est) : 0;
        if (ratio >= 10) add('plan-estimate', 'slow', nd.type + (nd.rel ? ' on ' + nd.rel : '') + ': estimated ' + n(nd.est) + ' rows, got ' + n(nd.actual), 'The planner chose this plan for a row count that was ' + Math.round(ratio) + ' times off. Join order and join method follow from that guess.', 'Run ANALYZE on the table. If it stays wrong and the filter uses several related columns, CREATE STATISTICS on them helps the planner see the correlation.', 'explain', nd.type + nd.rel);
      }
      var disk = x.match(/Sort Method: external merge\s+Disk: (\d+)kB/);
      if (disk) add('plan-sort-disk', 'slow', 'The sort spilled ' + n(disk[1]) + ' kB to disk', 'The rows to sort did not fit in work_mem, so PostgreSQL sorted them in pieces on disk.', 'An index in the ORDER BY order avoids the sort. Otherwise raise work_mem for this session (SET work_mem = \'64MB\'), not for the whole server.', 'explain');
      var bat = x.match(/Batches: (\d+)/);
      if (bat && +bat[1] > 1 && /Hash/.test(nd.type)) add('plan-hash-batches', 'slow', 'The hash used ' + bat[1] + ' batches', 'The hash table did not fit in work_mem, so it was split and written to disk.', 'Raise work_mem for this query, or reduce the rows going into the hash with a better filter.', 'explain');
      var hf = x.match(/Heap Fetches: (\d+)/);
      if (hf && +hf[1] > 1000) add('plan-heap-fetches', 'tip', 'Index Only Scan still visited the table ' + n(hf[1]) + ' times', 'An index-only scan skips the table only for pages the visibility map marks all-visible. Recently changed pages are not.', 'VACUUM the table (or make autovacuum visit it more often) so more pages are marked all-visible.', 'covering');
      if (nd.loops >= 1000 && nd.indent > 0) add('plan-loops', 'tip', nd.type + (nd.rel ? ' on ' + nd.rel : '') + ' ran ' + n(nd.loops) + ' times', 'It is the inner side of a nested loop, run once per outer row.' + (nd.time !== null ? ' Total time for this node: about ' + n(Math.round(nd.time * nd.loops)) + ' ms.' : ''), 'Check it uses an index. If the outer side really has this many rows, a hash join may be better; the estimate on the outer node is the place to look.', 'explain', nd.type + nd.rel + 'loops');
    });
    var buf = text.match(/Buffers: shared hit=(\d+)(?: read=(\d+))?/);
    if (buf && +(buf[2] || 0) > +buf[1]) add('plan-buffers', 'tip', 'Most pages came from disk: ' + n(buf[2]) + ' read, ' + n(buf[1]) + ' found in memory', 'The pages this query needs were not in shared_buffers. A second run is usually faster, which can make a slow query look fine when you test it.', 'Judge it by its first run. Reading fewer pages (an index, fewer columns) is the real fix.', 'nb3');
  }
  function myTable(text, add) {
    var lines = text.split('\n').filter(function (l) { return /\|/.test(l) && !/^\s*\+[-+]+\+\s*$/.test(l); });
    if (lines.length < 2) return;
    var head = lines[0].split('|').map(function (c) { return c.trim().toLowerCase(); });
    lines.slice(1).forEach(function (l) {
      var c = l.split('|').map(function (x) { return x.trim(); }), g = function (k) { var i = head.indexOf(k); return i >= 0 ? c[i] : ''; };
      var t = g('table'), type = g('type'), rows = +(g('rows') || 0), key = g('key'), pk = g('possible_keys'), extra = g('extra');
      if (type === 'ALL' && rows >= 1000) add('plan-seq', 'slow', 'Full table scan on ' + t + ', about ' + n(rows) + ' rows', 'type ALL means InnoDB reads every row of the table.', 'An index on the columns in the WHERE clause lets it read only the matching rows.', 'nb3', t);
      if (type === 'index' && rows >= 10000) add('plan-full-index', 'tip', 'Full index scan on ' + t, 'type index means the whole index is read, in order, which is cheaper than the table but still every entry.', 'Check whether a filter could narrow it first.', 'colorder', t);
      if ((key === 'NULL' || !key) && pk && pk !== 'NULL') add('plan-key-unused', 'tip', 'Possible keys on ' + t + ' were not used', 'MySQL considered ' + pk + ' and decided a scan was cheaper, usually because it expects many rows to match, or the statistics are stale.', 'Run ANALYZE TABLE ' + t + '. If the condition is not selective, the scan may be right.', 'explain', t);
      if (/Using filesort/i.test(extra)) add('plan-filesort', 'tip', 'Using filesort on ' + t, 'The rows are sorted after they are read, rather than read in index order.', 'An index that matches the WHERE equality columns and then the ORDER BY columns avoids the sort.', 'colorder', t + 'fs');
      if (/Using temporary/i.test(extra)) add('plan-temp', 'tip', 'Using temporary on ' + t, 'MySQL builds a temporary table, typically for GROUP BY, DISTINCT or UNION.', 'An index in GROUP BY order can avoid it. Watch for it spilling to disk on large results.', 'explain', t + 'tmp');
    });
  }
  function myTree(text, add) {
    text.split('\n').forEach(function (l) {
      var m = l.match(/->\s+(Table scan on (\w+)|Index scan on (\w+)|[A-Z].*?)\s+\(cost=[\d.]+(?:\.\.[\d.]+)? rows=([\d.e+]+)\)(?:\s+\(actual time=[\d.]+\.\.([\d.]+) rows=([\d.]+) loops=(\d+)\))?/);
      if (!m) return;
      var est = +m[4], act = m[6] !== undefined ? +m[6] : null, loops = +(m[7] || 1);
      if (m[2] && (act !== null ? act * loops : est) >= 1000) add('plan-seq', 'slow', 'Table scan on ' + m[2] + ', about ' + n(act !== null ? act * loops : est) + ' rows', 'InnoDB read every row of the table.', 'An index on the columns in the WHERE clause lets it read only the matching rows.', 'nb3', m[2]);
      if (/^Sort/.test(m[1]) && est >= 1000) add('plan-filesort', 'tip', m[1].trim(), 'The rows are sorted after they are read.', 'An index that matches the WHERE equality columns and then the ORDER BY columns returns them in order.', 'colorder', m[1]);
      if (act !== null && Math.max(est, act) >= 100) { var r = Math.max(est / Math.max(act, 1), Math.max(act, 1) / Math.max(est, 1)); if (r >= 10) add('plan-estimate', 'slow', m[1].trim() + ': estimated ' + n(Math.round(est)) + ' rows, got ' + n(act), 'The optimizer chose this plan for a row count that was ' + Math.round(r) + ' times off.', 'Run ANALYZE TABLE. For skewed columns, a histogram helps: ANALYZE TABLE t UPDATE HISTOGRAM ON col.', 'explain', m[1]); }
    });
  }

  var API = { review: review, links: L };
  root.HDW_COACH = API;

  // ---------- page ----------
  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('coachGo')) return;
  var $ = function (id) { return document.getElementById(id); };
  var EX = {
    paging: { eng: 'pg', sql: "SELECT * FROM orders\nWHERE date(created_at) = '2026-11-01'\nORDER BY id\nLIMIT 20 OFFSET 10000;", schema: '', plan: '' },
    lost: { eng: 'my', sql: "SELECT stock FROM products WHERE id = 42;\n-- the application subtracts one, then:\nUPDATE products SET stock = 6 WHERE id = 42;", schema: '', plan: '' },
    index: { eng: 'pg', sql: "SELECT o.id, o.total, c.email\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.created_at >= now() - interval '1 day'\nORDER BY o.created_at DESC\nLIMIT 50;", schema: "CREATE TABLE customers (\n  id bigint PRIMARY KEY,\n  email text NOT NULL\n);\nCREATE TABLE orders (\n  id bigint PRIMARY KEY,\n  customer_id bigint NOT NULL REFERENCES customers(id),\n  total float NOT NULL,\n  created_at timestamp NOT NULL\n);\nCREATE INDEX orders_customer_created ON orders (customer_id, created_at);", plan: '' },
    migration: { eng: 'pg', sql: "ALTER TABLE orders ADD COLUMN ref uuid DEFAULT gen_random_uuid();\nCREATE INDEX orders_ref ON orders (ref);\nALTER TABLE orders ALTER COLUMN status SET NOT NULL;", schema: '', plan: '' },
    plan: { eng: 'pg', sql: "SELECT id, total FROM orders WHERE status = 'refunded' ORDER BY created_at DESC LIMIT 20;", schema: '', plan: "Limit  (cost=21837.10..21837.15 rows=20 width=16) (actual time=118.402..118.409 rows=20 loops=1)\n  Buffers: shared hit=212 read=8121\n  ->  Sort  (cost=21837.10..21862.10 rows=10000 width=16) (actual time=118.400..118.404 rows=20 loops=1)\n        Sort Key: created_at DESC\n        Sort Method: top-N heapsort  Memory: 26kB\n        ->  Seq Scan on orders  (cost=0.00..21571.00 rows=10000 width=16) (actual time=0.031..111.902 rows=1204 loops=1)\n              Filter: (status = 'refunded'::text)\n              Rows Removed by Filter: 998796\nPlanning Time: 0.120 ms\nExecution Time: 118.452 ms" }
  };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function code(s) { return esc(s).replace(/(CREATE (?:UNIQUE )?INDEX[^;]*;|SET [a-z_]+ = [^;]*;|ALTER TABLE[^.]*?(?:;|\.(?=\s))|UPDATE [a-z_]+ SET [^.]*?(?=\.\s|\. Or|$)|WHERE \([^)]*\) &lt; \([^)]*\)[^.]*?LIMIT \d+)/g, '<code>$1</code>'); }
  var LABEL = { risk: 'Risk', slow: 'Slow', tip: 'Tip' };
  function run() {
    var eng = (document.querySelector('input[name="coachEng"]:checked') || {}).value || 'pg';
    var sql = $('coachSql').value, schema = $('coachSchema').value, plan = $('coachPlan').value, out = $('coachOut');
    if (!sql.trim() && !schema.trim() && !plan.trim()) { out.innerHTML = '<p class="labnote">Paste a query first.</p>'; return; }
    var R = review({ engine: eng, sql: sql, schema: schema, plan: plan });
    var c = { risk: 0, slow: 0, tip: 0 }; R.findings.forEach(function (f) { c[f.sev]++; });
    var h = '<div class="qc-sum" role="status"><b>' + (R.findings.length ? R.findings.length + ' finding' + (R.findings.length > 1 ? 's' : '') : 'Nothing flagged') + '</b>' +
      (R.findings.length ? ['risk', 'slow', 'tip'].filter(function (k) { return c[k]; }).map(function (k) { return '<span class="qc-pill qc-' + k + '">' + c[k] + ' ' + LABEL[k].toLowerCase() + '</span>'; }).join('') : '') +
      '<span class="qc-meta">' + (R.engine === 'my' ? 'MySQL' : 'PostgreSQL') + ' · ' + R.statements + ' statement' + (R.statements === 1 ? '' : 's') + (R.tables.length ? ' · tables: ' + esc(R.tables.join(', ')) : '') + (R.planKind ? ' · plan read' : '') + '</span></div>';
    if (!R.findings.length) h += '<p class="qc-ok">Nothing in these patterns. That does not make it fast: run it with ' + (R.engine === 'my' ? 'EXPLAIN ANALYZE' : 'EXPLAIN (ANALYZE, BUFFERS)') + ' on real data and paste the plan here' + (schema.trim() ? '' : ', and add the table definitions so I can check the indexes') + '.</p>';
    h += R.findings.map(function (f) {
      return '<article class="qc-f qc-' + f.sev + '"><div class="qc-h"><span class="qc-tag">' + LABEL[f.sev] + '</span><h3>' + esc(f.title) + '</h3></div><p>' + esc(f.why) + '</p>' + (f.fix ? '<p class="qc-fix"><b>Fix:</b> ' + code(f.fix) + '</p>' : '') + (f.link ? '<p class="qc-link"><a href="' + f.link[0] + '">' + esc(f.link[1]) + ' →</a></p>' : '') + '</article>';
    }).join('');
    out.innerHTML = h;
  }
  var pref = window.HDW_ENGINE && HDW_ENGINE.get();
  if (pref === 'pg' || pref === 'my') { var r0 = document.querySelector('input[name="coachEng"][value="' + pref + '"]'); if (r0) r0.checked = true; }
  Array.prototype.forEach.call(document.querySelectorAll('input[name="coachEng"]'), function (r) { r.addEventListener('change', function () { if (r.checked && window.HDW_ENGINE) HDW_ENGINE.set(r.value); }); });
  $('coachGo').addEventListener('click', run);
  Array.prototype.forEach.call(document.querySelectorAll('[data-coach-ex]'), function (b) {
    b.addEventListener('click', function () {
      var e = EX[b.getAttribute('data-coach-ex')];
      document.querySelector('input[name="coachEng"][value="' + e.eng + '"]').checked = true;
      $('coachSql').value = e.sql; $('coachSchema').value = e.schema; $('coachPlan').value = e.plan;
      $('coachSchemaBox').open = !!e.schema; $('coachPlanBox').open = !!e.plan;
      run();
    });
  });
  $('coachClear').addEventListener('click', function () { $('coachSql').value = ''; $('coachSchema').value = ''; $('coachPlan').value = ''; $('coachOut').innerHTML = ''; $('coachSql').focus(); });
})(typeof window !== 'undefined' ? window : globalThis);
