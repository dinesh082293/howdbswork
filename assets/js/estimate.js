/* Estimate it: back-of-the-envelope numbers for each design doc, plus one question.
   Markup: <div class="estimate" data-slug="social-feed"></div>
   State is kept in the URL as #estimate?key=value&... so a link opens the same numbers. */
(function () {
  function fmt(n) { n = Math.round(n); return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function f1(n) { return n >= 100 ? fmt(n) : (Math.round(n * 10) / 10).toString(); }
  function size(b) {
    var u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], i = 0;
    while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return (b >= 100 ? fmt(b) : (Math.round(b * 10) / 10)) + ' ' + u[i];
  }
  function dur(s) {
    if (s < 1) return fmt(s * 1000) + ' ms';
    if (s < 120) return f1(s) + ' s';
    if (s < 7200) return f1(s / 60) + ' min';
    if (s < 172800) return f1(s / 3600) + ' hours';
    return f1(s / 86400) + ' days';
  }
  var DAY = 86400;
  var NB2 = '../../notebooks/index.html#commit-cost', NB3 = '../../notebooks/index.html#scan-vs-index', NB7 = '../../notebooks/index.html#other-engines';

  var S = {
    'store-orders': {
      inputs: [['orders', 'Orders per day, thousands', 10, 5000, 10, 200, 'k'], ['items', 'Line items per order', 1, 10, 1, 3, ''],
        ['peak', 'Peak hour, times the daily average', 1, 20, 0.5, 4, '×'], ['txms', 'How long a checkout transaction holds the stock row, ms', 1, 50, 1, 5, ' ms']],
      calc: function (v) {
        var ops = v.orders * 1e3 / DAY, pk = ops * v.peak, rows = pk * (1 + v.items), yr = v.orders * 1e3 * (1 + v.items) * 150 * 365;
        var oneRow = 1000 / v.txms;
        return { r: [[fmt(pk) + '/s', 'checkout transactions at peak (' + f1(ops) + '/s average)', pk > 2000],
          [fmt(rows) + '/s', 'rows written at peak: the order plus its items', false],
          [size(yr), 'order and item rows per year, at about 150 bytes a row', yr > 2e12],
          [fmt(oneRow) + '/s', 'the most checkouts one stock row can take, one at a time', oneRow < 300]],
          note: 'About 150 bytes a row is what a narrow table measured in <a href="' + NB3 + '">Notebook 3</a>, index not included. Peak commits are well inside what one PostgreSQL or MySQL primary does; the stock row is where it gets tight.' };
      },
      q: 'A flash sale puts 20,000 shoppers on one product in the first minute. Every checkout updates the same stock row. What breaks first, and what would you change?',
      a: function (v) {
        var want = 20000 / 60, cap = 1000 / v.txms;
        return '<p><b>The arithmetic:</b> 20,000 in 60 seconds is about <b>' + fmt(want) + ' updates a second</b> on one row. Each one holds that row\'s lock for ' + v.txms + ' ms until it commits, so the row can take at most <b>' + fmt(cap) + ' a second</b>.</p>' +
          '<p><b>What happens:</b> ' + (want > cap ? 'the queue grows by about ' + fmt(want - cap) + ' checkouts every second. Connections pile up waiting on the lock, the pool runs dry, and pages that never touch this product slow down too.' : 'it keeps up at this transaction time, but only just. Anything that makes the transaction slower, such as a call to the payment provider while the lock is held, tips it over.') + '</p>' +
          '<p><b>What I would change:</b> keep the lock as short as possible: one <code>UPDATE ... SET stock = stock - 1 WHERE id = ? AND stock &gt; 0</code>, committed straight away, with payment outside the transaction. For bigger sales, split the stock into several rows and take from any one with stock left.</p>';
      }
    },
    'payments-ledger': {
      inputs: [['pay', 'Payments per day, thousands', 10, 10000, 10, 500, 'k'], ['entries', 'Ledger entries per payment', 2, 8, 1, 4, ''],
        ['peak', 'Peak hour, times the daily average', 1, 10, 0.5, 3, '×'], ['years', 'Years you must keep it', 1, 10, 1, 7, ' years']],
      calc: function (v) {
        var ops = v.pay * 1e3 / DAY, pk = ops * v.peak, ent = pk * v.entries, total = v.pay * 1e3 * v.entries * 365 * v.years, bytes = total * 150;
        return { r: [[fmt(pk) + '/s', 'payment transactions at peak (' + f1(ops) + '/s average)', pk > 1700],
          [fmt(ent) + '/s', 'ledger rows written at peak', false],
          [fmt(total / 1e9 >= 1 ? total / 1e9 : total / 1e6) + (total / 1e9 >= 1 ? ' billion' : ' million'), 'ledger rows over the retention period', false],
          [size(bytes), 'ledger data, at about 150 bytes a row, before indexes', bytes > 5e12]],
          note: 'In <a href="' + NB2 + '">Notebook 2</a>, one client doing fully durable commits got about 1,770 a second on MySQL and 4,200 on PostgreSQL. Many clients share flushes, so the real ceiling is higher. Durable commits are not optional here.' };
      },
      q: 'Finance wants every merchant\'s balance at month end. There are 50,000 merchants. Do you add up the ledger, or keep a balance, and how do you prove the two agree?',
      a: function (v) {
        var month = v.pay * 1e3 * v.entries * 30;
        return '<p><b>The arithmetic:</b> one month of ledger is about <b>' + fmt(month / 1e6) + ' million rows</b>. Adding them up per merchant works, but a balance read on every payment would mean summing all of history, which is ' + fmt(v.pay * 1e3 * v.entries * 365 * v.years / 1e6) + ' million rows by the end of the retention period.</p>' +
          '<p><b>What I would do:</b> keep a balance row per account and change it in the same transaction as the ledger entries, so they can never disagree after a commit. The ledger stays the source of truth.</p>' +
          '<p><b>Proving it:</b> a nightly job sums the day\'s entries per account and compares the total with the change in the balance row. Any difference pages someone. Entries are never updated or deleted; a mistake is fixed with a new reversing entry.</p>';
      }
    },
    'booking-reservations': {
      inputs: [['bookings', 'Bookings per day, thousands', 1, 2000, 1, 50, 'k'], ['look', 'Searches per booking', 5, 200, 5, 40, ''],
        ['peak', 'Peak hour, times the daily average', 1, 10, 0.5, 3, '×'], ['hold', 'Minutes a hold lasts before it expires', 1, 30, 1, 10, ' min']],
      calc: function (v) {
        var b = v.bookings * 1e3 / DAY * v.peak, s = b * v.look, holds = b * 1.5 * v.hold * 60;
        return { r: [[fmt(s) + '/s', 'availability searches at peak', s > 20000],
          [f1(b) + '/s', 'bookings at peak', false],
          [fmt(holds), 'holds alive at once, if a third of holds never pay', false],
          [fmt(v.look) + ' to 1', 'reads to writes', false]],
          note: 'The searches are the load; the bookings are the correctness. Searches can come from a cache or a replica that is a few seconds behind. The booking itself has to go to the primary and check the seat inside the transaction.' };
      },
      q: 'A concert goes on sale: 100,000 fans, 5,000 seats, and most of the seats go in the first two minutes. Where is the pressure, and how do you hand out seats without double booking?',
      a: function (v) {
        return '<p><b>The arithmetic:</b> 5,000 seats in 120 seconds is about <b>42 bookings a second</b>, which any primary handles. 100,000 fans refreshing the seat map every few seconds is about <b>' + fmt(100000 / 3) + ' reads a second</b>, which is the real load.</p>' +
          '<p><b>What I would change:</b> serve the seat map from a cache refreshed every second or two, so it is allowed to be slightly wrong. Put people in a waiting room in front of the booking step.</p>' +
          '<p><b>Handing out seats:</b> each hold is one short transaction: <code>SELECT ... FOR UPDATE SKIP LOCKED</code> on a free seat, mark it held with an expiry ' + v.hold + ' minutes out, commit. Two fans never get the same row, and nobody waits on a lock someone else holds. A unique constraint on (event, seat) for paid bookings is the last line of defence.</p>';
      }
    },
    'accounts-sessions': {
      inputs: [['dau', 'Daily active users, millions', 0.1, 50, 0.1, 2, 'M'], ['req', 'Requests per user per day', 10, 1000, 10, 200, ''],
        ['ttl', 'Session lifetime, hours', 1, 720, 1, 24, ' h'], ['bytes', 'Bytes per session', 100, 4000, 100, 500, ' B']],
      calc: function (v) {
        var reads = v.dau * 1e6 * v.req / DAY * 3, live = v.dau * 1e6 * Math.min(1, v.ttl / 24 + 0.2), mem = live * (v.bytes + 100);
        return { r: [[fmt(reads) + '/s', 'session lookups at peak (3× the average)', reads > 200000],
          [fmt(live / 1e6 >= 1 ? live / 1e6 : live / 1e3) + (live / 1e6 >= 1 ? ' million' : 'k'), 'sessions alive at once (rough)', false],
          [size(mem), 'memory for live sessions, with about 100 bytes of key overhead each', mem > 64e9],
          [f1(v.dau * 1e6 * 1.2 / DAY * 3) + '/s', 'logins at peak, if most users log in about once a day', false]],
          note: 'Every request checks the session, so this is a key lookup at very high rates. That is why sessions usually live in Redis or a signed token, and accounts live in the relational database.' };
      },
      q: 'The session store restarts and loses every session. What happens in the next minute, and what would you put in place before it happens?',
      a: function (v) {
        var live = v.dau * 1e6 * Math.min(1, v.ttl / 24 + 0.2), back = live * 0.1 / 60, cores = back * 0.1;
        return '<p><b>The arithmetic:</b> about ' + fmt(live) + ' live sessions disappear. If only one in ten of those users comes back in the next minute, that is <b>' + fmt(back) + ' logins a second</b>. A password hash is built to be slow, roughly 100 ms of CPU each, so that needs about <b>' + fmt(cores) + ' CPU cores</b> just for hashing.</p>' +
          '<p><b>What happens:</b> the login service saturates, login requests time out, users retry, and the account database takes the extra reads as well.</p>' +
          '<p><b>What I would change:</b> run the session store with a replica and persistence so a restart is not a wipe. Use long-lived refresh tokens so most users get a new session without a password. Rate limit logins per user and keep spare capacity for this day.</p>';
      }
    },
    'multi-tenant-saas': {
      inputs: [['tenants', 'Tenants', 10, 50000, 10, 2000, ''], ['rows', 'Rows for an average tenant, thousands', 1, 5000, 1, 200, 'k'],
        ['big', 'Largest tenant, times the average', 1, 2000, 1, 300, '×'], ['tables', 'Tables per tenant', 5, 200, 5, 40, '']],
      calc: function (v) {
        var total = v.tenants * v.rows * 1e3 + (v.big - 1) * v.rows * 1e3, bytes = total * 150, bigb = v.big * v.rows * 1e3 * 150;
        return { r: [[size(bytes), 'all tenant data, at about 150 bytes a row', bytes > 4e12],
          [size(bigb), 'the largest tenant on its own', bigb > 1e12],
          [f1(bigb / bytes * 100) + '%', 'of all data belongs to the largest tenant', bigb / bytes > 0.3],
          [fmt(v.tenants * v.tables), 'tables, if each tenant gets its own schema', v.tenants * v.tables > 100000]],
          note: 'Row size is the same rough 150 bytes from <a href="' + NB3 + '">Notebook 3</a>. The point is the shape: one tenant can be a large share of everything, and a schema per tenant multiplies the table count.' };
      },
      q: 'Your largest customer is ' + '{big}' + ' times the size of the average one and asks for their own database. Shared tables, a schema per tenant, or a database per tenant?',
      a: function (v) {
        var mig = v.tenants * 2;
        return '<p><b>The arithmetic:</b> a schema per tenant means <b>' + fmt(v.tenants * v.tables) + ' tables</b>, and every migration runs once per tenant: at 2 seconds a tenant that is <b>' + dur(mig) + '</b> per change, with some tenants on the new schema and some on the old one in between.</p>' +
          '<p><b>What I would do:</b> keep most tenants in shared tables with <code>tenant_id</code> first in every primary key and index, and row-level security as a backstop. Move the largest tenant to its own cluster running the same schema. That is a database per tenant for the few who need it, without paying for it ' + fmt(v.tenants) + ' times.</p>' +
          '<p><b>What to plan for:</b> a tenant directory that says which cluster each tenant lives on, so moving one later is a data copy and a directory update.</p>';
      }
    },
    'product-catalog': {
      inputs: [['products', 'Products, millions', 0.1, 100, 0.1, 5, 'M'], ['kb', 'Average product document, KB', 1, 50, 1, 4, ' KB'],
        ['views', 'Product page views per day, millions', 1, 1000, 1, 50, 'M'], ['hit', 'Cache hit rate, percent', 0, 99, 1, 95, '%']],
      calc: function (v) {
        var pv = v.views * 1e6 / DAY * 3, db = pv * (1 - v.hit / 100), data = v.products * 1e6 * v.kb * 1e3;
        return { r: [[fmt(pv) + '/s', 'product page views at peak (3× the average)', false],
          [fmt(db) + '/s', 'reads that miss the cache and reach the database', db > 20000],
          [size(data), 'catalog data before indexes', data > 1e12],
          [size(data * 1.5), 'with indexes and some room, a rough working set', data * 1.5 > 512e9]],
          note: 'A catalog is read far more than it is changed, so the cache hit rate decides how big the database has to be. Move the slider from 95% to 80% and the database load goes up four times.' };
      },
      q: 'Marketing reprices 2 million products in one job. What does that do to the replicas, the cache and the search index?',
      a: function (v) {
        var log = 2e6 * v.kb * 1e3 * 1.2, at = 2e6 / 2000;
        return '<p><b>The arithmetic:</b> 2 million updates of a ' + v.kb + ' KB document write about <b>' + size(log) + '</b> of WAL or oplog, because the whole row or document is logged. At 2,000 updates a second the job takes about <b>' + dur(at) + '</b>.</p>' +
          '<p><b>What happens:</b> if the job runs as fast as it can, replicas fall behind and customers on a replica see old prices. Two million cache entries go stale at once, and the search index has a backlog of 2 million documents to reindex.</p>' +
          '<p><b>What I would change:</b> run it in batches of a few thousand with a pause, watching replica lag. Keep prices in their own small table or document so a price change does not rewrite the whole product. Invalidate the cache from the change stream rather than from the job.</p>';
      }
    },
    'social-feed': {
      inputs: [['dau', 'Daily active users, millions', 1, 50, 1, 5, 'M'], ['opens', 'Feed opens per user per day', 1, 30, 1, 8, ''],
        ['posts', 'New posts per day, thousands', 50, 5000, 50, 500, 'k'], ['followers', 'Average followers per post', 10, 2000, 10, 200, ''],
        ['peak', 'Peak hour, times the daily average', 1, 10, 0.5, 3, '×']],
      calc: function (v) {
        var reads = v.dau * 1e6 * v.opens / DAY, writes = v.posts * 1e3 * v.followers / DAY, mem = v.dau * 1e6 * 800 * 96;
        return { r: [[fmt(reads * v.peak) + '/s', 'feed reads at peak (' + fmt(reads) + '/s average)', false],
          [fmt(writes * v.peak) + '/s', 'timeline writes at peak, after fan-out', writes * v.peak > 50000],
          [size(mem), 'Redis memory if every active user keeps 800 entries', mem > 256e9],
          [fmt(writes / Math.max(reads, 1) * 100) + '%', 'writes as a share of reads', false]],
          note: 'About 96 bytes per sorted-set entry, from the Redis run in <a href="' + NB7 + '">Notebook 7</a>. ' + (mem > 256e9 ? 'That much memory is the real design problem: keep timelines only for users active in the last week, or shorten them.' : 'This fits in a modest Redis cluster.') };
      },
      q: 'An account with 20 million followers posts ten times in one hour, at peak. What happens to the fan-out work, and what would you change?',
      a: function (v) {
        var normal = v.posts * 1e3 * v.followers / DAY * v.peak;
        return '<p><b>The arithmetic:</b> 10 posts × 20,000,000 followers = 200 million timeline writes in an hour, about <b>' + fmt(2e8 / 3600) + ' a second</b>, on top of the normal peak of ' + fmt(normal) + ' a second.</p>' +
          '<p><b>What happens:</b> the fan-out queue backs up for that whole hour, and every follower of every other account waits behind it.</p>' +
          '<p><b>What I would change:</b> no fan-out above a follower threshold. Those posts are merged into the timeline when a reader opens it. Most feeds end up as a hybrid of the two.</p>';
      }
    },
    'search-ai-retrieval': {
      inputs: [['docs', 'Documents, millions', 0.1, 100, 0.1, 2, 'M'], ['chunks', 'Chunks per document', 1, 50, 1, 8, ''],
        ['dims', 'Embedding dimensions', 256, 3072, 256, 768, ''], ['qps', 'Searches per second at peak', 1, 5000, 1, 200, '']],
      calc: function (v) {
        var n = v.docs * 1e6 * v.chunks, raw = n * v.dims * 4, graph = n * 16 * 2 * 8, total = raw + graph;
        return { r: [[fmt(n / 1e6 >= 1 ? n / 1e6 : n / 1e3) + (n / 1e6 >= 1 ? ' million' : 'k'), 'vectors to index', false],
          [size(raw), 'raw vectors at 4 bytes a dimension', false],
          [size(total), 'with an HNSW graph (about 16 links a node each way)', total > 256e9],
          [size(n * v.dims), 'if you quantize to one byte a dimension', false]],
          note: 'HNSW search is fast only while the index is in memory. The graph overhead here is a rough rule, not a measurement. The number that decides the design is the third one.' };
      },
      q: 'Product wants to move from ' + '{dims}' + ' to 3,072 dimensions for better answers. What happens to memory, and does it change where the vectors live?',
      a: function (v) {
        var n = v.docs * 1e6 * v.chunks, now = n * v.dims * 4 + n * 256, then = n * 3072 * 4 + n * 256;
        return '<p><b>The arithmetic:</b> the index goes from about <b>' + size(now) + '</b> to about <b>' + size(then) + '</b>, ' + f1(then / now) + ' times as much, for the same ' + fmt(n) + ' vectors.</p>' +
          '<p><b>What happens:</b> ' + (then > 256e9 ? 'that no longer fits in the memory of one ordinary database server, so a pgvector HNSW index starts reading from disk and search latency jumps.' : 'it still fits on one server, but rebuilding the index takes longer and every insert costs more.') + '</p>' +
          '<p><b>What I would check first:</b> measure whether the answers actually get better on your own questions. If they do, try quantized vectors or a model that lets you cut dimensions before moving to a separate vector store. Keep the documents and permissions in the relational database either way.</p>';
      }
    },
    'chat-messaging': {
      inputs: [['dau', 'Daily active users, millions', 0.1, 50, 0.1, 3, 'M'], ['msgs', 'Messages sent per user per day', 1, 200, 1, 30, ''],
        ['group', 'Average people in a conversation', 2, 500, 1, 6, ''], ['peak', 'Peak hour, times the daily average', 1, 10, 0.5, 3, '×']],
      calc: function (v) {
        var m = v.dau * 1e6 * v.msgs / DAY, pk = m * v.peak, dl = pk * (v.group - 1), yr = v.dau * 1e6 * v.msgs * 365 * 300;
        return { r: [[fmt(pk) + '/s', 'messages written at peak (' + fmt(m) + '/s average)', pk > 50000],
          [fmt(dl) + '/s', 'deliveries to push to other members', dl > 500000],
          [size(yr), 'message history per year, at about 300 bytes a message', yr > 50e12],
          [fmt(v.dau * 1e6 * 0.15), 'open connections, if 15% of daily users are online at once', false]],
          note: 'Messages are written once and read by every member, mostly by the newest first. That shape is why message history is usually partitioned by conversation and time.' };
      },
      q: 'One announcement goes out to a 100,000-member channel. How many writes is that, and how would you avoid most of them?',
      a: function () {
        return '<p><b>The arithmetic:</b> copying the message into every member\'s inbox is <b>100,000 writes</b> and about <b>' + size(1e5 * 150) + '</b> of rows for one message. Doing it a few times an hour is fine; doing it for every busy channel is not.</p>' +
          '<p><b>What I would change:</b> store the message once, in the channel\'s history. Each member keeps one row with the last message they have read. Unread counts come from comparing that pointer with the channel\'s latest message id.</p>' +
          '<p><b>Delivery:</b> push the message to members who are online over their open connection. Members who are offline see it when they next open the channel. Only small direct conversations get a copy per person, if at all.</p>';
      }
    },
    'iot-telemetry': {
      inputs: [['devices', 'Devices, thousands', 1, 10000, 1, 100, 'k'], ['rate', 'Readings per device per minute', 1, 600, 1, 6, ''],
        ['bytes', 'Bytes per reading, uncompressed', 16, 500, 4, 60, ' B'], ['ratio', 'Compression ratio you expect', 1, 30, 1, 10, '×'], ['days', 'Days of raw data you keep', 1, 730, 1, 30, ' days']],
      calc: function (v) {
        var pts = v.devices * 1e3 * v.rate / 60, mbs = pts * v.bytes, stored = pts * DAY * v.days * v.bytes / v.ratio;
        return { r: [[fmt(pts) + '/s', 'readings arriving', pts > 1e6],
          [size(mbs) + '/s', 'raw ingest before compression', false],
          [size(stored), 'stored on disk for the retention period', stored > 20e12],
          [fmt(pts * DAY / 1e6) + ' million', 'rows per day', false]],
          note: 'In <a href="' + NB7 + '">Notebook 7</a>, ClickHouse compressed generated columns 100 to 195 times. Real sensor data compresses far less, so the ratio here is your assumption: 5 to 15 times is a common range.' };
      },
      q: 'Someone asks to keep raw readings for two years instead of ' + '{days}' + ' days. What does that cost, and what would you offer instead?',
      a: function (v) {
        var pts = v.devices * 1e3 * v.rate / 60, per = pts * DAY * v.bytes / v.ratio, two = per * 730, roll = v.devices * 1e3 * DAY * 730 * v.bytes / v.ratio;
        return '<p><b>The arithmetic:</b> one day of raw readings is about <b>' + size(per) + '</b> on disk, so two years is about <b>' + size(two) + '</b>, ' + f1(730 / v.days) + ' times today\'s storage.</p>' +
          '<p><b>What I would offer:</b> raw readings for ' + v.days + ' days, then one-minute rollups (min, max, average, count) kept for two years. That is one row per device per minute instead of ' + v.rate + ', about <b>' + size(roll) + '</b> for two years' + (v.rate > 1 ? ', ' + f1(two / roll) + ' times smaller' : '') + '.</p>' +
          '<p><b>How:</b> partition by day so expiring raw data is dropping a partition, not deleting rows. Build the rollups as data arrives, with a materialized view or a scheduled job.</p>';
      }
    },
    'audit-event-log': {
      inputs: [['events', 'Events per day, millions', 0.1, 1000, 0.1, 20, 'M'], ['kb', 'Average event, KB', 0.2, 10, 0.1, 1, ' KB'],
        ['years', 'Years you must keep it', 1, 10, 1, 7, ' years'], ['peak', 'Peak hour, times the daily average', 1, 10, 0.5, 3, '×']],
      calc: function (v) {
        var pk = v.events * 1e6 / DAY * v.peak, day = v.events * 1e6 * v.kb * 1e3, all = day * 365 * v.years;
        return { r: [[fmt(pk) + '/s', 'events written at peak', pk > 50000],
          [size(day), 'new data per day', false],
          [size(all), 'kept over the whole retention period', all > 50e12],
          [fmt(v.years * 12), 'monthly partitions', false]],
          note: 'An audit log is append-only and almost never read, until someone needs one customer\'s history fast. Design for that one read.' };
      },
      q: 'Legal asks for every event touching one customer over ' + '{years}' + ' years. How long does that take, and what makes it fast?',
      a: function (v) {
        var all = v.events * 1e6 * v.kb * 1e3 * 365 * v.years, scan = all / 1e9;
        return '<p><b>The arithmetic:</b> without an index on the customer, the query reads all <b>' + size(all) + '</b>. At about 1 GB a second that is <b>' + dur(scan) + '</b>, and it competes with the writes the whole time.</p>' +
          '<p><b>What makes it fast:</b> an index on (customer_id, created_at) in each monthly partition. The query becomes ' + fmt(v.years * 12) + ' small index lookups, one per partition, which is seconds rather than ' + dur(scan) + '.</p>' +
          '<p><b>What else:</b> older partitions can move to cheaper storage or a column store, keeping the same index. Make the table insert-only through permissions, so nobody can quietly change history.</p>';
      }
    },
    'leaderboards-counters': {
      inputs: [['players', 'Players on the board, millions', 0.1, 100, 0.1, 10, 'M'], ['ups', 'Score updates per second at peak, thousands', 1, 500, 1, 20, 'k'],
        ['reads', 'Leaderboard reads per second, thousands', 1, 500, 1, 30, 'k']],
      calc: function (v) {
        var mem = v.players * 1e6 * 96, ops = (v.ups + v.reads) * 1e3, cores = ops / 100000;
        return { r: [[size(mem), 'memory for the sorted set, at 96 bytes a player', mem > 64e9],
          [fmt(ops) + '/s', 'Redis commands at peak', false],
          [f1(cores), 'busy Redis cores, at a rough 100,000 commands a core', cores > 1],
          [fmt(Math.ceil(v.ups * 1e3 * 0.08 / 1000)), 'connections needed at least, if each update waits for its reply (0.08 ms)', false]],
          note: '96 bytes a member and 0.08 ms a ZINCRBY are from <a href="' + NB7 + '">Notebook 7</a>, with one client. One sorted set lives on one Redis shard, so it can only use one core however big the cluster is.' };
      },
      q: 'A streamer sends a million viewers to press "like" on one counter within ten seconds. One key, one Redis shard. What happens, and what would you change?',
      a: function () {
        return '<p><b>The arithmetic:</b> 1,000,000 presses in 10 seconds is <b>100,000 increments a second on one key</b>. One key lives on one shard and one core, so that shard is full, and every other key on it slows down.</p>' +
          '<p><b>What I would change:</b> count in the application first. Each app server adds up the likes it receives and sends one INCRBY a second. With 50 servers that is <b>50 writes a second</b> instead of 100,000. The count on screen is up to a second behind, which nobody notices.</p>' +
          '<p><b>If one place is not enough:</b> split the counter into several keys on different shards, such as likes:{id}:0 to likes:{id}:15, and add them up when reading.</p>';
      }
    },
    'analytics-reporting': {
      inputs: [['events', 'Events per day, millions', 1, 5000, 1, 100, 'M'], ['bytes', 'Bytes per event, uncompressed', 50, 2000, 50, 200, ' B'],
        ['cols', 'Share of columns a typical query reads, percent', 5, 100, 5, 15, '%'], ['ratio', 'Compression ratio you expect', 1, 30, 1, 8, '×'], ['months', 'Months kept', 1, 60, 1, 24, '']],
      calc: function (v) {
        var day = v.events * 1e6 * v.bytes, stored = day * 30 * v.months / v.ratio, q30 = day * 30 * (v.cols / 100) / v.ratio;
        return { r: [[size(day), 'raw data per day', false],
          [size(stored), 'stored, compressed, for the whole period', stored > 50e12],
          [size(q30), 'read by one 30-day query in a column store', q30 > 100e9],
          [size(day * 30), 'read by the same query in a row store', true]],
          note: 'The column store reads only the columns the query names, compressed. In <a href="' + NB7 + '">Notebook 7</a> generated columns compressed 100 times or more; real events compress less, so the ratio is your assumption.' };
      },
      q: 'Someone points the revenue dashboard at the primary PostgreSQL instead of the column store, "just for now". What does one 30-day query cost there?',
      a: function (v) {
        var row = v.events * 1e6 * v.bytes * 30, col = row * (v.cols / 100) / v.ratio;
        return '<p><b>The arithmetic:</b> a row store reads whole rows, so a 30-day query reads about <b>' + size(row) + '</b>. The column store reads about <b>' + size(col) + '</b> for the same answer, ' + fmt(row / col) + ' times less. At about 1 GB a second, the primary spends <b>' + dur(row / 1e9) + '</b> on each refresh.</p>' +
          '<p><b>What happens:</b> the query pushes the hot pages of the application out of the cache, so checkout and login get slower while the dashboard loads. Ten people opening the dashboard at 9 a.m. is ten of these at once.</p>' +
          '<p><b>What I would change:</b> keep reporting on the column store and feed it from the primary with change data capture. If a quick report has to come from PostgreSQL, run it on a replica with a statement timeout.</p>';
      }
    }
  };

  function parseHash() {
    var h = location.hash, o = {};
    if (h.indexOf('#estimate?') !== 0) return null;
    h.slice(10).split('&').forEach(function (p) { var kv = p.split('='); if (kv[0]) o[decodeURIComponent(kv[0])] = parseFloat(kv[1]); });
    return o;
  }
  function mount(el) {
    var slug = el.getAttribute('data-slug'), D = S[slug];
    if (!D) return;
    var v = {}, from = parseHash();
    D.inputs.forEach(function (i) {
      var x = from && isFinite(from[i[0]]) ? from[i[0]] : i[5];
      v[i[0]] = Math.min(i[3], Math.max(i[2], x));
    });
    var q = D.q.replace(/\{(\w+)\}/g, function (_, k) { return fmt(v[k]); });
    el.innerHTML = '<div class="es-grid"><div class="es-in">' + D.inputs.map(function (i) {
      return '<label class="es-row"><span class="es-l"><span>' + i[1] + '</span><b data-k="' + i[0] + '"></b></span>' +
        '<input type="range" min="' + i[2] + '" max="' + i[3] + '" step="' + i[4] + '" value="' + v[i[0]] + '" data-k="' + i[0] + '" aria-label="' + i[1] + '"></label>';
    }).join('') + '<div class="es-share"><button type="button" class="labbtn es-copy">Copy a link to these numbers</button><button type="button" class="labbtn es-reset">Reset</button><span class="es-msg" aria-live="polite"></span></div></div>' +
      '<div class="es-out"><div class="es-res"></div><p class="es-note"></p></div></div>' +
      '<div class="es-turn"><div class="kicker">Your turn</div><p class="es-q">' + q + '</p><p class="es-hint">Write your answer down first, using the numbers above. Then open mine.</p>' +
      '<details class="es-ans"><summary>Show my answer</summary><div class="es-a"></div></details></div>';
    function shown(i) { return (i[6] === 'k' || i[6] === 'M' ? (v[i[0]] >= 1000 ? fmt(v[i[0]]) : f1(v[i[0]])) : f1(v[i[0]])) + i[6]; }
    var timer;
    function draw(push) {
      D.inputs.forEach(function (i) { el.querySelector('b[data-k="' + i[0] + '"]').textContent = shown(i); });
      var R = D.calc(v);
      el.querySelector('.es-res').innerHTML = R.r.map(function (r) {
        return '<div class="es-tile' + (r[2] ? ' warn' : '') + '"><div class="es-v">' + r[0] + '</div><div class="es-k">' + r[1] + '</div></div>';
      }).join('');
      el.querySelector('.es-note').innerHTML = R.note;
      el.querySelector('.es-a').innerHTML = D.a(v);
      el.querySelector('.es-q').textContent = D.q.replace(/\{(\w+)\}/g, function (_, k) { return fmt(v[k]); });
      if (push) {
        clearTimeout(timer);
        timer = setTimeout(function () {
          try { history.replaceState(null, '', '#estimate?' + D.inputs.map(function (i) { return i[0] + '=' + v[i[0]]; }).join('&')); } catch (e) {}
        }, 250);
      }
    }
    Array.prototype.forEach.call(el.querySelectorAll('input[type=range]'), function (r) {
      r.addEventListener('input', function () { v[r.getAttribute('data-k')] = parseFloat(r.value); draw(true); });
    });
    el.querySelector('.es-reset').addEventListener('click', function () {
      D.inputs.forEach(function (i) { v[i[0]] = i[5]; el.querySelector('input[data-k="' + i[0] + '"]').value = i[5]; });
      draw(false);
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    });
    el.querySelector('.es-copy').addEventListener('click', function () {
      var url = location.origin + location.pathname + '#estimate?' + D.inputs.map(function (i) { return i[0] + '=' + v[i[0]]; }).join('&');
      var msg = el.querySelector('.es-msg');
      function ok() { msg.textContent = 'Link copied.'; }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok, function () { msg.textContent = url; });
      else msg.textContent = url;
    });
    draw(false);
    if (from) { var sec = document.getElementById('estimate'); if (sec && sec.scrollIntoView) setTimeout(function () { sec.scrollIntoView(); }, 50); }
  }
  Array.prototype.forEach.call(document.querySelectorAll('.estimate'), mount);
})();
