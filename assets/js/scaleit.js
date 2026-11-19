/* Scale it: watch one design grow, stage by stage, and see what each event does to it.
   The numbers are a model, not a measurement. Markup: <div class="scaleit" data-slug="store-orders"></div> */
(function () {
  var D = {
    'agent-memory': {
      m: { lat: 'state and memory lookups before each model call, p95', write: 'can runs make progress?', dbname: 'PostgreSQL with pgvector', slow: 150 },
      stages: [
        { name: 'One PostgreSQL for everything', lat: 40, cpu: 35, share: 100, fail: 'paused',
          story: 'The run log, checkpoints and long-term memories all live in one PostgreSQL with pgvector. Each step writes a tool call and a checkpoint and runs one memory search. Nothing to keep in sync.',
          lesson: 'One database is enough for a long time. The model is the slow part, not the database.',
          x10: [null, 100], x10s: ['A batch job starts an agent run for every customer at once, ten times the usual load. Each run holds a connection while it waits for the model, so PostgreSQL runs out of connections long before it runs out of CPU.', 'Agents hit the connection limit first. Cap concurrent runs and put a pooler in front.'],
          failS: ['The primary fails. Every run stops at its current step. Because each step was checkpointed, the runs resume from that step after the promotion instead of starting over.', 'Checkpoints turn a failover into a pause, not lost work.'] },
        { name: 'Redis working memory and a pooler', lat: 25, cpu: 18, share: 60, hit: 90, front: 'PgBouncer: pools connections', cache: 'Redis: working memory of active runs', cacheWord: 'Working memory', cold: [45, 30], fail: 'paused',
          x10: [60, 70], x10s: ['Ten times the runs. The pooler queues them for a connection, so the primary stays busy but healthy. Memory search is now the largest cost per step.', 'Pooling turns a connection storm into a short queue.'],
          coldS: ['Redis restarts empty. The working memory of every active run is gone, so each run reloads from its last checkpoint and repeats a few seconds of work. Nothing is lost.', 'Keep anything you cannot lose in the checkpoint, not in Redis.'],
          failS: ['The PostgreSQL primary fails. Runs pause at their checkpoints. Their working memory is still in Redis, so they continue where they were once the standby is promoted.', 'The pause is the promotion time. Rehearse it.'],
          story: 'Working memory of active runs moves to Redis with an expiry, and PgBouncer sits in front of PostgreSQL. Hundreds of parallel runs now share a few dozen database connections.',
          lesson: 'Parallel agents look like a connection storm. Pool from the start.' },
        { name: 'Memories in their own store', lat: 20, cpu: 9, x10s: ['Ten times the runs. The pooler queues them, the memory index takes the searches, and the primary is left with small writes: tool calls and checkpoints.', 'Each part now grows on its own, and PostgreSQL is still the one place to delete from.'], share: 40, hit: 90, front: 'PgBouncer: pools connections', cache: 'Redis: working memory of active runs', cacheWord: 'Working memory', cold: [40, 18], fail: 'paused', extra: ['Memory index: partitions by tenant or a vector store, fed from PostgreSQL'],
          coldS: ['Redis restarts empty. Active runs reload from their checkpoints, and the memory index is untouched.', 'Each store can fail on its own without losing anything durable.'],
          failS: ['The PostgreSQL primary fails. Runs pause at their checkpoints. Memory search keeps answering from the memory index; new memories wait until the primary is back.', 'PostgreSQL stays the source of truth; the memory index can always be rebuilt from it.'],
          story: 'The memory index outgrew one machine\'s memory, so memories are partitioned by tenant, or their vectors move to a dedicated store fed from PostgreSQL. Deletes and permissions still start in PostgreSQL.',
          lesson: 'Move the index, not the source of truth.' }
      ],
      x10sat: '', x10ok: '', x10lessonSat: '', x10lessonOk: '',
      cold: '', coldLesson: ''
    },
    'store-orders': {
      m: { lat: 'checkout latency, 95th percentile', write: 'can customers check out?', dbname: 'PostgreSQL or MySQL' },
      stages: [
        { name: 'One primary', lat: 120, cpu: 35, share: 100, hit: null, fail: 'paused',
          story: 'Everything lives in one PostgreSQL or MySQL primary, with a standby in another zone. Every page view, cart click and checkout reads from it.',
          lesson: 'The simplest design that works. Most stores should stay here longer than they think.' },
        { name: 'Add a cache', lat: 70, cpu: 20, share: 30, hit: 85, cache: 'Redis: carts, product pages', cold: [120, 35], fail: 'paused',
          story: 'Carts and product reads move to Redis. The database now sees writes and cache misses, which is most of the win for a store.',
          lesson: 'Cache what is read often and changes rarely. Keep the cache rebuildable.' },
        { name: 'Add a read replica', lat: 65, cpu: 14, share: 20, hit: 85, cache: 'Redis: carts, product pages', replica: 'Read replica: reports and exports', cold: [120, 30], fail: 'paused',
          story: 'Reports and exports move to a read replica. A month-end report no longer pushes checkout pages out of the primary\'s cache.',
          lesson: 'Separate the hot path from the scans.' },
        { name: 'Shard by customer', lat: 60, cpu: 9, share: 20, hit: 85, cache: 'Redis: carts, product pages', replica: 'Read replica per shard', cold: [95, 16], fail: 'partly',
          shards: ['customers A to F', 'customers G to L', 'customers M to R', 'customers S to Z'],
          story: 'Orders are split by customer across four primaries. Each customer\'s orders stay on one shard, so their transactions stay local.',
          lesson: 'Shard last, and by the key your transactions share.' }
      ],
      x10sat: 'A sale sends ten times the traffic. The primary runs out of CPU, queues build, and requests time out.',
      x10ok: 'A sale sends ten times the traffic. Spread across shards, the load still fits, with room to spare.',
      x10lessonSat: 'Before a sale: queue in front of checkout, cache what you can, and know the primary\'s ceiling.',
      x10lessonOk: 'Sharding raised the ceiling, at the price of four primaries to run.',
      failPaused: 'The primary fails. Checkout writes pause until the standby is promoted.',
      failPartly: 'One shard\'s primary fails. Its standby is promoted. Only the customers on that shard wait; the other three quarters never notice.',
      failCache: ' Product pages keep working from the cache.', failNoCache: ' Every page that touches the database waits.'
    },
    'social-feed': {
      m: { lat: 'feed load time, 95th percentile', write: 'can people post?', dbname: 'PostgreSQL' },
      stages: [
        { name: 'Pull model', lat: 450, cpu: 45, share: 100, hit: null, fail: 'paused',
          story: 'Opening the app runs one query: the newest posts of everyone I follow, with an index on (author_id, created_at). No precomputation. It is fine until people follow hundreds of accounts.',
          lesson: 'Start with the query. A good index takes a pull model further than most people expect.' },
        { name: 'Timelines in Redis', lat: 45, cpu: 18, share: 5, hit: 95, cache: 'Redis: one sorted set per user', cold: [900, 90], fail: 'paused',
          story: 'Each new post is pushed into every follower\'s timeline in Redis (fan-out on write). Opening the app is one ZREVRANGE. The database now mostly takes the posts themselves.',
          lesson: 'Move the work from read time to write time when reads outnumber writes by a lot.' },
        { name: 'Pull for big accounts', lat: 50, cpu: 14, share: 6, hit: 95, cache: 'Redis: timelines, minus big accounts', cold: [800, 80], fail: 'paused',
          story: 'Accounts above a follower threshold are not fanned out. Their posts are merged in when a reader opens the feed. One celebrity post no longer means 20 million writes.',
          lesson: 'Most real feeds end up as a hybrid of push and pull.' },
        { name: 'Wide-column timelines', lat: 55, cpu: 7, share: 6, hit: 90, cache: 'Redis: only the hot timelines', cold: [140, 30], fail: 'ok',
          shards: ['node 1', 'node 2', 'node 3', 'node 4'], shardWord: 'Node',
          story: 'Timelines move to a wide-column store partitioned by user_id, three copies of each. Redis keeps only the timelines of people active right now, so memory stops growing with the user count.',
          lesson: 'When memory is the bill, keep the full data on disk and only the hot part in memory.' }
      ],
      x10sat: 'A big event sends ten times the traffic. The database or the fan-out workers run out of room, and feeds time out.',
      x10ok: 'A big event sends ten times the traffic. Spread across nodes, it still fits.',
      x10lessonSat: 'Know which part saturates first: the feed query, the fan-out queue or Redis memory.',
      x10lessonOk: 'More nodes raised the ceiling, at the price of a second kind of database to run.',
      cold: 'Redis restarts empty. Every feed open falls through to the database, which has to rebuild each timeline from posts. This is the cold start that hurts feeds most.',
      coldLesson: 'Rebuild timelines lazily, only for people who open the app, and rate limit the rebuilds.',
      failPaused: 'The primary fails. New posts pause until the standby is promoted.',
      failOk: 'One node fails. Each timeline has three copies, so reads and writes go to the other two. Nobody notices; the node catches up when it returns.',
      failCache: ' Feeds keep loading from Redis.', failNoCache: ' Every feed waits.'
    },
    'chat-messaging': {
      m: { lat: 'message delivery time, 95th percentile', write: 'can people send messages?', dbname: 'PostgreSQL' },
      stages: [
        { name: 'One relational database', lat: 900, cpu: 40, share: 100, hit: null, fail: 'paused',
          story: 'Messages, conversations and members all live in one database. Clients poll every few seconds for new messages, so delivery takes as long as the polling interval.',
          lesson: 'Get the key right first: (conversation_id, message_id), so one conversation\'s history is one range read.' },
        { name: 'Push over websockets', lat: 120, cpu: 20, share: 30, hit: 70, cache: 'Redis: presence and pub/sub', cold: [200, 30], fail: 'paused',
          story: 'Clients keep a websocket open. A new message is written once, then published through Redis to the servers holding the members\' connections. Polling stops, and so do most of the reads.',
          lesson: 'Deliver from memory, store once. The database is the history, not the delivery path.' },
        { name: 'Partition by month', lat: 110, cpu: 15, share: 30, hit: 70, cache: 'Redis: presence and pub/sub', replica: 'Read replica: search and export', cold: [190, 24], fail: 'paused',
          story: 'The messages table is partitioned by month. Vacuum and backups work on small pieces, and old months are archived by detaching a partition rather than deleting rows.',
          lesson: 'Plan for the table you will have in two years, not the one you have today.' },
        { name: 'Messages in a wide-column store', lat: 100, cpu: 7, share: 30, hit: 70, cache: 'Redis: presence and pub/sub', cold: [160, 14], fail: 'ok',
          shards: ['node 1', 'node 2', 'node 3', 'node 4'], shardWord: 'Node',
          story: 'Message history moves to a wide-column store partitioned by conversation and time bucket. Conversations, members and permissions stay relational, because they need constraints and joins.',
          lesson: 'Split by the shape of the data: append-heavy history in one store, relationships in another.' }
      ],
      x10sat: 'A big news moment sends ten times the messages. The primary runs out of room for inserts, and delivery falls behind.',
      x10ok: 'A big news moment sends ten times the messages. Spread across nodes, the inserts still fit.',
      x10lessonSat: 'Inserts are the ceiling here. Batch where you can and know the primary\'s commit rate.',
      x10lessonOk: 'More nodes raised the insert ceiling, at the price of a second database to run.',
      cold: 'Redis restarts. Presence and subscriptions are rebuilt as clients reconnect, and every client reconnecting at once loads its recent history from the database.',
      coldLesson: 'Reconnect with jitter, and load only what changed since the last message the client has.',
      failPaused: 'The primary fails. Sending pauses until the standby is promoted.',
      failOk: 'One node fails. Each message has three copies, so sending carries on. Conversations and members are still on the relational primary, which is the next thing to protect.',
      failCache: ' Online users still see presence and typing.', failNoCache: ' Every client waits.'
    }
    ,
    'payments-ledger': {
      m: { lat: 'payment latency, 95th percentile', write: 'can payments be taken?', dbname: 'PostgreSQL or MySQL', slow: 200 },
      nocache: ['There is no cache in this design, and that is on purpose. A balance is read from the database, inside the transaction that changes it.', 'Cache the things around a payment, such as merchant settings. Never the money.'],
      stages: [
        { name: 'One primary, synchronous standby', lat: 45, cpu: 30, share: 100, fail: 'paused', standby: 'Synchronous standby, another zone',
          story: 'One primary holds the ledger. Every commit waits until a standby in another zone has the WAL too, so a failover loses nothing that was acknowledged. Backups with point-in-time recovery, and a restore tested on a schedule.',
          lesson: 'A few milliseconds on every commit is the price of losing no payments. For money, pay it.',
          failS: ['The primary fails. Payments pause for the time promotion takes, usually under a minute. Because the standby was synchronous, every payment that was acknowledged is there.', 'Zero data loss and zero downtime are different promises. This stage makes the first one.'] },
        { name: 'Partition by month', lat: 42, cpu: 24, share: 100, fail: 'paused', standby: 'Synchronous standby, another zone', extra: ['Old months on cheaper storage, still queryable'],
          story: 'The ledger is partitioned by month. Current months stay on fast storage; old months move to cheaper storage but stay queryable. Vacuum, backups and index rebuilds work on one month at a time.',
          lesson: 'Partition by the column every query and every retention rule already uses: time.',
          failS: ['The primary fails. Payments pause until the synchronous standby is promoted. Partitioning did not change failover; it made the restore you rehearse faster.', 'Smaller pieces mean faster restores, which is the part of failover nobody measures until they need it.'] },
        { name: 'Shard by account', lat: 40, cpu: 8, share: 100, fail: 'partly', partly: '1 shard of 4 waits',
          shards: ['accounts 0 to 24%', 'accounts 25 to 49%', 'accounts 50 to 74%', 'accounts 75 to 100%'],
          story: 'Accounts are split across four primaries, each with a synchronous standby. A payment within one shard is one local transaction. A transfer between shards needs two steps with a pending state, which is the hardest part of this design.',
          lesson: 'Shard money last. The cross-shard transfer is a new protocol you have to get right forever.',
          failS: ['One shard\'s primary fails. Payments for accounts on that shard pause, and transfers into or out of it wait in their pending state. The other three shards carry on.', 'Pending states make cross-shard work survive a failover. Test that path, not only the happy one.'] }
      ],
      x10sat: 'A sale sends ten times the payments. The primary runs out of CPU, payments time out, customers press Pay again, and the retries make it worse.',
      x10ok: 'A sale sends ten times the payments. Spread across four shards, it fits.',
      x10lessonSat: 'Idempotency keys make retries safe. Move everything that is not the ledger write off the payment path.',
      x10lessonOk: 'Sharding raised the ceiling. The cost is the cross-shard protocol, every day.'
    },
    'booking-reservations': {
      m: { lat: 'booking latency, 95th percentile', write: 'can people book?', dbname: 'PostgreSQL or MySQL' },
      stages: [
        { name: 'One database', lat: 80, cpu: 25, share: 100, fail: 'paused',
          story: 'Bookings, holds and availability live in one database. A unique constraint on (event, seat) and short transactions do the work: two people can never hold the same seat.',
          lesson: 'Let the database enforce the rule. Constraints do not have bugs under load.' },
        { name: 'Waiting room and cached availability', lat: 90, cpu: 12, share: 10, hit: 90, front: 'Queue: waiting room', cache: 'Seat availability, refreshed every second', cold: [180, 70], fail: 'paused',
          x10: [95, 18], x10s: ['An on-sale sends ten times the traffic. The waiting room lets people through at the rate the database can take. The rest wait in line, not in the database.', 'Put the spike in a queue you control, not in the connection pool.'],
          story: 'A waiting room sits in front of the booking step, and the seat map comes from a cache refreshed every second. The seat map is allowed to be slightly wrong; the booking itself still checks the seat in the database.',
          lesson: 'Separate looking from booking. Only booking needs to be exactly right.' },
        { name: 'Shard by event or venue', lat: 80, cpu: 5, share: 10, hit: 90, front: 'Queue: waiting room', cache: 'Seat availability, refreshed every second', cold: [150, 30], fail: 'partly', partly: 'events on 1 shard of 4 wait',
          shards: ['venues A to F', 'venues G to L', 'venues M to R', 'venues S to Z'],
          story: 'Events are spread across four databases by venue. One hot on-sale stays on one shard, and every booking for an event is still a local transaction.',
          lesson: 'Shard by the thing a transaction never crosses. Nobody books seats at two venues in one transaction.' }
      ],
      x10sat: 'A big on-sale sends ten times the traffic straight at the database. Connections run out, and people who were about to pay see errors.',
      x10ok: 'A big on-sale sends ten times the traffic. The waiting room holds most of it and the shard takes the rest.',
      x10lessonSat: 'Do not size the database for the on-sale minute. Put a queue in front of it.',
      x10lessonOk: 'The queue does the work. The shard only has to be big enough for the rate the queue lets through.',
      cold: 'The availability cache restarts empty. Every seat-map refresh goes to the database at once, during the busiest minute of the year.',
      coldLesson: 'Rebuild the availability cache from one query per event, not one per visitor.',
      failPaused: 'The primary fails. Bookings pause until the standby is promoted. Holds keep their expiry time, so nobody loses a seat they are paying for.',
      failPartly: 'One shard\'s primary fails. Events on that shard pause; every other venue keeps selling.',
      failCache: ' People can still browse the seat map from the cache.', failNoCache: ' The whole site waits.'
    },
    'accounts-sessions': {
      m: { lat: 'page latency, 95th percentile', write: 'can people log in?', dbname: 'PostgreSQL or MySQL', slow: 150 },
      stages: [
        { name: 'Everything in one database', lat: 60, cpu: 45, share: 100, fail: 'paused',
          story: 'Accounts and sessions share one database. Every request reads the session row, and a scheduled job deletes expired ones. It works, and most of the primary\'s work is session lookups.',
          lesson: 'Fine at small scale. Watch what share of queries are session reads.',
          failS: ['The primary fails. Every request checks the session, so the whole site waits for the promotion, not just logins.', 'When everything depends on one table, the whole site has that table\'s availability.'] },
        { name: 'Sessions in Redis', lat: 15, cpu: 12, share: 5, hit: 98, cache: 'Redis: sessions with a TTL', cold: [600, 100], fail: 'paused',
          coldS: ['Redis restarts empty. Every logged-in user is logged out at once and comes back through the login page. Password hashing is built to be slow, so the login service saturates first.', 'Give Redis a replica and persistence, and use refresh tokens so most users get a new session without a password.'],
          failS: ['The primary fails. People already logged in keep working, because their session is in Redis. New logins and password changes wait for the promotion.', 'Moving sessions out made a database failover invisible to most users.'],
          story: 'Sessions move to Redis with an expiry, so each request is a key lookup in memory. Accounts, passwords and roles stay in the relational database.',
          lesson: 'Keep the hot, disposable data in memory and the durable data in the database.' },
        { name: 'Identity service, signed tokens', lat: 8, cpu: 6, share: 1, cache: 'Signed tokens, checked with a public key', cacheWord: 'No lookup', fail: 'paused', extra: ['Identity service: its own database'],
          coldS: ['There is nothing to go cold. Each service checks the token\'s signature itself. The hard part now is the opposite: ending a session early, before the token expires.', 'Short-lived tokens plus a small revocation list cover most of what server-side sessions gave you.'],
          failS: ['The identity database fails. Tokens already issued keep working until they expire, so most traffic carries on. New logins wait.', 'Signed tokens trade instant revocation for not needing the database on every request.'],
          story: 'A separate identity service owns accounts and issues short-lived signed tokens. Other services check the signature without calling it. Session state no longer touches a database at all.',
          lesson: 'Do this when many services need identity, not before.' }
      ],
      x10sat: 'A launch brings ten times the traffic. Session lookups alone fill the primary, and every page slows down.',
      x10ok: 'A launch brings ten times the traffic. Session checks are in memory, so the database barely notices.',
      x10lessonSat: 'The cheapest capacity win here is moving sessions out of the primary.',
      x10lessonOk: 'The database now only scales with logins and account changes, which grow far slower than requests.',
      failNoCache: '', failCache: ''
    },
    'multi-tenant-saas': {
      m: { lat: 'page latency, average tenant, 95th percentile', write: 'can tenants work?', dbname: 'PostgreSQL or MySQL' },
      nocache: ['This model leaves the cache out, because the interesting failures in multi-tenant systems are about one tenant affecting the others.', 'Caches help here too. Key every entry by tenant_id so one tenant\'s data never leaks into another\'s.'],
      stages: [
        { name: 'Shared schema', lat: 80, cpu: 40, share: 100, fail: 'paused',
          story: 'Every tenant shares the same tables, with tenant_id first in every key and row-level security as a backstop. One database, one migration, cheapest to run.',
          lesson: 'Fine for thousands of small tenants. Watch the biggest one.',
          x10s: ['Your largest tenant runs an import that sends ten times the usual load. It uses the whole primary, and every other tenant slows down with it.', 'In a shared schema, a noisy tenant is everyone\'s problem. Per-tenant rate limits help before you move anyone.'],
          failS: ['The primary fails. Every tenant waits for the promotion, all at the same moment, and all their support tickets arrive together.', 'One database means one blast radius: all of them.'] },
        { name: 'Big tenants on their own', lat: 60, cpu: 20, share: 100, fail: 'partly', partly: 'tenants on 1 of 4 wait', shardWord: 'Database',
          shards: ['shared: small tenants', 'tenant: Acme', 'tenant: Globex', 'tenant: Initech'], extra: ['Catalog: which tenant lives where'],
          x10s: ['Acme runs its import at ten times the usual load. Its own database is busy; nobody else notices.', 'Isolating the largest tenants is the cheapest way to stop noisy neighbours.'],
          x10: [60, 20],
          story: 'The few tenants that dominate move to their own databases, with the same schema. A small catalog table says which database each tenant lives on, and the application routes by it.',
          lesson: 'Isolate the few who need it, without paying for a database per tenant.' },
        { name: 'Shard by tenant', lat: 55, cpu: 9, share: 100, fail: 'partly', partly: 'tenants on 1 of 4 wait', shardWord: 'Shard',
          shards: ['tenant hash 0 to 24%', 'tenant hash 25 to 49%', 'tenant hash 50 to 74%', 'tenant hash 75 to 100%'], extra: ['Catalog: which tenant lives where'],
          story: 'Every tenant is placed on one of several databases by tenant_id. Citus does this for PostgreSQL and Vitess for MySQL. Moving a tenant is a copy plus a catalog update.',
          lesson: 'Shard by the key that every query already filters on.' }
      ],
      x10sat: 'Traffic grows ten times across all tenants. The shared primary saturates, and every tenant slows down together.',
      x10ok: 'Traffic grows ten times across all tenants. Spread across shards, it fits.',
      x10lessonSat: 'Know your largest tenants and how close they are to the primary\'s ceiling.',
      x10lessonOk: 'The catalog lets you rebalance: move the busiest tenants to the emptiest shard.',
      failPartly: 'One database fails. Only the tenants on it wait for its standby; the rest never notice.',
      failPaused: '', failCache: '', failNoCache: ''
    },
    'product-catalog': {
      m: { lat: 'product page latency, 95th percentile', write: 'can the team edit products?', dbname: 'PostgreSQL or MongoDB' },
      stages: [
        { name: 'One database', lat: 160, cpu: 50, share: 100, fail: 'paused',
          story: 'Products, categories and attributes live in one database. Filters are SQL with indexes. It is fine for a few thousand products, and gets slow when people want facets and full-text search on every page.',
          lesson: 'Start here. Add a search engine when the facet queries, not the product reads, are the slow part.',
          failS: ['The primary fails. Product pages, search and edits all wait for the promotion.', 'Everything in one place means one thing to fail.'] },
        { name: 'Add a search engine', lat: 70, cpu: 22, share: 40, fail: 'paused', extra: ['Search engine: facets and text, fed by CDC'],
          story: 'Search and filtering move to a search engine fed by change data capture or an outbox table. The database stays the source of truth; the search index is a copy that can be rebuilt.',
          lesson: 'Every copy needs a way to be rebuilt from the source. Test the rebuild.',
          failS: ['The primary fails. Search keeps answering from the search engine, a few seconds behind. Product pages that read the database and all edits wait.', 'A rebuildable copy is also a degraded mode.'] },
        { name: 'Cache pages at the edge', lat: 25, cpu: 6, share: 4, hit: 95, cache: 'CDN: product pages at the edge', cold: [220, 75], fail: 'paused', extra: ['Search engine: facets and text, fed by CDC'],
          story: 'Product pages are cached at the edge, close to shoppers everywhere. The database now sees mostly edits and cache misses. A price change purges the pages it affects.',
          lesson: 'For read-heavy pages, the fastest database query is the one that never reaches the database.',
          failS: ['The primary fails. Shoppers keep browsing from the edge cache and search keeps working. Only the catalog team notices: edits wait for the promotion.', 'With a cache in front, a database failover becomes an internal event.'] }
      ],
      x10sat: 'A holiday campaign sends ten times the traffic. The facet queries fill the primary first, and product pages slow down with them.',
      x10ok: 'A holiday campaign sends ten times the traffic. The edge cache takes almost all of it.',
      x10lessonSat: 'Find the most expensive query on the page, not the most frequent one.',
      x10lessonOk: 'Most of the extra traffic never reached your database.',
      cold: 'The edge cache is purged, by a deploy or a bulk price change. Every product page request goes to the database at once.',
      coldLesson: 'Purge by product, not everything, and stagger bulk changes so the cache refills gradually.'
    },
    'search-ai-retrieval': {
      m: { lat: 'search latency, 95th percentile', write: 'can new documents be indexed?', dbname: 'PostgreSQL with pgvector', share: 'of searches reaching the main database' },
      nocache: ['Search results are rarely worth caching, because almost every question is different. The index itself is what has to stay in memory.', 'Watch whether the vector index still fits in memory. That, not a cache, decides the latency.'],
      stages: [
        { name: 'PostgreSQL full-text and pgvector', lat: 80, cpu: 40, share: 100, fail: 'paused',
          story: 'Documents, permissions, full-text search and vectors all live in PostgreSQL. A search can filter by permission and rank in one query, and there is nothing to keep in sync.',
          lesson: 'One database, no sync problem. Stay here while the vector index fits in memory.',
          failS: ['The primary fails. Search and indexing both wait for the promotion. A replica could keep answering searches in the meantime.', 'Searching a replica is a cheap way to make search survive a failover.'] },
        { name: 'A separate vector or search store', lat: 40, cpu: 12, share: 10, fail: 'paused', extra: ['Vector or search store, fed by an outbox'],
          story: 'Once the index outgrows memory or ranking gets complex, searches move to a vector or search store fed by the same outbox pattern as any other copy. Documents and permissions stay in PostgreSQL.',
          lesson: 'Move the index, not the source of truth. Permissions are the part that must never drift.',
          failS: ['PostgreSQL fails. Searches keep answering from the vector store. New documents wait in the outbox until the primary is back.', 'The outbox means nothing is lost, only delayed.'] },
        { name: 'A shared search platform', lat: 45, cpu: 6, share: 2, fail: 'ok', shardWord: 'Search node', downIdx: 1, failGood: true,
          shards: ['replicated', 'replicated', 'replicated', 'replicated'], front: 'Ingestion pipeline: many sources',
          story: 'Many teams and sources feed one search platform through its own ingestion pipeline. Each index is split across nodes, with a replica of each piece.',
          lesson: 'Build a platform when several teams would otherwise build the same pipeline.',
          failS: ['One search node fails. The replicas of its pieces answer instead, and the cluster copies them again in the background. Searches carry on.', 'Replicated pieces make a node failure a background task.'] }
      ],
      x10sat: 'A new feature sends ten times the searches. Vector search is CPU-heavy, and it competes with every other query on the primary.',
      x10ok: 'Ten times the searches. Spread across nodes, it fits.',
      x10lessonSat: 'Vector search and transactions want different machines. That is the usual reason to split them.',
      x10lessonOk: 'Search capacity now grows by adding nodes, without touching the main database.',
      failOk: ''
    },
    'iot-telemetry': {
      m: { lat: 'delay before a reading is stored', write: 'are readings being stored?', share: 'of readings written to the database', dbname: 'PostgreSQL, partitioned by day', slow: 2000 },
      nocache: ['There is no cache in this design. Telemetry is written far more than it is read, and the reads are mostly recent ranges.', 'Make recent data fast with partitions and rollups, not with a cache.'],
      stages: [
        { name: 'PostgreSQL with time partitions', lat: 200, cpu: 45, share: 100, fail: 'paused',
          story: 'Readings go into a PostgreSQL table partitioned by day. Dropping a day is dropping a partition. It works well for a modest number of devices.',
          lesson: 'Partition by time from day one. Retrofitting it later is a migration.',
          x10s: ['A firmware bug makes every device report ten times as often. Inserts saturate the primary, and devices retry, so the load grows further.', 'Ingest needs a buffer between the devices and the database.'],
          failS: ['The primary fails. Readings arriving during the promotion are lost, unless the devices buffer and resend.', 'Decide early whether a lost minute of telemetry matters. It decides whether you need a queue.'] },
        { name: 'A column store with rollups', lat: 120, cpu: 18, share: 100, fail: 'paused', db: 'ClickHouse or a time-series extension', extra: ['Rollups: one row per device per minute'],
          story: 'Readings move to a column store or a time-series extension, compressed by column, with one-minute rollups built as data arrives. Storage shrinks and dashboards read the rollups.',
          lesson: 'Store raw data for days and rollups for years.',
          x10s: ['A firmware bug sends ten times the readings. Batched inserts keep up for a while, then merges fall behind and ingest slows.', 'Batch size matters more than node size for ingest.'],
          x10: [900, 140],
          failS: ['The database fails. Readings arriving in the meantime are lost, unless something holds them.', 'A faster database does not solve the failover gap. A buffer does.'] },
        { name: 'A queue in front', lat: 300, cpu: 15, share: 100, fail: 'yes, queued', front: 'Queue: absorbs bursts', db: 'ClickHouse or a time-series extension', extra: ['Rollups: one row per device per minute', 'Ingest workers write batches'], failGood: true,
          x10: [180000, 30], x10s: ['A firmware bug sends ten times the readings. The queue grows, ingest falls a few minutes behind, and nothing is lost. Workers catch up when the burst ends.', 'A queue turns a spike into a delay. For telemetry, a delay is almost always fine.'],
          failS: ['The database fails. Readings wait in the queue and are written when it is back. Dashboards are a few minutes stale; no data is lost.', 'With a queue in front, the database\'s failover time becomes a delay, not data loss.'],
          story: 'Devices write to a queue. Several ingest workers read from it and write batches of thousands of rows to the database. The queue absorbs bursts and outages alike.',
          lesson: 'For high write rates, the database should see a few large batches, not many single rows.' }
      ],
      x10sat: '', x10ok: '', x10lessonSat: '', x10lessonOk: ''
    },
    'audit-event-log': {
      m: { lat: 'added latency per action', write: 'are actions being recorded?', dbname: 'the main database', slow: 50 },
      nocache: ['There is no cache in this design. An audit log is written on every action and almost never read.', 'Design for the rare read instead: one customer\'s history, fast.'],
      stages: [
        { name: 'A table in the main database', lat: 3, cpu: 25, share: 100, fail: 'paused',
          story: 'Each action writes its audit row in the same transaction as the action itself. If the action commits, the audit row exists. Nothing to keep in sync.',
          lesson: 'Same transaction is the strongest guarantee an audit log can have. Start with it.',
          failS: ['The primary fails. Actions pause, and so does auditing, together. Nothing is recorded that did not happen, and nothing that happened goes unrecorded.', 'The audit log has exactly the database\'s availability, which is usually what you want.'] },
        { name: 'Monthly partitions, old ones exported', lat: 3, cpu: 18, share: 100, fail: 'paused', extra: ['Object storage: old months, exported'],
          story: 'The audit table is partitioned by month. Old months are exported to object storage and detached, so the table stops dominating storage and backups.',
          lesson: 'Retention is a partition drop, not a DELETE.',
          failS: ['The primary fails. Actions and auditing pause together. The exported months in object storage stay readable throughout.', 'Old history in object storage survives database incidents.'] },
        { name: 'A shared event stream', lat: 2, cpu: 8, share: 100, fail: 'yes, queued', failGood: true, extra: ['Event stream: the audit store is one consumer', 'Audit store'],
          story: 'Services write events to an outbox table in their own transaction, and a relay publishes them to a shared stream. The audit store is one consumer among several.',
          lesson: 'The outbox keeps the same-transaction guarantee while the audit store moves out.',
          failS: ['The audit store fails. Events wait in the stream and are written when it returns. The services themselves carry on.', 'Decoupled through a stream, the audit store can be down without stopping the business.'] }
      ],
      x10sat: 'Activity grows ten times. Audit inserts and index updates compete with the actions themselves, and the primary saturates.',
      x10ok: 'Activity grows ten times. The audit writes are a small part of the load.',
      x10lessonSat: 'Keep audit rows narrow and indexes few. Most of the cost is the indexes.',
      x10lessonOk: 'The stream absorbs bursts; the audit store writes in batches.'
    },
    'leaderboards-counters': {
      m: { lat: 'score update latency, 95th percentile', write: 'are scores being counted?', dbname: 'PostgreSQL or MySQL', slow: 50 },
      stages: [
        { name: 'Counters in the database', lat: 30, cpu: 40, share: 100, fail: 'paused',
          story: 'Scores and counters are rows in the database, updated with UPDATE ... SET score = score + 1. Fine at low rates.',
          lesson: 'Correct and simple. The limit is hot rows, not the database.',
          x10s: ['A tournament sends ten times the updates, and most of them hit the top players\' rows. Each update waits for the row lock, and the queue grows.', 'One row takes one update at a time. That ceiling does not move with a bigger machine.'],
          x10: [null, 100] },
        { name: 'Count in Redis, flush every minute', lat: 2, cpu: 5, share: 2, hit: 99, cache: 'Redis: counters and sorted sets', cacheWord: 'In memory', cold: [40, 60], fail: 'ok',
          coldS: ['Redis restarts. Scores since the last flush, up to a minute, are gone unless Redis persisted them. The board is rebuilt from the database.', 'Decide how much counting you can lose. It decides whether Redis needs persistence or a durable variant.'],
          failS: ['The database primary fails. Scores keep counting in Redis. The minute flush waits and catches up after the promotion.', 'With counting in memory, the database failover is invisible to players.'],
          story: 'Counting moves to Redis: INCR for counters, ZINCRBY for leaderboards. A job writes the totals to the database every minute, so the database sees one write per counter per minute.',
          lesson: 'Count in memory, persist in batches.' },
        { name: 'Shard by season or region', lat: 2, cpu: 2, share: 2, hit: 99, cache: 'Redis: counters and sorted sets', cacheWord: 'In memory', cold: [30, 20], fail: 'partly', partly: '1 region of 4 waits a moment', shardWord: 'Redis shard',
          shards: ['season 12, Americas', 'season 12, Europe', 'season 12, Asia', 'season 12, Oceania'],
          coldS: ['One shard restarts empty. Only that region\'s board is rebuilt; the others are untouched.', 'Smaller pieces rebuild faster.'],
          failS: ['One Redis shard fails and its replica takes over. That region may lose the last second of scores; the other three never notice.', 'Shard by something players already understand, such as season and region.'],
          story: 'Each season and region gets its own sorted set on its own shard. A global top 100 is kept in one small key, built from the top of each region.',
          lesson: 'One sorted set lives on one core. Split it before it needs more.' }
      ],
      x10sat: 'Ten times the score updates. The database cannot keep up with the hot rows.',
      x10ok: 'Ten times the score updates. Redis handles it comfortably.',
      x10lessonSat: 'Move counting off the hot rows.',
      x10lessonOk: 'In memory, an increment costs microseconds.',
      cold: '', coldLesson: '',
      failPaused: 'The primary fails. Counting pauses until the standby is promoted.', failCache: '', failNoCache: ''
    },
    'analytics-reporting': {
      failEv: 'The reporting database fails',
      m: { lat: 'dashboard query time, 95th percentile', write: 'is the application unaffected?', dbname: 'PostgreSQL read replica', cpu: 'reporting database CPU', share: 'of reports reading the application database', slow: 10000 },
      nocache: ['This model leaves out the result cache. Dashboards usually cache query results for a few minutes, which hides slow queries until the cache expires at 9 a.m.', 'Make the query fast first. Then cache it.'],
      stages: [
        { name: 'A read replica for reports', lat: 40000, cpu: 60, share: 100, fail: 'ok', failGood: true, standby: 'The application primary', keepStandby: true, dbWord: 'Reporting database',
          story: 'Reports run on a read replica of the application database. Simple, and fine for small data. Long reports can conflict with replay on a PostgreSQL standby and get cancelled.',
          lesson: 'A replica keeps reports off the primary. It does not make a row store good at scans.',
          x10s: ['Ten people open the dashboard at 9 a.m. The replica\'s CPU and disk fill, replay falls behind, and every report times out.', 'Row stores read whole rows. Ten scans at once is ten times the whole table.'],
          x10: [null, 100],
          failS: ['The replica fails. Reports stop, but the application is untouched, because it never depended on the replica.', 'This is the one thing a reporting replica does well: it fails alone.'] },
        { name: 'A column store fed by CDC', lat: 800, cpu: 12, x10: [2400, 55], share: 0, fail: 'ok', failGood: true, db: 'ClickHouse or similar, fed by CDC', standby: 'Replica of the column store', keepStandby: true, dbWord: 'Reporting database',
          story: 'Change data capture copies every change into a column store, a few seconds behind. Reports read only the columns they need, compressed. The application database no longer runs reports at all.',
          lesson: 'Reports and transactions want different storage. Give them different databases.',
          failS: ['The column store fails. Dashboards stop and CDC pauses, keeping its position. When it returns, CDC catches up. The application never noticed.', 'CDC with a saved position makes the reporting side safe to lose.'] },
        { name: 'A warehouse with a modelling layer', lat: 1500, cpu: 8, share: 0, fail: 'ok', failGood: true, db: 'Warehouse or lakehouse', standby: 'Managed by the warehouse', keepStandby: true, dbWord: 'Reporting database', extra: ['Modelling layer: tested definitions of revenue, users and so on'], front: 'Loaders: many sources',
          story: 'Many sources load into a warehouse or lakehouse. A modelling layer defines revenue, active users and the rest once, with tests, and dashboards sit on top.',
          lesson: 'At this stage the hard problem is agreeing what the numbers mean, not computing them.',
          failS: ['The warehouse has an outage. Dashboards are stale until it returns; loads resume from where they stopped. The applications are unaffected.', 'Analytics should never be on the critical path of the product.'] }
      ],
      x10sat: '', x10ok: 'Ten times the dashboard queries. The column store reads only what each query needs, and keeps up.',
      x10lessonSat: '', x10lessonOk: 'Scans of compressed columns scale with the columns read, not the table size.'
    }

  };
  var EV = [['normal', 'A normal day'], ['x10', 'Traffic ×10'], ['cold', 'The cache goes cold'], ['fail', 'The primary fails']];
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ms(n) { return n >= 1000 ? '~' + (Math.round(n / 100) / 10) + ' s' : '~' + n + ' ms'; }
  var ARROW = '<span class="fi-arrow" aria-hidden="true">→</span>';

  function mount(el) {
    var S = D[el.getAttribute('data-slug')]; if (!S) return;
    var anyCache = S.stages.some(function (s) { return s.cache; });
    var st = { i: 0, ev: 'normal' };
    function draw() {
      var g = S.stages[st.i], ev = st.ev;
      var lat = g.lat, cpu = g.cpu, share = g.share, hit = g.hit, write = 'yes', story, lesson;
      if (ev === 'x10') {
        if (g.x10) { lat = g.x10[0]; cpu = g.x10[1]; } else { cpu = g.cpu * 10; lat = cpu >= 100 ? null : Math.round(g.lat * 3); }
      }
      if (ev === 'cold' && g.cache && g.cold) { hit = 0; share = 100; lat = g.cold[0]; cpu = g.cold[1]; }
      if (ev === 'fail') write = g.fail === 'ok' ? 'yes' : g.fail;
      var sat = cpu >= 100, cpuShown = Math.min(cpu, 100);
      if (ev === 'normal') { story = g.story; lesson = g.lesson; }
      else if (ev === 'x10') {
        if (g.x10s) { story = g.x10s[0]; lesson = g.x10s[1]; }
        else { story = sat ? S.x10sat : S.x10ok; lesson = sat ? S.x10lessonSat : S.x10lessonOk; }
      } else if (ev === 'cold') {
        if (g.coldS) { story = g.coldS[0]; lesson = g.coldS[1]; }
        else if (!g.cache) {
          if (!anyCache && S.nocache) { story = S.nocache[0]; lesson = S.nocache[1]; }
          else { story = 'There is no cache yet, so there is nothing to go cold.'; lesson = 'Try this on a later stage.'; }
        } else { story = S.cold || 'The cache restarts empty. Every read falls through to the database at once. The design is only safe if the database can take that.'; lesson = S.coldLesson || 'Warm the cache before taking traffic, or size the database for a cold start.'; }
      } else if (g.failS) { story = g.failS[0]; lesson = g.failS[1]; }
      else {
        story = g.fail === 'ok' ? S.failOk : (g.fail === 'partly' ? S.failPartly : S.failPaused + (g.cache ? S.failCache : S.failNoCache));
        lesson = g.fail === 'paused' ? 'Failover time is part of the design. Rehearse it.' : 'Spreading the data shrank what one failure can reach.';
      }
      var EVS = EV.map(function (e) { return e[0] === 'fail' && S.failEv ? [e[0], S.failEv] : e; });
      var evName = EVS.filter(function (e) { return e[0] === ev; })[0][1];
      var h = '<div class="sc-ctl"><span class="sc-lab">Stage</span>' + S.stages.map(function (s, k) {
        return '<button type="button" class="labbtn sc-st' + (k === st.i ? ' on' : '') + '" data-i="' + k + '" aria-pressed="' + (k === st.i) + '">' + (k + 1) + ' · ' + esc(s.name) + '</button>';
      }).join('') + '</div><div class="sc-ctl"><span class="sc-lab">Then</span>' + EVS.map(function (e) {
        return '<button type="button" class="labbtn sc-ev' + (e[0] === ev ? ' on' : '') + '" data-e="' + e[0] + '" aria-pressed="' + (e[0] === ev) + '">' + e[1] + '</button>';
      }).join('') + '</div>';
      var hot = sat ? ' hot' : '', down = ev === 'fail';
      h += '<div class="sc-map"><div class="sc-box sc-traffic' + (ev === 'x10' ? ' hot' : '') + '"><span class="fk">Traffic</span><b>' + (ev === 'x10' ? '×10' : 'normal') + '</b></div>' + ARROW;
      if (g.front) h += '<div class="sc-box sc-front' + (ev === 'x10' ? ' busy' : '') + '"><span class="fk">In front</span><b>' + esc(g.front) + '</b></div>' + ARROW;
      h += '<div class="sc-box"><span class="fk">App servers</span><b>stateless</b></div>' + ARROW;
      if (g.cache) h += '<div class="sc-box sc-cache' + (ev === 'cold' && g.cold ? ' cold' : '') + '"><span class="fk">' + esc(g.cacheWord || 'Cache') + '</span><b>' + esc(g.cache) + '</b>' + (hit === null || hit === undefined ? '' : '<span class="fn">hit rate ' + hit + '%</span>') + '</div>' + ARROW;
      h += '<div class="sc-db">';
      var dnIdx = g.downIdx === undefined ? 1 : g.downIdx;
      if (g.shards) {
        h += '<div class="sc-shards">' + g.shards.map(function (n, k) {
          var d = down && g.fail !== 'yes' && k === dnIdx;
          return '<div class="sc-box sc-pri' + (d ? ' down' : hot) + '"><span class="fk">' + esc(g.shardWord || 'Shard') + ' ' + (k + 1) + (d ? ' · down' : '') + '</span><span class="fn">' + esc(n) + '</span></div>';
        }).join('') + '</div>';
      } else {
        h += '<div class="sc-box sc-pri' + (down ? ' down' : hot) + '"><span class="fk">' + (down ? (g.dbWord || 'Primary') + ' · failed' : (g.dbWord || 'Primary')) + '</span><b>' + esc(g.db || S.m.dbname) + '</b></div>';
        h += '<div class="sc-box sc-sb' + (down && !g.keepStandby ? ' promoted' : '') + '"><span class="fk">' + (down && !g.keepStandby ? 'Standby · being promoted' : (g.standby || 'Standby, another zone')) + '</span></div>';
      }
      (g.replica ? [g.replica] : []).concat(g.extra || []).forEach(function (x) { h += '<div class="sc-box sc-rep"><span class="fk">' + esc(x) + '</span></div>'; });
      var cpuLab = g.cpuLabel || (g.shards ? 'CPU per ' + (g.shardWord || 'shard').toLowerCase() : (S.m.cpu || 'primary CPU'));
      h += '<div class="sc-cpu"><span>' + esc(cpuLab.charAt(0).toUpperCase() + cpuLab.slice(1)) + '</span><div class="sc-bar"><i style="width:' + cpuShown + '%"' + (sat || cpu >= 70 ? ' class="hot"' : '') + '></i></div><b>' + (sat ? '100%, saturated' : cpu + '%') + '</b></div>';
      h += '</div></div>';
      var wtxt = write === 'yes' ? 'yes' : (write === 'partly' ? (g.partly || '1 shard of 4 waits') : (write === 'paused' ? 'paused' : write));
      var mt = [
        [lat === null ? 'timeouts' : ms(lat), S.m.lat, lat === null || lat > (S.m.slow || 300)],
        [(sat ? 100 : cpu) + '%', cpuLab, sat || cpu >= 70],
        [share + '%', S.m.share || 'of reads reaching the database', share >= 100 && !!g.cache && !!g.cold],
        [wtxt, S.m.write, write !== 'yes' && !g.failGood]
      ];
      h += '<div class="sc-met">' + mt.map(function (m) { return '<div class="es-tile' + (m[2] ? ' warn' : '') + '"><div class="es-v">' + esc(m[0]) + '</div><div class="es-k">' + esc(m[1]) + '</div></div>'; }).join('') + '</div>';
      h += '<div class="sc-story" aria-live="polite"><div class="kicker">' + (st.i + 1) + ' · ' + esc(g.name) + (ev === 'normal' ? '' : ' · ' + evName.toLowerCase()) + '</div><p>' + esc(story) + '</p><p class="sc-lesson"><b>The lesson:</b> ' + esc(lesson) + '</p></div>';
      el.innerHTML = h;
      Array.prototype.forEach.call(el.querySelectorAll('.sc-st'), function (b) { b.addEventListener('click', function () { st.i = +b.getAttribute('data-i'); draw(); el.querySelector('.sc-st[data-i="' + st.i + '"]').focus(); }); });
      Array.prototype.forEach.call(el.querySelectorAll('.sc-ev'), function (b) { b.addEventListener('click', function () { st.ev = b.getAttribute('data-e'); draw(); el.querySelector('.sc-ev[data-e="' + st.ev + '"]').focus(); }); });
    }
    draw();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.scaleit'), mount);
})();
