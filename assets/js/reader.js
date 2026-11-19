/* The reader's database, remembered across the site: widgets with a
   PostgreSQL / MySQL / MongoDB switch start on the last one picked. */
window.HDW_ENGINE = window.HDW_ENGINE || {
  get: function () { try { var e = localStorage.getItem('hdw-engine'); return /^(pg|my|mo)$/.test(e || '') ? e : null; } catch (x) { return null; } },
  set: function (e) { try { localStorage.setItem('hdw-engine', e); } catch (x) {} }
};
/* "Try this" goals under a widget: small tasks that tick off when the reader
   does them in the widget. Progress is kept in this browser only.
   HDW_GOALS.attach(afterEl, key, [[id, text], ...]); HDW_GOALS.done(key, id) */
window.HDW_GOALS = window.HDW_GOALS || (function () {
  var lists = {};
  function load() { try { return JSON.parse(localStorage.getItem('hdw-goals') || '{}'); } catch (e) { return {}; } }
  function save(d) { try { localStorage.setItem('hdw-goals', JSON.stringify(d)); } catch (e) {} }
  function paint(key) {
    var L = lists[key]; if (!L) return;
    var d = load()[key] || {}, n = 0;
    L.goals.forEach(function (g) { var li = L.el.querySelector('[data-g="' + g[0] + '"]'); var on = !!d[g[0]]; if (on) n++; li.classList.toggle('done', on); li.setAttribute('aria-checked', String(on)); });
    L.el.querySelector('.goals-n').textContent = n === L.goals.length ? 'All done' : n + ' of ' + L.goals.length;
  }
  return {
    attach: function (after, key, goals) {
      if (!after || !after.parentNode) return;
      var box = document.createElement('div'); box.className = 'goals';
      box.innerHTML = '<div class="goals-h"><b>Try this</b><span class="goals-n"></span></div><ul>' +
        goals.map(function (g) { return '<li role="checkbox" data-g="' + g[0] + '">' + g[1] + '</li>'; }).join('') + '</ul>';
      after.parentNode.insertBefore(box, after.nextSibling);
      lists[key] = { el: box, goals: goals }; paint(key);
    },
    done: function (key, id) {
      var d = load(); d[key] = d[key] || {}; if (d[key][id]) return;
      d[key][id] = 1; save(d); paint(key);
      var li = lists[key] && lists[key].el.querySelector('[data-g="' + id + '"]');
      if (li) { li.classList.add('just'); setTimeout(function () { li.classList.remove('just'); }, 1200); }
    }
  };
})();
/* Folded "Go deeper" sections open by themselves when a link, the Contents
   panel or the address bar points at something inside them. */
(function () {
  function reveal(id) {
    if (!id) return;
    var t = document.getElementById(decodeURIComponent(id)); if (!t) return;
    var d = t.closest && t.closest('details'); var opened = false;
    while (d) { if (!d.open) { d.open = true; opened = true; } d = d.parentElement && d.parentElement.closest('details'); }
    if (opened) setTimeout(function () { t.scrollIntoView(); }, 0);
  }
  function fromHash() { if (location.hash.length > 1 && location.hash.indexOf('#estimate?') !== 0) reveal(location.hash.slice(1)); }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href*="#"]'); if (!a) return;
    var u = a.getAttribute('href'), i = u.indexOf('#');
    if (i === 0 || (a.pathname === location.pathname && a.host === location.host)) reveal(u.slice(i + 1));
  }, true);
  window.addEventListener('hashchange', fromHash);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fromHash); else fromHash();
})();
/* Reading aids, on every page:
   1. a thin progress bar at the top;
   2. a Contents button that lists the page's headings and marks where you are;
   3. a link icon on headings, to copy a link to that spot;
   4. hover or focus cards for database terms (first use on a page only);
   5. pages you have read get a tick in the section index and on the All pages list.
   Read state lives in this browser only (localStorage) and the page works without it. */
(function () {
  var ROOT = (function () {
    var s = document.querySelector('script[src$="assets/js/reader.js"]');
    return s ? s.getAttribute('src').replace('assets/js/reader.js', '') : '';
  })();
  var here = (function () {
    var p = location.pathname.replace(/^\/+/, '');
    if (p === '' || p.slice(-1) === '/') p += 'index.html';
    return p;
  })();
  function slug(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section'; }

  /* 1. progress bar */
  function progressBar() {
    var bar = document.createElement('div');
    bar.className = 'readbar'; bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    function upd() {
      var h = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = 'scaleX(' + (h > 0 ? Math.min(1, scrollY / h) : 0) + ')';
    }
    addEventListener('scroll', upd, { passive: true }); addEventListener('resize', upd); upd();
  }

  /* 2 and 3. contents panel and heading links */
  var SKIP = '.famcard,.cmp3-col,.labcard,.pathcard,.logcard,.opcard,.incident,.mapcard,.mapsec,.partcard,.door,.tut,.viz,.steplist,.myth,.secnav,nav,footer,.quiz,.navmenu,.oncall';
  function headings() {
    var hs = Array.prototype.filter.call(document.querySelectorAll('main h2, body > section h2, body > header h2, body > section h3'), function (h) {
      return !h.closest(SKIP);
    });
    var h2 = hs.filter(function (h) { return h.tagName === 'H2'; });
    var list = h2.length >= 3 ? h2 : hs;
    var used = {};
    list.forEach(function (h) {
      if (!h.id) {
        var sec = h.closest('section[id]');
        var base = (sec && h2.length >= 3 && !used[sec.id] && sec.querySelector('h2') === h) ? null : slug(h.textContent);
        if (base === null) { used[sec.id] = 1; h.dataset.target = sec.id; }
        else { var id = base, n = 2; while (document.getElementById(id)) id = base + '-' + n++; h.id = id; }
      }
    });
    return list;
  }
  function targetId(h) { return h.dataset.target || h.id; }
  function headingLinks(list) {
    list.forEach(function (h) {
      var a = document.createElement('a');
      a.className = 'hlink'; a.href = '#' + targetId(h); a.setAttribute('aria-label', 'Link to this section'); a.textContent = '#';
      a.addEventListener('click', function () {
        try { navigator.clipboard.writeText(location.href.split('#')[0] + '#' + targetId(h)); a.textContent = 'copied'; setTimeout(function () { a.textContent = '#'; }, 1200); } catch (e) {}
      });
      h.appendChild(a);
    });
  }
  function contents(list) {
    if (list.length < 4) return;
    var btn = document.createElement('button');
    btn.className = 'tocbtn'; btn.type = 'button'; btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Contents';
    var panel = document.createElement('div');
    panel.className = 'tocpanel'; panel.hidden = true;
    panel.innerHTML = '<p class="toch">On this page</p>' + list.map(function (h) {
      var t = h.cloneNode(true); var x = t.querySelector('.hlink'); if (x) x.remove();
      return '<a href="#' + targetId(h) + '">' + t.textContent.trim() + '</a>';
    }).join('');
    document.body.appendChild(panel); document.body.appendChild(btn);
    btn.addEventListener('click', function () { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); });
    panel.addEventListener('click', function (e) { if (e.target.tagName === 'A') { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) { panel.hidden = true; btn.focus(); } });
    var links = panel.querySelectorAll('a');
    function spy() {
      var cur = 0;
      list.forEach(function (h, i) { var el = document.getElementById(targetId(h)) || h; if (el.getBoundingClientRect().top < 140) cur = i; });
      Array.prototype.forEach.call(links, function (a, i) { a.classList.toggle('on', i === cur); });
    }
    addEventListener('scroll', spy, { passive: true }); spy();
  }

  /* 4. glossary cards */
  var G = {
    'WAL': ['The write-ahead log: PostgreSQL writes every change here first, and COMMIT waits for it to reach disk.', 'postgresql/index.html'],
    'redo log': ['InnoDB\'s write-ahead log. Crash recovery replays it into the data files.', 'mysql/index.html'],
    'binlog': ['MySQL\'s logical log of committed changes, used by replicas and point-in-time recovery, not by crash recovery.', 'mysql/index.html'],
    'oplog': ['MongoDB\'s replication log, a capped collection in the local database that secondaries copy and apply.', 'mongodb/index.html'],
    'journal': ['WiredTiger\'s write-ahead log in MongoDB. It covers the changes made since the last checkpoint.', 'mongodb/index.html'],
    'checkpoint': ['The moment the engine writes dirty pages from memory to the data files, so crash recovery can start from there.', 'compare/index.html#crash'],
    'fsync': ['The system call that forces data from the operating system cache onto the disk. Durable commits wait for it.', 'notebooks/index.html#commit-cost'],
    'MVCC': ['Multi-version concurrency control: writers create new row versions, and readers see the versions that match their snapshot.', 'isolation/index.html'],
    'VACUUM': ['PostgreSQL\'s cleanup of dead row versions, so their space can be reused.', 'notebooks/index.html#long-transaction'],
    'purge': ['InnoDB\'s cleanup of undo records that no open transaction can still need.', 'notebooks/index.html#long-transaction'],
    'undo log': ['Where InnoDB keeps old row versions, for rollback and for readers with an older snapshot.', 'mysql/index.html'],
    'buffer pool': ['InnoDB\'s main memory cache of 16 KB pages.', 'mysql/index.html'],
    'shared_buffers': ['PostgreSQL\'s shared memory cache of 8 KB pages.', 'postgresql/index.html'],
    'WiredTiger cache': ['MongoDB\'s storage engine cache, where documents are read and changed before checkpoints write them out.', 'mongodb/index.html'],
    'B+ tree': ['The index structure in all three engines: a lookup walks root, branch and leaf, a few pages at any table size.', 'families/index.html'],
    'LSM tree': ['A storage layout that writes to memory and sorted files, then merges them in the background. Fast for heavy writes.', 'families/index.html'],
    'replication slot': ['A PostgreSQL bookmark for a replica or a CDC consumer. The primary keeps WAL until the slot has consumed it.', 'designs/migrations/index.html#cdc'],
    'write concern': ['How many MongoDB members must have a write, and whether it must be journaled, before it is acknowledged.', 'compare/index.html#write'],
    'isolation level': ['How much of other transactions\' work a transaction can see, and which anomalies the engine prevents.', 'isolation/index.html'],
    'write skew': ['Two transactions read the same rule, each changes a different row, and together they break the rule.', 'isolation/index.html#write-skew'],
    'lost update': ['Two read-then-write transactions overwrite each other, and one change disappears.', 'isolation/index.html#lost-update'],
    'covering index': ['An index that holds every column a query needs, so the table itself is never read.', 'queries/index.html#covering'],
    'keyset': ['Paging by remembering the last key seen (WHERE id > last), instead of OFFSET.', 'queries/index.html#paging'],
    'working set': ['The data the application touches in a normal period. Memory should hold it.', 'designs/capacity/index.html'],
    'bloat': ['Space in tables and indexes taken by dead row versions or empty pages.', 'notebooks/index.html#long-transaction'],
    'change data capture': ['Streaming every committed change out of a database to other systems.', 'designs/migrations/index.html#cdc'],
    'failover': ['Promoting a standby to primary when the primary fails.', 'decisions/sync-replication-failover/index.html'],
    'idempotency key': ['A unique key sent with a request, so a retry is recognized and not applied twice.', 'designs/payments-ledger/index.html'],
    'row-level security': ['PostgreSQL policies that filter rows per user or tenant, whatever the query says.', 'designs/multi-tenant-saas/index.html']
  };
  function glossary() {
    var keys = Object.keys(G).sort(function (a, b) { return b.length - a.length; });
    var re = new RegExp('\\b(' + keys.map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')\\b');
    var done = {}, budget = 14;
    var scope = document.querySelectorAll('body > section p, body > section li, body > section dd, body > header p.lede, body > section td');
    Array.prototype.some.call(scope, function (el) {
      if (budget <= 0) return true;
      if (el.closest('nav,footer,.secnav,.quiz,.oncall,.navmenu,pre,code,.verdict')) return false;
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        if (node.parentElement.closest('a,code,pre,.mono,b,h1,h2,h3,button,svg,.gterm')) continue;
        var m = re.exec(node.nodeValue);
        if (!m || done[m[1]]) continue;
        var term = m[1], d = G[term];
        if (pageKey(ROOT + d[1].split('#')[0]) === here) { done[term] = 1; continue; }
        var after = node.splitText(m.index); after.nodeValue = after.nodeValue.slice(term.length);
        var span = document.createElement('span');
        span.className = 'gterm'; span.tabIndex = 0; span.textContent = term;
        var card = document.createElement('span');
        card.className = 'gcard'; card.setAttribute('role', 'tooltip');
        card.innerHTML = '<b>' + term + '</b> ' + d[0] + ' <a href="' + ROOT + d[1] + '">More →</a>';
        span.appendChild(card);
        node.parentNode.insertBefore(span, after);
        done[term] = 1; budget--;
        break;
      }
      return false;
    });
  }

  /* 5. read tracking */
  var KEY = 'hdw-read-v1';
  function getRead() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function setRead(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
  function pageKey(href) {
    var a = document.createElement('a'); a.href = href;
    var p = a.pathname.replace(/^\/+/, ''); if (p === '' || p.slice(-1) === '/') p += 'index.html';
    return p;
  }
  function markLinks() {
    var r = getRead();
    Array.prototype.forEach.call(document.querySelectorAll('.secnav-list a, .mapsec li a, .partcard li a'), function (a) {
      a.classList.toggle('read', !!r[pageKey(a.getAttribute('href'))]);
    });
    var head = document.querySelector('.secnav-head .kicker');
    var chips = document.querySelectorAll('.secnav-list a');
    if (head && chips.length) {
      var n = Array.prototype.filter.call(chips, function (a) { return a.classList.contains('read'); }).length;
      var tag = head.querySelector('.readcount') || document.createElement('span');
      tag.className = 'readcount'; tag.textContent = ' · ' + n + ' of ' + chips.length + ' read';
      head.appendChild(tag);
    }
  }
  function trackRead() {
    var done = false;
    function check() {
      if (done) return;
      var h = document.documentElement.scrollHeight - innerHeight;
      if (h <= 0 || scrollY / h > 0.85) {
        done = true; var r = getRead(); r[here] = Date.now(); setRead(r); markLinks();
      }
    }
    addEventListener('scroll', check, { passive: true });
    setTimeout(check, 1500);
  }


  /* 6. check-yourself quizzes */
  function quizzes() {
    Array.prototype.forEach.call(document.querySelectorAll('.quiz'), function (qz) {
      var items = qz.querySelectorAll('.qz'), score = qz.querySelector('.qscore'), right = 0, answered = 0;
      Array.prototype.forEach.call(items, function (it) {
        var ans = it.getAttribute('data-answer');
        Array.prototype.forEach.call(it.querySelectorAll('.qopt'), function (b) {
          b.addEventListener('click', function () {
            if (it.classList.contains('done')) return;
            it.classList.add('done'); answered++;
            var ok = b.getAttribute('data-i') === ans;
            if (ok) right++;
            b.classList.add(ok ? 'good' : 'bad');
            b.insertAdjacentText('beforeend', ok ? '  ✓ right' : '  ✗ not quite');
            Array.prototype.forEach.call(it.querySelectorAll('.qopt'), function (o) {
              o.disabled = true;
              if (o.getAttribute('data-i') === ans && o !== b) { o.classList.add('good'); o.insertAdjacentText('beforeend', '  ✓ the answer'); }
            });
            it.querySelector('.qe').hidden = false;
            if (answered === items.length) score.textContent = right + ' of ' + items.length + ' right. ' + (right === items.length ? 'All of them.' : 'Read the explanations above, then the section of this page that covers each one.');
          });
        });
      });
    });
  }

  /* 7. the course: continue where you left off, and progress */
  function courseContinue() {
    var box = document.getElementById('continue');
    if (!box) return;
    var order = JSON.parse(box.getAttribute('data-order') || '[]'), total = +box.getAttribute('data-total');
    var r = getRead(), done = 0, last = -1;
    order.forEach(function (o, i) { if (r[pageKey(o[0])]) { done++; last = i; } });
    if (!done) return;
    var next = null;
    for (var k = last + 1; k < order.length && !next; k++) if (!r[pageKey(order[k][0])]) next = order[k];
    for (var j = 0; j < order.length && !next; j++) if (!r[pageKey(order[j][0])]) next = order[j];
    var pct = Math.round(100 * done / total);
    function e(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    box.innerHTML = next
      ? '<a class="contcard" href="' + e(next[0]) + '"><span class="ck">Pick up where you left off · ' + done + ' of ' + total + ' read</span>' +
        '<b>Lesson ' + next[3] + ' · ' + e(next[1]) + '</b><span class="cs">' + e(next[2]) + '</span>' +
        '<span class="cbar"><span style="width:' + pct + '%"></span></span><i>Continue →</i></a>'
      : '<div class="contcard"><span class="ck">All ' + total + ' lessons read</span><b>You have read the whole course.</b><span class="cs">New pages appear in What\'s new and the RSS feed.</span><span class="cbar"><span style="width:100%"></span></span></div>';
  }

  function run(f) { try { f(); } catch (e) {} }
  run(progressBar);
  var hs = []; run(function () { hs = headings(); });
  run(function () { headingLinks(hs); });
  run(function () { contents(hs); });
  run(glossary);
  run(markLinks);
  run(trackRead);
  run(quizzes);
  run(courseContinue);
})();
