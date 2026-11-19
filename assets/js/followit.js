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
  var LOCK = {
    pg: { name: 'PostgreSQL', flagLabel: 'Session B uses REPEATABLE READ', nodes: [
      ['Session A', 'UPDATE id = 7', 'BEGIN; UPDATE accounts SET balance = balance - 100 WHERE id = 7; A writes a new version of the row and marks the old one as locked by its transaction.'],
      ['Session B', 'UPDATE id = 7: waits', 'B tries to add 50 to the same row. It finds the row locked and waits for A\'s transaction to finish. pg_locks shows B waiting on A\'s transaction id.'],
      ['Session A', 'COMMIT', 'A commits. Its lock is released, and B wakes up.'],
      ['Session B', 're-checks the row', 'In READ COMMITTED, B re-reads the newest version of the row, the one A wrote, and adds 50 to that. Both changes are kept.']],
      flagLast: ['Session B', 'error: retry', 'In REPEATABLE READ, B\'s snapshot is from before A\'s change. B cannot update a row it cannot see, so it fails with "could not serialize access due to concurrent update".'],
      done: 'Both updates applied: -100 then +50. Nobody lost an update, because the second writer waited and then read the newest row.',
      doneFlag: 'B got an error instead of a wrong answer. The application has to catch it and run the whole transaction again. That is the deal REPEATABLE READ and SERIALIZABLE make in PostgreSQL.',
      watch: 'pg_locks joined to pg_stat_activity, or pg_blocking_pids(pid)' },
    my: { name: 'MySQL · InnoDB', flagLabel: 'Session A never commits', nodes: [
      ['Session A', 'UPDATE id = 7', 'BEGIN; UPDATE accounts SET balance = balance - 100 WHERE id = 7; InnoDB takes an exclusive lock on the index record for id 7.'],
      ['Session B', 'UPDATE id = 7: waits', 'B asks for the same record lock and waits. performance_schema.data_lock_waits shows who blocks whom.'],
      ['Session A', 'COMMIT', 'A commits and releases the record lock. B is granted it.'],
      ['Session B', 'applies its change', 'An UPDATE always reads the latest committed row, even in REPEATABLE READ, so B adds 50 to the row A wrote. Both changes are kept.']],
      flagLast: ['Session B', 'error 1205', 'A is still open, maybe an idle connection that forgot to commit. After innodb_lock_wait_timeout (50 seconds by default), B gives up with "Lock wait timeout exceeded". Only B\'s statement is rolled back, not its whole transaction.'],
      flagStep3: ['Session A', 'still open', 'A runs nothing and never commits. Its lock stays.'],
      done: 'Both updates applied. InnoDB serialised them with a record lock, and the UPDATE read the latest row rather than its snapshot.',
      doneFlag: 'One forgotten transaction blocked every writer to that row for 50 seconds each. Look for long-open transactions in information_schema.innodb_trx before you raise the timeout.',
      watch: 'performance_schema.data_lock_waits and information_schema.innodb_trx' }
  };
  function mount(el) {
    var mode = el.getAttribute('data-mode') || 'read';
    var TBL = mode === 'read' ? READ : (mode === 'lock' ? LOCK : REP);
    var engines = mode === 'replicate' ? ['pg', 'my', 'mo'] : ['pg', 'my'];
    var pref = window.HDW_ENGINE && HDW_ENGINE.get();
    var st = { eng: (pref && engines.indexOf(pref) >= 0) ? pref : (el.getAttribute('data-engine') || engines[0]), flag: false, i: 0 };
    function draw() {
      var D = TBL[st.eng], nodes = D.nodes;
      if (mode === 'lock' && st.flag) { nodes = nodes.slice(); nodes[3] = D.flagLast; if (D.flagStep3) nodes[2] = D.flagStep3; }
      var n = nodes.length, done = st.i >= n;
      var flagLabel = mode === 'read' ? 'The last page is on disk, not in memory' : (mode === 'lock' ? D.flagLabel : D.busyLabel);
      var h = '<div class="fi-ctl">' + engines.map(function (e) {
        var nm = TBL[e].name;
        return '<button type="button" class="labbtn fi-eng' + (e === st.eng ? ' on' : '') + '" data-e="' + e + '">' + esc(nm) + '</button>';
      }).join('') + '<label class="fi-flag"><input type="checkbox"' + (st.flag ? ' checked' : '') + '> ' + esc(flagLabel) + '</label>' +
        '<button type="button" class="labbtn fi-step">' + (done ? 'Run it again' : (st.i ? 'Next step' : 'Step')) + '</button>' +
        '<button type="button" class="labbtn fi-reset">Reset</button></div>';
      h += '<div class="fi-chain">' + nodes.map(function (d, k) {
        var last = k === n - 1;
        var slow = mode === 'lock' ? (k === 1 || (st.flag && (last || (D.flagStep3 && k === 2)))) : (st.flag && last);
        var cls = st.i > k ? (slow ? 'fi-node visited slow' : 'fi-node visited') : (st.i === k ? 'fi-node next' : 'fi-node');
        var where = mode === 'read' ? (st.i > k ? (slow ? 'read from disk' : 'found in memory') : (slow ? 'on disk' : 'in memory'))
          : (mode === 'lock' ? (st.i > k ? (k === 1 ? 'waiting' : (slow ? (last ? 'failed' : 'open') : 'done')) : '') : (st.i > k ? (slow ? 'waiting' : 'done') : ''));
        return '<div class="' + cls + '"><span class="fk">' + esc(d[0]) + '</span><b>' + esc(d[1]) + '</b><span class="fn">' + esc(d[2]) + '</span>' +
          (where ? '<span class="fw">' + where + '</span>' : '') + '</div>' + (last ? '' : '<span class="fi-arrow" aria-hidden="true">→</span>');
      }).join('') + '</div>';
      var cap;
      if (st.i === 0) cap = mode === 'lock' ? 'Two sessions change the same account at the same moment. Press Step.' : mode === 'read' ? 'SELECT * FROM orders WHERE id = 42; in a table of a million rows. Press Step.' : 'A customer updates their address. Press Step to follow the change to the replica.';
      else if (!done) cap = 'Step ' + st.i + ' of ' + n + ': ' + nodes[st.i - 1][2];
      else if (mode === 'lock') cap = (st.flag ? D.doneFlag : D.done) + ' Watch: ' + D.watch + '.';
      else if (mode === 'read') {
        var hit = n - (st.flag ? 1 : 0), rd = st.flag ? 1 : 0;
        cap = n + ' pages for one row in a million. ' + D.done + ' ' + (st.flag ? 'One page came from disk, and that single read is most of the time this lookup takes.' : 'All of them were already in ' + D.cache + ', so the lookup costs microseconds.') +
          (st.eng === 'pg' ? ' EXPLAIN (ANALYZE, BUFFERS) would say: Buffers: shared hit=' + hit + (rd ? ' read=' + rd : '') + '.' : '');
      } else cap = st.flag ? D.busy + ' Watch: ' + D.metric + '.' : 'The change is on the replica. The time from step 1 to here is the replication lag. Watch: ' + D.metric + '.';
      h += '<p class="fi-cap" aria-live="polite">' + esc(cap) + '</p>';
      if (window.HDW_GOALS) {
        var gk = 'follow-' + mode; st.doneIn = st.doneIn || {};
        if (done) st.doneIn[st.eng] = 1;
        if (mode === 'read') { if (done && st.flag) HDW_GOALS.done(gk, 'disk'); if (st.doneIn.pg && st.doneIn.my) HDW_GOALS.done(gk, 'both'); }
        if (mode === 'replicate') { if (done && st.flag) HDW_GOALS.done(gk, 'lag'); if (Object.keys(st.doneIn).length >= 3) HDW_GOALS.done(gk, 'three'); }
        if (mode === 'lock') { if (st.i >= 2) HDW_GOALS.done(gk, 'wait'); if (done && st.flag && st.eng === 'pg') HDW_GOALS.done(gk, 'rr'); if (done && st.flag && st.eng === 'my') HDW_GOALS.done(gk, 'timeout'); }
      }
      el.innerHTML = h;
      Array.prototype.forEach.call(el.querySelectorAll('.fi-eng'), function (b) { b.addEventListener('click', function () { st.eng = b.getAttribute('data-e'); st.i = 0; if (mode === 'lock') st.flag = false; if (window.HDW_ENGINE) HDW_ENGINE.set(st.eng); draw(); }); });
      el.querySelector('.fi-flag input').addEventListener('change', function (e) { st.flag = e.target.checked; st.i = 0; draw(); });
      el.querySelector('.fi-step').addEventListener('click', function () { st.i = st.i >= n ? 1 : st.i + 1; draw(); el.querySelector('.fi-step').focus(); });
      el.querySelector('.fi-reset').addEventListener('click', function () { st.i = 0; draw(); });
    }
    draw();
    var GOALS = {
      read: [['disk', 'Move the last page to disk, then step to the end'], ['both', 'Count the pages in both engines: which needs one more, and why?']],
      replicate: [['lag', 'Make the replica fall behind, then step to the end'], ['three', 'Follow the change in all three databases']],
      lock: [['wait', 'Find the step where session B has to wait'], ['rr', 'Make PostgreSQL give session B an error instead'], ['timeout', 'Leave a transaction open in MySQL and see what B gets']]
    };
    if (window.HDW_GOALS && GOALS[mode]) HDW_GOALS.attach(el, 'follow-' + mode, GOALS[mode]);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.followit'), mount);
})();
