/* Scale it: watch one design grow, stage by stage, and see what each event does to it.
   The numbers are a model, not a measurement. Markup: <div class="scaleit" data-slug="store-orders"></div> */
(function () {
  var D = {
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
  };
  var EV = [['normal', 'A normal day'], ['x10', 'Traffic ×10'], ['cold', 'The cache goes cold'], ['fail', 'The primary fails']];
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function mount(el) {
    var S = D[el.getAttribute('data-slug')]; if (!S) return;
    var st = { i: 0, ev: 'normal' };
    function draw() {
      var g = S.stages[st.i], ev = st.ev, last = st.i === S.stages.length - 1;
      var lat = g.lat, cpu = g.cpu, share = g.share, hit = g.hit, write = 'yes';
      if (ev === 'x10') { cpu = g.cpu * 10; lat = cpu >= 100 ? null : Math.round(g.lat * 3); }
      if (ev === 'cold' && g.cache) { hit = 0; share = 100; lat = g.cold[0]; cpu = g.cold[1]; }
      if (ev === 'fail') write = g.fail === 'ok' ? 'yes' : (g.fail === 'partly' ? 'partly' : 'paused');
      var sat = cpu >= 100, cpuShown = Math.min(cpu, 100);
      var story, lesson;
      if (ev === 'normal') { story = g.story; lesson = g.lesson; }
      else if (ev === 'x10') { story = sat ? S.x10sat : S.x10ok; lesson = sat ? S.x10lessonSat : S.x10lessonOk; }
      else if (ev === 'cold') {
        if (!g.cache) { story = 'There is no cache yet, so there is nothing to go cold.'; lesson = 'Try this after the next stage.'; }
        else { story = S.cold || 'The cache restarts empty. Every read falls through to the database at once. The design is only safe if the database can take that.'; lesson = S.coldLesson || 'Warm the cache before taking traffic, or size the database for a cold start.'; }
      } else {
        story = g.fail === 'ok' ? S.failOk : (g.fail === 'partly' ? S.failPartly : S.failPaused + (g.cache ? S.failCache : S.failNoCache));
        lesson = g.fail === 'paused' ? 'Failover time is part of the design. Rehearse it.' : 'Spreading the data shrank what one failure can reach.';
      }
      var evName = EV.filter(function (e) { return e[0] === ev; })[0][1];
      var h = '<div class="sc-ctl"><span class="sc-lab">Stage</span>' + S.stages.map(function (s, k) {
        return '<button type="button" class="labbtn sc-st' + (k === st.i ? ' on' : '') + '" data-i="' + k + '" aria-pressed="' + (k === st.i) + '">' + (k + 1) + ' · ' + esc(s.name) + '</button>';
      }).join('') + '</div><div class="sc-ctl"><span class="sc-lab">Then</span>' + EV.map(function (e) {
        return '<button type="button" class="labbtn sc-ev' + (e[0] === ev ? ' on' : '') + '" data-e="' + e[0] + '" aria-pressed="' + (e[0] === ev) + '">' + e[1] + '</button>';
      }).join('') + '</div>';
      // diagram
      var hot = sat ? ' hot' : '', down = ev === 'fail';
      h += '<div class="sc-map"><div class="sc-box sc-traffic' + (ev === 'x10' ? ' hot' : '') + '"><span class="fk">Traffic</span><b>' + (ev === 'x10' ? '×10' : 'normal') + '</b></div><span class="fi-arrow" aria-hidden="true">→</span>';
      h += '<div class="sc-box"><span class="fk">App servers</span><b>stateless</b></div><span class="fi-arrow" aria-hidden="true">→</span>';
      if (g.cache) h += '<div class="sc-box sc-cache' + (ev === 'cold' ? ' cold' : '') + '"><span class="fk">Cache</span><b>' + esc(g.cache) + '</b><span class="fn">hit rate ' + (hit === null ? '-' : hit + '%') + '</span></div><span class="fi-arrow" aria-hidden="true">→</span>';
      h += '<div class="sc-db">';
      if (g.shards) {
        h += '<div class="sc-shards">' + g.shards.map(function (n, k) {
          var d = down && (g.fail === 'partly' ? k === 1 : k === 1);
          return '<div class="sc-box sc-pri' + (d ? ' down' : hot) + '"><span class="fk">' + (g.shardWord || 'Shard') + ' ' + (k + 1) + (d ? ' · down' : '') + '</span><span class="fn">' + esc(n) + '</span></div>';
        }).join('') + '</div>';
      } else {
        h += '<div class="sc-box sc-pri' + (down ? ' down' : hot) + '"><span class="fk">' + (down ? 'Primary · failed' : 'Primary') + '</span><b>' + esc(S.m.dbname) + '</b></div>';
        h += '<div class="sc-box sc-sb' + (down ? ' promoted' : '') + '"><span class="fk">' + (down ? 'Standby · being promoted' : 'Standby, another zone') + '</span></div>';
      }
      if (g.replica) h += '<div class="sc-box sc-rep"><span class="fk">' + esc(g.replica) + '</span></div>';
      h += '<div class="sc-cpu"><span>' + (g.shards ? 'CPU per ' + (g.shardWord || 'shard').toLowerCase() : 'Primary CPU') + '</span><div class="sc-bar"><i style="width:' + cpuShown + '%"' + (sat || cpu >= 70 ? ' class="hot"' : '') + '></i></div><b>' + (sat ? '100%, saturated' : cpu + '%') + '</b></div>';
      h += '</div></div>';
      var mt = [
        [lat === null ? 'timeouts' : '~' + lat + ' ms', S.m.lat, lat === null || lat > 300],
        [(sat ? 100 : cpu) + '%', g.shards ? 'CPU per ' + (g.shardWord || 'shard').toLowerCase() : 'primary CPU', sat || cpu >= 70],
        [share + '%', 'of reads reaching the database', share >= 100 && !!g.cache],
        [write === 'yes' ? 'yes' : (write === 'partly' ? '1 shard of 4 waits' : 'paused'), S.m.write, write !== 'yes']
      ];
      h += '<div class="sc-met">' + mt.map(function (m) { return '<div class="es-tile' + (m[2] ? ' warn' : '') + '"><div class="es-v">' + m[0] + '</div><div class="es-k">' + esc(m[1]) + '</div></div>'; }).join('') + '</div>';
      h += '<div class="sc-story" aria-live="polite"><div class="kicker">' + (st.i + 1) + ' · ' + esc(g.name) + (ev === 'normal' ? '' : ' · ' + evName.toLowerCase()) + '</div><p>' + esc(story) + '</p><p class="sc-lesson"><b>The lesson:</b> ' + esc(lesson) + '</p></div>';
      el.innerHTML = h;
      Array.prototype.forEach.call(el.querySelectorAll('.sc-st'), function (b) { b.addEventListener('click', function () { st.i = +b.getAttribute('data-i'); draw(); el.querySelector('.sc-st[data-i="' + st.i + '"]').focus(); }); });
      Array.prototype.forEach.call(el.querySelectorAll('.sc-ev'), function (b) { b.addEventListener('click', function () { st.ev = b.getAttribute('data-e'); draw(); el.querySelector('.sc-ev[data-e="' + st.ev + '"]').focus(); }); });
    }
    draw();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.scaleit'), mount);
})();
