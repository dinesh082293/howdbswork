/* Follow it: step through one read, or one change travelling to a replica.
   Markup: <div class="followit" data-mode="read|replicate" data-engine="pg|my|mo"></div> */
(function () {
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var READ = {
    pg: { name: 'PostgreSQL', cache: 'shared_buffers', nodes: [
      ['Index', 'Root page', 'Points to the branch that covers id 42.'],
      ['Index', 'Branch page', 'Narrows to one leaf.'],
      ['Index', 'Leaf page', 'Finds id 42 and the row\'s address: page 1834, slot 7.'],
      ['Table', 'Table page 1834', 'Holds the row itself. In PostgreSQL the table is separate from its indexes.']],
      done: 'PostgreSQL reads the index pages, then the table page.' },
    my: { name: 'MySQL · InnoDB', cache: 'the buffer pool', nodes: [
      ['Clustered index', 'Root page', 'Points to the branch that covers id 42.'],
      ['Clustered index', 'Branch page', 'Narrows to one leaf.'],
      ['Clustered index', 'Leaf page', 'The leaf holds the row itself, because InnoDB stores the table in primary key order.']],
      done: 'InnoDB stops at the leaf, because the leaf holds the row.' }
  };
  var REP = {
    pg: { name: 'PostgreSQL', nodes: [
      ['Primary', 'COMMIT', 'The change is in the WAL and flushed to pg_wal/ on the primary.'],
      ['Network', 'walsender streams it', 'The primary streams the new WAL to the standby as it is written.'],
      ['Standby', 'walreceiver writes it', 'The standby writes the WAL to its own pg_wal/. pg_stat_replication shows this as write_lag and flush_lag.'],
      ['Standby', 'replay', 'One startup process replays the WAL into the standby\'s data pages. This is replay_lag.']],
      busy: 'A long query on the standby needs rows that the replay would change. Replay waits, up to max_standby_streaming_delay (30 s by default), then cancels the query. Meanwhile the lag grows.',
      busyLabel: 'A long query is running on the standby', metric: 'replay_lag in pg_stat_replication' },
    my: { name: 'MySQL', nodes: [
      ['Source', 'COMMIT', 'The redo log and the binlog are flushed together on the source.'],
      ['Network', 'binlog dump thread sends it', 'The source sends the new binlog events to each connected replica.'],
      ['Replica', 'receiver writes the relay log', 'The replica\'s I/O thread writes the events to its relay log.'],
      ['Replica', 'applier threads apply it', 'Applier threads replay the events. Parallel workers help when the source ran many small transactions.']],
      busy: 'The source just committed one DELETE of 40 million rows. It replays as one unit, and everything after it waits. Seconds_Behind_Source climbs until it finishes.',
      busyLabel: 'One huge transaction is ahead in the queue', metric: 'Seconds_Behind_Source in SHOW REPLICA STATUS' },
    mo: { name: 'MongoDB', nodes: [
      ['Primary', 'write and oplog entry', 'The primary applies the write and adds an oplog entry in the same storage transaction.'],
      ['Network', 'secondary fetches a batch', 'Each secondary tails the primary\'s oplog and fetches new entries in batches.'],
      ['Secondary', 'applies the batch', 'The secondary applies the batch with several writer threads, then writes it to its own oplog.'],
      ['Secondary', 'reports its position', 'With w: "majority", the client is acknowledged once most members have reported the write as journaled.']],
      busy: 'The secondary was down for longer than the oplog window. The entries it needs have been overwritten on the primary, so it cannot catch up from the oplog. It needs a full resync.',
      busyLabel: 'The secondary was down longer than the oplog window', metric: 'rs.printSecondaryReplicationInfo()' }
  };
  function mount(el) {
    var mode = el.getAttribute('data-mode') || 'read';
    var engines = mode === 'read' ? ['pg', 'my'] : ['pg', 'my', 'mo'];
    var st = { eng: el.getAttribute('data-engine') || engines[0], flag: false, i: 0 };
    function draw() {
      var D = mode === 'read' ? READ[st.eng] : REP[st.eng], n = D.nodes.length, done = st.i >= n;
      var flagLabel = mode === 'read' ? 'The last page is on disk, not in memory' : D.busyLabel;
      var h = '<div class="fi-ctl">' + engines.map(function (e) {
        var nm = (mode === 'read' ? READ : REP)[e].name;
        return '<button type="button" class="labbtn fi-eng' + (e === st.eng ? ' on' : '') + '" data-e="' + e + '">' + esc(nm) + '</button>';
      }).join('') + '<label class="fi-flag"><input type="checkbox"' + (st.flag ? ' checked' : '') + '> ' + esc(flagLabel) + '</label>' +
        '<button type="button" class="labbtn fi-step">' + (done ? 'Run it again' : (st.i ? 'Next step' : 'Step')) + '</button>' +
        '<button type="button" class="labbtn fi-reset">Reset</button></div>';
      h += '<div class="fi-chain">' + D.nodes.map(function (d, k) {
        var last = k === n - 1;
        var slow = st.flag && (mode === 'read' ? last : k === n - 1);
        var cls = st.i > k ? (slow ? 'fi-node visited slow' : 'fi-node visited') : (st.i === k ? 'fi-node next' : 'fi-node');
        var where = mode === 'read' ? (st.i > k ? (slow ? 'read from disk' : 'found in memory') : (slow ? 'on disk' : 'in memory'))
          : (st.i > k ? (slow ? 'waiting' : 'done') : '');
        return '<div class="' + cls + '"><span class="fk">' + esc(d[0]) + '</span><b>' + esc(d[1]) + '</b><span class="fn">' + esc(d[2]) + '</span>' +
          (where ? '<span class="fw">' + where + '</span>' : '') + '</div>' + (last ? '' : '<span class="fi-arrow" aria-hidden="true">→</span>');
      }).join('') + '</div>';
      var cap;
      if (st.i === 0) cap = mode === 'read' ? 'SELECT * FROM orders WHERE id = 42; in a table of a million rows. Press Step.' : 'A customer updates their address. Press Step to follow the change to the replica.';
      else if (!done) cap = 'Step ' + st.i + ' of ' + n + ': ' + D.nodes[st.i - 1][2];
      else if (mode === 'read') {
        var hit = n - (st.flag ? 1 : 0), rd = st.flag ? 1 : 0;
        cap = n + ' pages for one row in a million. ' + D.done + ' ' + (st.flag ? 'One page came from disk, and that single read is most of the time this lookup takes.' : 'All of them were already in ' + D.cache + ', so the lookup costs microseconds.') +
          (st.eng === 'pg' ? ' EXPLAIN (ANALYZE, BUFFERS) would say: Buffers: shared hit=' + hit + (rd ? ' read=' + rd : '') + '.' : '');
      } else cap = st.flag ? D.busy + ' Watch: ' + D.metric + '.' : 'The change is on the replica. The time from step 1 to here is the replication lag. Watch: ' + D.metric + '.';
      h += '<p class="fi-cap" aria-live="polite">' + esc(cap) + '</p>';
      el.innerHTML = h;
      Array.prototype.forEach.call(el.querySelectorAll('.fi-eng'), function (b) { b.addEventListener('click', function () { st.eng = b.getAttribute('data-e'); st.i = 0; draw(); }); });
      el.querySelector('.fi-flag input').addEventListener('change', function (e) { st.flag = e.target.checked; st.i = 0; draw(); });
      el.querySelector('.fi-step').addEventListener('click', function () { st.i = st.i >= n ? 1 : st.i + 1; draw(); el.querySelector('.fi-step').focus(); });
      el.querySelector('.fi-reset').addEventListener('click', function () { st.i = 0; draw(); });
    }
    draw();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.followit'), mount);
})();
