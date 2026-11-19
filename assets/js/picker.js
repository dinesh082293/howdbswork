/* "Where should this data go?" A small rule set, not an oracle: it encodes the
   placement rules from the Designs pages and links to the matching design docs. */
(function () {
  var go = document.getElementById('pickGo'), out = document.getElementById('pickOut');
  if (!go || !out) return;
  var NAMES = {
    'store-orders': 'Online store: orders and inventory', 'payments-ledger': 'Payments and ledgers',
    'booking-reservations': 'Bookings and reservations', 'accounts-sessions': 'User accounts, logins and sessions',
    'multi-tenant-saas': 'Multi-tenant SaaS', 'product-catalog': 'Product catalog with varied attributes',
    'social-feed': 'Social feed and timelines', 'search-ai-retrieval': 'Search and AI retrieval',
    'chat-messaging': 'Chat and messaging', 'iot-telemetry': 'IoT, metrics and telemetry',
    'audit-event-log': 'Audit logs and event history', 'leaderboards-counters': 'Leaderboards, counters and rate limits',
    'analytics-reporting': 'Analytics, dashboards and reporting', 'agent-memory': 'Agent memory and state'
  };
  function val(n) { var e = document.querySelector('input[name="' + n + '"]:checked'); return e ? e.value : null; }
  function esc(s) { return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  go.addEventListener('click', function () {
    var job = val('job'), loss = val('loss'), rate = val('rate'), growth = val('growth');
    if (!job || !loss || !rate || !growth) { out.innerHTML = '<p class="labnote">Answer all four questions first.</p>'; return; }
    var store, why, read = [], notes = [];
    if (job === 'tx') {
      store = 'A relational database: PostgreSQL or MySQL';
      why = 'Transactions across several tables, and constraints that the database enforces whatever the application does.';
      read = loss === 'money' ? ['payments-ledger', 'booking-reservations', 'store-orders'] : ['store-orders', 'accounts-sessions', 'multi-tenant-saas'];
      if (loss === 'money') notes.push('Use synchronous replication for this database, so a failover cannot lose an acknowledged write.');
      if (rate === 'high') notes.push('At tens of thousands of writes per second, plan to shard by the key your transactions share (customer, account, tenant), or look at distributed SQL and measure its commit latency first.');
    } else if (job === 'serve') {
      store = 'A relational or document database as the record, with a cache, and a search engine for browsing';
      why = 'Reads outnumber writes by a wide margin, so most reads should never reach the database of record.';
      read = ['product-catalog', 'social-feed', 'search-ai-retrieval'];
      if (rate !== 'low') notes.push('If writes fan out to many readers (a feed), precompute per reader in Redis or a wide-column store.');
    } else if (job === 'stream') {
      if (loss === 'money') {
        store = 'An append-only, time-partitioned table in the same database as the action it records';
        why = 'The record must commit together with the action, so it cannot live in a separate system written afterwards.';
        read = ['audit-event-log', 'payments-ledger'];
      } else if (rate === 'low') {
        store = 'PostgreSQL or MySQL, with time partitions';
        why = 'At this rate one relational database takes the inserts, and time partitions make retention a matter of dropping old partitions.';
        read = ['chat-messaging', 'audit-event-log', 'iot-telemetry'];
      } else {
        store = 'A time-series or column store (TimescaleDB, ClickHouse), or a wide-column store (Cassandra, ScyllaDB) for per-conversation history';
        why = 'Heavy, time-ordered inserts suit stores built on append-friendly layouts, with compression and whole-partition retention.';
        read = ['iot-telemetry', 'chat-messaging', 'audit-event-log'];
      }
      notes.push('Insert in batches. The cost of one commit per row caps the rate long before the disk does.');
    } else if (job === 'history') {
      store = 'A column store (ClickHouse, BigQuery, Redshift, Snowflake, or DuckDB for small data), fed by change data capture';
      why = 'Reports read a few columns of many rows. A column store reads only those columns, and keeps the scans off the production primary.';
      read = ['analytics-reporting'];
    } else if (job === 'find') {
      store = 'PostgreSQL full-text search and pgvector to start, then a search engine or vector database';
      why = 'Keeping search next to the data avoids a second system to sync until size or ranking needs force it.';
      read = ['search-ai-retrieval', 'agent-memory', 'product-catalog'];
    } else {
      store = 'Redis or Valkey';
      why = 'Atomic increments, sorted sets and expiry, in memory, at very high operation rates.';
      read = ['leaderboards-counters', 'accounts-sessions'];
      if (loss === 'money') notes.push('Redis should not be the only copy of anything that costs money if lost. Keep the record in the database and use Redis as a fast copy, or for holds.');
    }
    if (growth === 'forever') notes.push('Decide retention now: partition by time, keep recent data online, and move old partitions to cheaper storage.');
    if (loss === 'none' && job !== 'state') notes.push('Since a lost write costs little, a faster commit setting is an option. Measure the gain first: see Notebook 2.');
    var h = '<div class="verdict"><b class="dt">Suggested store</b>' + esc(store) + '<br><span style="font-size:14.5px">' + esc(why) + '</span></div>';
    if (notes.length) h += '<ul>' + notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    h += '<p class="labnote" style="margin-top:10px"><b>Read next:</b> ' + read.map(function (s) { return '<a href="' + s + '/index.html">' + esc(NAMES[s]) + '</a>'; }).join(' · ') + '</p>';
    out.innerHTML = h;
  });
})();
