/* Extracted verbatim from the single-file site (two <script> blocks,
   concatenated in order). Minimal guards added so this one shared file
   runs on every page: each widget's init is wrapped in if() on the
   element it needs, so pages without that widget skip it instead of
   throwing. No behaviour, data, or wording was changed. */

var LEVELS=[
 {t:"Level 0, Durability: the log is written before the data",problem:"A commit must survive a power cut, even though the data page is still only in memory.",take:"COMMIT means the log record is on disk. Everything else, checkpoints, replicas, backups, is built on that one ordering rule.",pairs:[
  {eng:"pg",title:"PostgreSQL, WAL first, commit second",
   hook:"A commit costs <b>one sequential fsync</b>: a WAL record of a few hundred bytes. Writing the data instead would mean the heap page plus one page per index, 4 or more random 8 KB writes, each needing its own ordering guarantee. One sequential write at ~0.1–1 ms replaces all of them: commit cost drops from O(pages touched) to O(1).",
   problem:"The data page cannot be forced to disk on every commit, that is far too slow, yet a committed row must never be lost.",
   growth:[["10 MB of WAL/day","Any default survives. Archiving is a nice-to-have.",0],["~1–2 GB/day","Archiving and retention become real jobs; a missed archive is visible within a day.",0],["Transition: 50–100 MB/min","Checkpoint and archive throughput become the write ceiling. Requested checkpoints appear in pg_stat_bgwriter.",1],["1+ GB/min at peak","WAL generation rate, not table size, not CPU, is the instance's write limit. Sizing is a capacity decision.",1]],
   diagram:[["Backend","writes change",""],["WAL buffer → WAL writer","fsync, sequential","hot"],["pg_wal/000000010000000000000003","16 MB segment, on disk","good"],["COMMIT returns","only after fsync",""],["Checkpoint (later)","page → base/16384/16397",""]],
   why:"Commit latency becomes one sequential fsync instead of random page writes. WAL generation rate (MB/s) is the real write ceiling of the instance, not table size.",
   tradeoff:"synchronous_commit = on is the safe default. off / local buys latency by risking the last ~3× WAL-writer-delay of commits on an OS crash, acceptable for staging or rebuildable data, never for payments.",
   practice:{out:`$ pg_waldump pg_wal/000000010000000000000003 | head -3
rmgr: Heap  len (rec/tot): 59/  59, tx: 801, lsn: 0/03A4F8C0
  desc: INSERT off 3 flags 0x00 <span class="c">← the change, recorded before the page</span>
rmgr: Transaction len (rec/tot): 24/  24, tx: 801
  desc: COMMIT 2026-11-15 09:41:07.221 PST <span class="good">← this record fsynced = the row is durable</span>
SELECT pg_current_wal_lsn();  →  0/03A4F928`,
   note:"<b>What proves health:</b> commit records appear in the segment in order, and <span class='mono'>pg_wal</span> size is stable across a day. <b>Red flags:</b> <span class='mono'>archive_status/</span> accumulating <span class='mono'>.ready</span> files (archiving is failing and segments cannot be recycled); <span class='mono'>replay_lag</span> in <span class='mono'>pg_stat_replication</span> climbing at a constant write rate (the standby's apply, not the network, is behind)."},
   detect:"SELECT pg_current_wal_lsn(), pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) FROM pg_stat_replication;\n-- shell: du -sh $PGDATA/pg_wal ; check archive_status/",
   root:"WAL archiving fails, or a dead standby / replication slot holds segments past the reach of every checkpoint.",
   blast:"<span class='mono'>pg_wal/</span> grows until the filesystem reaches 100%, at which point the primary panics and stops accepting writes. A durability mechanism becomes the outage, and recovery is blocked until space is freed without deleting held segments by hand.",
   mit:"Alert on <span class='mono'>pg_wal</span> size and per-slot lag in bytes; drop dead slots; fix archiving before it is an emergency; keep <span class='mono'>pg_wal</span> on its own filesystem so it cannot starve the data files.",
   mistake:"Sizing max_wal_size by guesswork, or putting pg_wal on the same saturated disk as the data files.",
   metric:"Requested vs timed checkpoints in pg_stat_bgwriter / pg_stat_checkpointer, plus WAL bytes/s in pg_stat_wal. checkpoints_req > 0 every day = max_wal_size too small for your write rate."},
  {eng:"my",title:"MySQL, redo + binlog must agree (two-phase commit)",
   hook:"Two logs record the same transaction in two vocabularies: redo says <i>these bytes of this page changed</i>, the binlog says <i>this transaction happened</i>. If a crash leaves them disagreeing by even <b>one transaction</b>, the source and every replica hold different data, with no error raised anywhere. Two-phase commit exists so the committed-transaction count in both logs is always identical.",
   problem:"InnoDB and the binary log are two separate logs; a crash must never leave a row in one and not the other.",
   growth:[["Dev / staging","Settings barely matter; crashes are free lessons.",0],["Real traffic, safe settings","flush=1 + sync_binlog=1: full safety, commit cost = 2 fsyncs.",0],["Transition: someone benchmarks with flush=2","Throughput looks 20–30% better in the load test. The config ships.",1],["First OS crash in production","Up to ~1 s of commits missing from one or both logs. Replicas diverge silently; PITR replays a history that never happened.",1]],
   diagram:[["InnoDB redo buffer","page changes",""],["ib_logfile0 / #innodb_redo/","crash recovery","hot"],["mysql-bin.000007 + GTID","replication + PITR","hot"],["2PC: prepare → binlog fsync → commit","innodb_flush_log_at_trx_commit=1, sync_binlog=1","good"]],
   why:"Redo rebuilds pages on this server; the binlog rebuilds data on other servers. The internal two-phase commit is what keeps replicas and point-in-time recovery consistent with the engine.",
   tradeoff:"flush=1 + sync_binlog=1 is the only fully safe pair. flush=2 or sync_binlog=0 trades durability for throughput, the classic silent data-loss setting found in inherited configs.",
   practice:{out:`SELECT @@innodb_flush_log_at_trx_commit, @@sync_binlog;
→ 1, 1  <span class="good">← the only fully safe pair</span>
→ 2, 0  <span class="flag">← inherited config: up to ~1 s of commits losable per crash</span>

SHOW ENGINE INNODB STATUS\\G   (LOG section)
Log sequence number  9182736455  <span class="c">← redo position (LSN)</span>
Log flushed up to    9182736455  <span class="c">← equal to LSN = redo fully flushed</span>`,
   note:"<b>What proves health:</b> the variable pair reads 1, 1 and 'Log flushed up to' tracks the sequence number. <b>Red flags:</b> either variable relaxed on a server holding real data; <span class='mono'>gtid_executed</span> differing between source and replica after a failover, the set difference is exactly the transactions one side has and the other does not."},
   detect:"SHOW ENGINE INNODB STATUS\\G  -- LOG section\nSELECT @@innodb_flush_log_at_trx_commit, @@sync_binlog, @@gtid_executed;",
   root:"Durability settings relaxed for a benchmark or copied from a tuning blog, then never restored.",
   blast:"An OS crash loses up to ~1 second of commits from redo and/or the binlog. Because nothing errors, replicas diverge quietly and the divergence surfaces days later as missing or phantom rows.",
   mit:"flush=1 + sync_binlog=1 on anything holding real data; keep the pair under config management so a benchmark cannot ship it; compare <span class='mono'>gtid_executed</span> on both sides after every failover.",
   mistake:"Benchmarking with flush=2, shipping it to production, and discovering it during the first real crash.",
   metric:"Binlog fsync latency and redo write waits under peak load; any gap between gtid_executed on source vs replica after a failover."},
  {eng:"mo",title:"MongoDB, journal is durability, oplog is replication",
   hook:"Two numbers that are constantly confused: journal latency is measured in <b>milliseconds</b> (this node's crash safety); the oplog window is measured in <b>hours</b> (the set's catch-up budget). A write with <span class='mono'>w: 1</span> can be journaled in ~1 ms and still be rolled back minutes later in an election. Durability on one node is not durability of the set.",
   problem:"Two different logs get confused constantly: one protects against a crash on this node, the other keeps the replica set identical.",
   growth:[["Single node / dev set","Journal alone is the whole story. w:1 feels safe.",0],["Replica set, w:1 writes","First election rolls back acknowledged writes. The rollback/ directory gets its first files.",0],["Transition: write volume grows 10×","Same oplog size, one-tenth the window. Nobody recomputed it.",1],["Window < maintenance duration","A member down for routine work returns to a full initial sync, during peak traffic.",1]],
   diagram:[["mongod (primary)","accepts write",""],["journal/WiredTigerLog.*","write-ahead, j:true waits here","hot"],["WiredTiger cache","dirty pages",""],["local.oplog.rs","ordered ops for secondaries","good"],["Secondaries","tail + apply oplog",""]],
   why:"A write can be journaled (safe on this node) yet still roll back in an election if a majority never saw it. Staff-level MongoDB work starts by separating these two guarantees.",
   tradeoff:"writeConcern { w: 1 } is fast and rollback-prone. { w: 'majority', j: true } costs cross-member latency and is the only setting where acknowledged means survives an election.",
   practice:{out:`rs.printReplicationInfo()
configured oplog size:   10240 MB
log length start to end: 26.4 hours  <span class="good">← the window: max survivable downtime</span>
oplog first event time:  Sun Nov 15 2026 08:12:44 GMT-08:00
oplog last event time:   Mon Nov 16 2026 10:37:02 GMT-08:00

db.serverStatus().wiredTiger.log  <span class="c">← journal flush + commit latency lives here</span>`,
   note:"<b>What proves health:</b> the window (26.4 h here) exceeds your longest planned maintenance with margin. <b>Red flags:</b> window shrinking month over month at the same oplog size (write rate is eating it); per-member lag in <span class='mono'>rs.status()</span> growing linearly, that is apply throughput, not network."},
   detect:"db.serverStatus().wiredTiger.log\nrs.printReplicationInfo()  // oplog window\nrs.status()  // per-member lag",
   root:"Journal and data files share one contended volume, so journal fsyncs queue behind checkpoint writes; or writes are acknowledged with w: 1 and never reach a majority before an election.",
   blast:"Either every <span class='mono'>j:true</span> write inherits the volume contention (commit latency degrades instance-wide), or acknowledged writes roll back in an election and land in <span class='mono'>rollback/</span>, application-level data loss on a cluster that reports itself healthy.",
   mit:"Put the journal on its own volume; use <span class='mono'>{ w: 'majority', j: true }</span> for any write that must survive an election; alert on oplog window hours and lag slope, not just lag.",
   mistake:"Treating the oplog as a backup or as the crash log, it is neither; it is a capped replication stream.",
   metric:"Journal commit latency in serverStatus, plus secondary lag in seconds. Lag growing linearly = apply throughput, not network, is the bottleneck."}
 ]},
 {t:"Level 1, Pages, buffers, and eviction",problem:"Every page a query needs is either already in RAM (~100 ns to use) or must be read from disk (~80 µs on NVMe, ~10 ms on a hard disk), a 1,000× to 100,000× difference decided entirely by what the cache kept and what it evicted.",take:"Size the cache for the working set, then watch who evicts: background threads are healthy, application threads evicting is a latency alarm in all three engines.",pairs:[
  {eng:"pg",title:"PostgreSQL, shared_buffers, clock sweep, bgwriter, checkpoints",
   hook:"The arithmetic of a hit ratio: at 10,000 queries/second, <b>99% hits still means 100 disk reads/second</b>; at 95% it is 500/second and the disk is now the database. A miss is not just slower, if the page evicted to make room is dirty, the miss also pays a write first. Eviction is the only place a read can be forced to do write I/O.",
   problem:"When a backend needs a page that is not cached, something else must leave, and if the victim is dirty, someone must write it first.",
   growth:[["10K rows","The whole table fits in shared_buffers. Every plan looks fast.",0],["1M rows","Working set ≈ cache. Hit ratio still above 99%; nothing to see.",0],["Transition: working set crosses total cache","Misses begin; dirty victims make some reads pay a write. Latency develops a sawtooth synced to checkpoints.",1],["10M+ rows","Eviction churn dominates: buffers_alloc climbs, unrelated queries slow down because hot pages keep getting evicted by scans.",1]],
   diagram:[["Backend needs page","not in shared_buffers",""],["Clock sweep hand","usage_count counts down","hot"],["Dirty victim","bgwriter / checkpointer writes it",""],["Page loaded","from base/16384/16397","good"]],
   why:"Eviction cost lands on foreground queries when background flushing falls behind: the classic sawtooth latency pattern that tracks the checkpoint cycle exactly.",
   tradeoff:"shared_buffers around 25% of RAM is the usual start. Much larger double-buffers against the OS page cache and makes checkpoints heavier; much smaller forces constant eviction churn.",
   practice:{out:`SELECT checkpoints_timed, checkpoints_req,
       buffers_checkpoint, buffers_clean, buffers_backend
  FROM pg_stat_bgwriter;
 timed = 812   req = 37  <span class="flag">← 37 size-triggered checkpoints: max_wal_size too small</span>
 buffers_backend = 1,204,551  <span class="flag">← backends writing dirty pages themselves = foreground eviction cost</span>
 buffers_alloc climbing fast  <span class="c">← constant page loading = misses, not hits</span>`,
   note:"<b>What proves health:</b> checkpoints are timed, not requested, and <span class='mono'>buffers_backend</span> is a small fraction of <span class='mono'>buffers_checkpoint + buffers_clean</span>, background processes do the writing. <b>Red flags:</b> <span class='mono'>checkpoints_req &gt; 0</span> on any normal day; latency graphs that spike on the checkpoint interval."},
   detect:"SELECT checkpoints_timed, checkpoints_req, buffers_checkpoint, buffers_clean, maxwritten_clean FROM pg_stat_bgwriter;\n-- PG17: pg_stat_checkpointer",
   root:"The working set outgrew the cache, or checkpoint settings (small max_wal_size, short checkpoint_timeout) force write bursts faster than the bgwriter's steady pace.",
   blast:"Foreground queries pay eviction and dirty-write cost directly: p99 latency sawtooths in sync with checkpoints across the whole instance, including queries that touch none of the hot data.",
   mit:"Size <span class='mono'>shared_buffers</span> around 25% of RAM; raise <span class='mono'>max_wal_size</span> to stretch checkpoints; tune bgwriter aggressiveness; verify with <span class='mono'>buffers_*</span> deltas over a peak hour, not by feel.",
   mistake:"Raising shared_buffers to 70–80% of RAM because more cache must be better.",
   metric:"checkpoints_req staying above zero and buffers_alloc climbing fast, the working set does not fit, or max_wal_size forces write bursts."},
  {eng:"my",title:"MySQL, buffer pool, redo capacity, and checkpoint age",
   hook:"Checkpoint age is a subtraction: <b>redo capacity minus the LSN span of unflushed dirty pages</b>. At ~75% of capacity InnoDB starts flushing aggressively; near 100% it throttles writes until flushing catches up. A 1 GB redo log absorbing 20 MB/s of page changes holds <b>50 seconds</b> of headroom. That number, not the instance size, is the write-burst budget.",
   problem:"Dirty pages can only be overwritten in the redo log after they are flushed; if flushing falls behind writes, the log wraps into unwritten work.",
   growth:[["Low write rate","Checkpoint age sits near zero. Redo size is invisible.",0],["Steady writes","Age stabilizes where flush rate equals write rate. Still fine.",0],["Transition: burst length × rate > capacity","Age crosses ~75% during every peak. Aggressive flushing begins; write latency rises exactly at peak load.",1],["Sustained overload","Age pinned at capacity: writes stall to flush speed. The database is slowest precisely when the business is busiest.",1]],
   diagram:[["Buffer pool","dirty pages accumulate",""],["Redo log (capacity)","checkpoint age grows →","hot"],["Page cleaner threads","flush dirty pages",""],["users.ibd","checkpoint advances","good"]],
   why:"Checkpoint age is InnoDB headroom. Near capacity, InnoDB switches to aggressive flushing and write stalls, the database slows down precisely at peak write load.",
   tradeoff:"Bigger innodb_redo_log_capacity (8.0.30+, up to 100 GB) smooths write bursts and reduces flush pressure, at the cost of disk space and longer worst-case crash recovery.",
   practice:{out:`SHOW ENGINE INNODB STATUS\\G   (LOG + FILE I/O sections)
Log sequence number     9182736455
Last checkpoint at      9174011223
<span class="flag">Checkpoint age = 8,725,232 bytes of redo not yet flushed to data files</span>
Modified db pages       61,204  <span class="c">← dirty pages in the buffer pool right now</span>
Pending normal aio writes: 0  <span class="c">← nonzero + growing = flush path saturated</span>`,
   note:"<b>The derived check:</b> checkpoint age ÷ <span class='mono'>innodb_redo_log_capacity</span>. Under ~50% is headroom; sustained above ~75% means flushing cannot match the write rate. <b>Red flags:</b> 'Modified db pages' large and still growing at constant load; pending writes queuing in the FILE I/O section."},
   detect:"SHOW ENGINE INNODB STATUS\\G\n-- FILE I/O + LOG: 'Checkpoint age', 'Modified db pages', pending writes",
   root:"Redo capacity sized for the average write rate instead of the peak, or flush throughput (storage) lower than the dirty-page generation rate.",
   blast:"Write latency spikes at peak load, InnoDB deliberately throttles all writers to protect crash recovery. In the worst case, near-stalls on the primary during the highest-value traffic of the day.",
   mit:"Raise <span class='mono'>innodb_redo_log_capacity</span> (resizable online in 8.0.30+); alert at 75% checkpoint age; if age stays high after resizing, the bottleneck is flush throughput, fix storage, not settings.",
   mistake:"Leaving a small redo log on a write-heavy primary, then tuning everything except the redo log.",
   metric:"Checkpoint age as a percentage of redo capacity. Sustained above ~75% means flushing cannot keep up with the write rate."},
  {eng:"mo",title:"MongoDB, WiredTiger cache eviction",
   hook:"The WiredTiger cache defaults to <b>50% of (RAM − 1 GB)</b>, and two percentages run it: eviction <b>target 5% dirty</b>, eviction <b>trigger 20% dirty</b>. Below target, background workers evict quietly. Above trigger, application threads are forced to evict before they may proceed, an operation that cost 1 ms now costs a disk write first: 10–100× slower, on every operation, instance-wide.",
   problem:"Reads and writes happen in the cache; when it fills with dirty pages, eviction, not disk speed, becomes the latency.",
   growth:[["Working set fits in cache","Eviction is background noise. Dirty bytes hover near target.",0],["Write rate grows","Dirty bytes oscillate between target and trigger at peak. Still absorbed.",0],["Transition: dirty pinned above the 20% trigger","Application threads start evicting. First multi-second stalls appear while CPU and disk look only moderately busy.",1],["Chronic","Every operation inherits eviction cost. Teams upgrade disks and see no improvement, because the bottleneck was never disk speed.",1]],
   diagram:[["WiredTiger cache","~50% of (RAM − 1 GB)",""],["Dirty pages rise","eviction target 5%, trigger 20%","hot"],["Eviction workers","write dirty, free clean",""],["App threads evict","= stall, latency spike","hot"]],
   why:"The single most common WiredTiger production issue: once application threads are forced to do eviction work, every operation inherits disk latency.",
   tradeoff:"A larger cacheSizeGB holds more working set but starves the OS filesystem cache that WiredTiger also depends on. Default exists for a reason; change it with evidence.",
   practice:{out:`db.serverStatus().wiredTiger.cache
"bytes currently in the cache"        : 15.8 GB
"tracked dirty bytes in the cache"    : 4.6 GB  <span class="flag">← ~29% of cache: above the 20% trigger</span>
"pages evicted by application threads": 182334  <span class="flag">← must be 0; nonzero = users are paying eviction cost</span>
"pages evicted by worker threads"     : 9.1M    <span class="c">← background eviction: healthy</span>`,
   note:"<b>What proves health:</b> dirty bytes under the trigger and application-thread evictions at exactly zero. <b>Red flag:</b> the app-thread eviction counter moving at all, it is the single most diagnostic number in WiredTiger <span class='mono'>serverStatus</span> output."},
   detect:"db.serverStatus().wiredTiger.cache\n// read: 'tracked dirty bytes in the cache',\n// 'pages evicted by application threads'",
   root:"The working set or the write burst exceeds what the cache can hold and clean at the rate operations dirty it, eviction workers fall behind and the debt is handed to application threads.",
   blast:"Instance-wide multi-second operation stalls while CPU and disk utilisation look unremarkable, the hardest WiredTiger incident to recognise, because every standard dashboard says the hardware is fine.",
   mit:"Reduce dirty-page generation (batch writes, fix the scan that churns the cache), add RAM or shrink the working set; tune eviction threads only with <span class='mono'>serverStatus</span> evidence; alert on application-thread evictions &gt; 0.",
   mistake:"Blaming slow disks and upgrading storage when the real problem is cache pressure from a working set that outgrew RAM.",
   metric:"Pages evicted by application threads greater than zero, and tracked dirty bytes sustained above the 20% trigger."}
 ]},
 {t:"Level 2, Indexes: pay on write, win on read",problem:"Every index adds one B-tree write to every INSERT and UPDATE on its table, forever; in exchange it cuts a lookup from N pages to about 3. The staff skill is pricing both sides of that trade in numbers, not adjectives.",take:"Measure both sides of every index, heap fetches and HOT ratio on the read side, write amplification on the other, before adding it, and again before keeping it.",pairs:[
  {eng:"pg",title:"PostgreSQL, index-only scans and the visibility map",
   hook:"Count the pages for a 1,000-row lookup. Index scan: ~3 index pages + <b>1,000 heap pages</b>, one random fetch per row, the index walk is 0.3% of the cost. Index-only scan with a current visibility map: <b>0 heap pages</b>. The same query drops from ~1,003 page reads to ~10, and the only thing that changed is one bit per page in a side file (<span class='mono'>16397_vm</span>) that VACUUM maintains.",
   problem:"A normal index scan still fetches the heap page for every row, mostly to check visibility, random I/O that dwarfs the index walk on big lookups.",
   growth:[["Small table","Heap fetches are cached anyway. The distinction is invisible.",0],["Index-only scan adopted","Heap Fetches: 0 in EXPLAIN. The win is real while vacuum keeps up.",0],["Transition: update rate outpaces vacuum","Visibility map goes stale page by page. Heap Fetches creep from 0 to hundreds per query, no deploy, no error.",1],["Production","The plan still says Index Only Scan. The cost is back to index-scan levels, but the wider index still adds its write to every INSERT and UPDATE.",1]],
   diagram:[["Query","needs key + 2 columns",""],["Index file base/…/16405","holds all needed columns",""],["Visibility map bit set?","yes → skip heap","good"],["Heap fetch","only when bit is unset","hot"]],
   why:"A covering index plus a current visibility map turns a lookup into index pages only. This is often the largest single read win available on a hot query.",
   tradeoff:"Wider indexes cost write I/O, WAL volume, and cache on every insert and update, and the win evaporates if vacuum lets the visibility map go stale.",
   practice:{out:`-- healthy table:
Index Only Scan using users_email_idx on users
  Heap Fetches: 0        <span class="good">← visibility map current: truly index-only</span>
  Buffers: shared hit=4  <span class="c">← 4 pages total for the lookup</span>

-- same plan, update-heavy table:
Index Only Scan using users_email_idx on users
  Heap Fetches: 48,213   <span class="flag">← the plan lies by omission: 48k heap fetches behind it</span>`,
   note:"<b>Read the Heap Fetches line, not the scan type.</b> The planner prints 'Index Only Scan' in both cases; only the fetch count separates a 4-page lookup from a 48,000-fetch one. <b>Red flag:</b> Heap Fetches in the hundreds on any top-10 query."},
   detect:"EXPLAIN (ANALYZE, BUFFERS) SELECT …;\n-- read the 'Heap Fetches: N' line, not just the scan type",
   root:"Autovacuum is not keeping the visibility map current on an update-heavy table, so the per-page 'all visible' bits are unset and every row needs a heap visit to confirm visibility.",
   blast:"The covering index delivers almost none of its promised win while its full write cost remains, read latency stays high on the hot query and write throughput is permanently lower than before the index was added.",
   mit:"Tune autovacuum per table (lower scale factor on the hot tables) so the visibility map stays current; track Heap Fetches on the top queries; only widen indexes after the map is proven current.",
   mistake:"Adding ever-wider covering indexes to a table whose real problem is vacuum not keeping the visibility map current.",
   metric:"Heap Fetches per index-only scan on the top queries, and the ratio of index-only to plain index scans in pg_stat_user_indexes."},
  {eng:"pg",title:"PostgreSQL, HOT updates: change a row without touching any index",
   hook:"Price one UPDATE of a row in a table with 4 indexes. Non-HOT: <b>1 heap write + 4 index writes</b>, and 5 dead entries left for vacuum. HOT: <b>1 heap write, 0 index writes</b>, cleaned up by pruning on the next read of that page. At 5,000 updates/second that is 25,000 page writes/second versus 5,000, a 5× write reduction from changing nothing but which columns the UPDATE touches and how full the page is.",
   problem:"If every UPDATE rewrites every index entry, a hot row with 4 indexes costs 5 writes and floods vacuum with dead index entries.",
   growth:[["Low update rate","HOT is a curiosity. Bloat is unmeasurable.",0],["Update-heavy table, HOT working","hot_pct above 90%: updates cost one heap write each.",0],["Transition: one indexed column joins the SET list","HOT eligibility drops to zero for those updates. No schema change, no error, cost per update jumps 5–10× overnight.",1],["Production","Dead index entries flood vacuum, pages bloat, and the team tunes autovacuum harder to treat a symptom created by the update pattern.",1]],
   diagram:[["UPDATE","no indexed column changes",""],["Old tuple","same heap page",""],["HOT chain → new tuple","same page, index untouched","good"],["Pruning on next read","dead link removed in passing",""]],
   why:"Heap-Only Tuple updates are why fillfactor and column choice decide update throughput on hot tables like sessions, counters, and queues.",
   tradeoff:"fillfactor 70–80 leaves room in each page for HOT chains but stores fewer rows per page, more pages, more cache pressure on scans.",
   practice:{out:`SELECT relname, n_tup_upd, n_tup_hot_upd,
  round(100.0*n_tup_hot_upd/NULLIF(n_tup_upd,0)) AS hot_pct
FROM pg_stat_user_tables ORDER BY n_tup_upd DESC;
 sessions | upd 12,400,000 | hot 11,900,000 | 96%  <span class="good">← HOT working</span>
 counters | upd  9,800,000 | hot     41,000 | 0.4% <span class="flag">← HOT broken: indexed column in SET, or fillfactor 100</span>`,
   note:"<b>What proves health:</b> hot_pct above ~90% on tables whose updates avoid indexed columns. <b>Red flag:</b> hot_pct under 50% on an update-dominated table, before touching autovacuum, check the SET list of the top updater and the table's fillfactor."},
   detect:"SELECT relname, n_tup_upd, n_tup_hot_upd,\n  round(100.0*n_tup_hot_upd/NULLIF(n_tup_upd,0)) AS hot_pct\nFROM pg_stat_user_tables ORDER BY n_tup_upd DESC;",
   root:"An indexed column appears in the UPDATE's SET list, or fillfactor 100 leaves no free space on the page for the new tuple version, either one breaks HOT eligibility.",
   blast:"Update cost on the hottest table multiplies 5–10×, dead index entries multiply vacuum work by the same factor, and bloat accelerates, while every dashboard attributes it to 'growth'.",
   mit:"Set fillfactor 70–80 on update-heavy tables; keep indexed columns out of hot UPDATE statements (split the row if necessary); alert on hot_pct below ~50%.",
   mistake:"Leaving fillfactor at 100 on an update-heavy table, then fighting the resulting bloat with bigger autovacuum.",
   metric:"HOT percentage below ~50% on a table dominated by updates to non-indexed columns."},
  {eng:"my",title:"MySQL, change buffer and adaptive hash index",
   hook:"Inserting into a secondary index whose leaf page is not in the buffer pool costs <b>one random read (~80 µs–10 ms) just to insert one row</b>. The change buffer records the change in <span class='mono'>ibdata1</span> instead, zero reads, and merges it later, in bulk, when the page is next loaded for any reason. The cost is not removed; it is deferred and moved onto the next reader of that page.",
   problem:"Inserting into a secondary index whose page is not in memory forces a random disk read for every row, unless the change can be deferred.",
   growth:[["Indexes fit in the buffer pool","Change buffer mostly idle; inserts read pages that are already cached.",0],["Cold secondary indexes, steady inserts","Ibuf grows; merges happen in the background as pages cycle through.",0],["Transition: write burst, then a read storm","Every read of a cold page first merges its backlog of buffered changes. Read latency spikes with no change to the read queries.",1],["Production","Post-burst slowdowns get misdiagnosed as 'the reads got slower', and someone disables the change buffer, making the original write problem permanent.",1]],
   diagram:[["Secondary index insert","page not in buffer pool",""],["Change buffer (in ibdata1)","change recorded, no read","good"],["Later: page read / purge / merge","buffered changes applied in bulk",""],["Adaptive hash index","hot search patterns → hash → row pointer","hot"]],
   why:"The change buffer turns random I/O into sequential merge work for non-unique secondary indexes. The adaptive hash index (AHI) silently accelerates repeated exact-match lookups on hot pages.",
   tradeoff:"Change buffer can consume up to 25% of the buffer pool and its merge cost lands on later reads. AHI costs memory and can become a latch hotspot; it helps point lookups, never range scans.",
   practice:{out:`SHOW ENGINE INNODB STATUS\\G  (INSERT BUFFER AND ADAPTIVE HASH INDEX)
Ibuf size 1, free list len 6192, seg size 6194  <span class="c">← buffered changes waiting to merge</span>
Hash table size 4425293, node heap has 812 buffer(s)
15230.44 hash searches/s, 402.11 non-hash searches/s  <span class="good">← AHI serving 97% of searches: it is load-bearing</span>`,
   note:"<b>What proves health:</b> ibuf size fluctuates but trends flat, merges keep pace with inserts. <b>Red flags:</b> ibuf size growing for days without merging (the merge debt will land on readers); a hash-search ratio near 100% on a server where someone proposes disabling AHI from a blog post."},
   detect:"SHOW ENGINE INNODB STATUS\\G\n-- INSERT BUFFER AND ADAPTIVE HASH INDEX:\n-- 'Ibuf size', merges, 'hash searches/s'",
   root:"Write bursts into cold secondary indexes defer merge work; the bill arrives attached to whichever reads touch those pages next.",
   blast:"Reads slow down after write bursts although the read workload did not change, incident effort goes to the wrong queries, and the deferred-merge mechanism that caused it is invisible in per-query statistics.",
   mit:"Leave the change buffer enabled for write-heavy non-unique secondary indexes; size the buffer pool so hot index pages stay resident; watch ibuf size trend after every bulk-load job.",
   mistake:"Disabling the change buffer (or AHI) from a blog post, on a workload that was quietly depending on it.",
   metric:"Ibuf size growing without merging, and the hash vs non-hash search ratio, if hash searches dominate, AHI is load-bearing."}
 ]},
 {t:"Level 3, MVCC: versions, and the cleanup that must keep up",problem:"Readers never block writers because old row versions are kept, and every kept version is storage a background process (VACUUM, purge, WiredTiger reconciliation) must remove later, at a rate one long transaction can reduce to exactly zero.",take:"MVCC failures are almost never MVCC itself: they are one long transaction pinning cleanup, vacuum, purge, or timestamp, while versions pile up behind it.",pairs:[
  {eng:"pg",title:"PostgreSQL, vacuum, freeze, and transaction ID wraparound",
   hook:"Transaction IDs are a <b>32-bit counter: 4.29 billion values</b>, and PostgreSQL treats half that space as 'the past'. A table whose oldest unfrozen transaction ages toward <b>~2.1 billion</b> approaches the point where the database refuses new writes to protect the data. Freezing is not housekeeping, it is recycling the finite counter every future write depends on.",
   problem:"Dead tuples are reusable space only after vacuum, and every transaction ID is borrowed from a finite 32-bit counter that must be recycled by freezing.",
   growth:[["Normal load","Autovacuum freezes as it goes. age(relfrozenxid) stays in the low millions.",0],["Busy tables","Per-table scale factors matter; the biggest table needs its own autovacuum settings.",0],["Transition: one idle-in-transaction session lives for days","Vacuum's horizon is pinned. Dead tuples stop being removable; relfrozenxid age climbs steadily, week over week.",1],["~200M from the limit","Anti-wraparound vacuum arrives as an emergency: aggressive, I/O-heavy, uninvited. Past the limit, writes stop by design.",1]],
   diagram:[["Dead tuples","from UPDATE / DELETE",""],["Autovacuum workers","space reusable + visibility map set",""],["Freeze: xmin → frozen","before age 200M (autovacuum_freeze_max_age)","good"],["Not frozen in time","wraparound risk at ~2.1B xids","hot"]],
   why:"Wraparound is the one PostgreSQL failure that can force a read-only shutdown to protect data. Freeze progress on old, cold tables is a staff-level operational duty, not trivia.",
   tradeoff:"Aggressive per-table autovacuum (lower scale factor on hot tables) spends steady I/O to avoid bloat cliffs. Global-only tuning always loses on the biggest table.",
   practice:{out:`SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;
 appdb | 1,204,551,930  <span class="flag">← past 1 billion: anti-wraparound territory, act now</span>
 appdb |    84,120,553  <span class="good">← healthy: freeze is keeping up</span>

SELECT pid, now()-xact_start AS age, state FROM pg_stat_activity
WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 5;
 <span class="c">← the oldest row here is usually the reason vacuum cannot advance</span>`,
   note:"<b>What proves health:</b> <span class='mono'>age(datfrozenxid)</span> flat or falling week over week. <b>Red flags:</b> the age trending up on any database; an 'idle in transaction' session older than your longest legitimate report."},
   detect:"SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;\nSELECT pid, now()-xact_start AS age, state FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 5;",
   root:"A long-lived transaction (classically 'idle in transaction' from an app server) pins the vacuum horizon, and cold tables are never vacuumed because nothing in them changes, so their freeze age only ever moves in one direction.",
   blast:"Bloat grows on every table the blocker touches; in the limit the database enters protective read-only mode, the one PostgreSQL failure that stops all writes by design, during business hours, with a multi-hour vacuum as the only exit.",
   mit:"Set <span class='mono'>idle_in_transaction_session_timeout</span>; alert on <span class='mono'>age(datfrozenxid)</span> trend per database; per-table autovacuum on hot tables; scheduled freeze vacuum for large cold tables.",
   mistake:"Disabling autovacuum on a busy table to win a benchmark weekend.",
   metric:"age(relfrozenxid) per table trending up week over week, and n_dead_tup growing faster than autovacuum removes it."},
  {eng:"my",title:"MySQL, undo, purge, and the history list",
   hook:"A consistent read that needs an old row version walks the undo chain <b>one record at a time</b>. History list length 1,000,000 means up to a million undo records are being retained because one read view, opened hours ago, might still need them, and every snapshot read on the instance pays longer chains for that one transaction's convenience.",
   problem:"A reader snapshot rebuilds old row versions from undo; undo can only be purged when the oldest open read view no longer needs it.",
   growth:[["Normal load","History list length sits in the hundreds. Purge is invisible.",0],["Longer reports on the primary","Length spikes to ~10k during reports, drains after. Watch it, don't panic.",0],["Transition: one transaction forgotten for hours","Length crosses 100k and stops draining. Undo tablespaces start growing on disk.",1],["Millions","Every consistent read walks long version chains: instance-wide read slowdown with no single slow query to blame.",1]],
   diagram:[["UPDATE","undo record written first",""],["undo_001 / undo_002","old version lives here","hot"],["Read view","rebuilds old version via roll pointer",""],["Purge thread","frees undo when no view needs it","good"]],
   why:"History list length is the InnoDB equivalent of dead tuples: when purge falls behind, every consistent read walks longer version chains and gets slower, instance-wide.",
   tradeoff:"Long analytical transactions on the primary are sometimes convenient, and they tax every other reader. Replicas exist precisely to move this cost off the write path.",
   practice:{out:`SHOW ENGINE INNODB STATUS\\G   (TRANSACTIONS section)
History list length 1,842,311  <span class="flag">← purge is pinned; this is the incident</span>
---TRANSACTION 4213765, ACTIVE 6h 12min, 0 rows modified  <span class="c">← the cause: one read view</span>

SELECT trx_id, trx_started, trx_state FROM information_schema.innodb_trx
ORDER BY trx_started LIMIT 5;  <span class="c">← oldest first: the top row is the suspect</span>`,
   note:"<b>What proves health:</b> history list length drains back to the hundreds after load peaks. <b>Red flags:</b> length above ~10k <i>and still growing</i>; an <span class='mono'>innodb_trx</span> row older than your longest legitimate transaction."},
   detect:"SHOW ENGINE INNODB STATUS\\G\n-- TRANSACTIONS: 'History list length'\nSELECT * FROM information_schema.innodb_trx ORDER BY trx_started LIMIT 5;",
   root:"One long transaction or forgotten session holds the oldest read view, so the purge thread is forbidden from freeing any undo that view might still need.",
   blast:"Undo tablespaces grow without bound, every consistent read on the instance walks longer version chains, and read latency degrades for all users, caused by a single idle connection.",
   mit:"Kill or fix the oldest transaction; move analytical reads to a replica; alert on history list length above ~10k and growing, with the oldest <span class='mono'>trx_started</span> in the alert text.",
   mistake:"Hunting slow queries one by one while a single 6-hour transaction is pinning purge for the whole instance.",
   metric:"History list length above ~10k and still growing. The oldest trx_started in innodb_trx names the culprit."},
  {eng:"mo",title:"MongoDB, WiredTiger checkpoints and snapshot timestamps",
   hook:"Crash recovery time is a division: <b>journal written since the last checkpoint ÷ replay speed</b>. Checkpoints run about every 60 seconds; at 50 MB/s of writes that is up to <b>~3 GB of journal to replay</b> before the node serves again. Separately, a snapshot held open for 1 hour pins every version created in that hour, cleanup of all of them waits for one reader.",
   problem:"The .wt files are only consistent at checkpoints; between them, versions live in cache at timestamps, and a long-lived snapshot pins all of them.",
   growth:[["Normal operation","Checkpoints complete in seconds; pinned timestamps are seconds old.",0],["Longer aggregations","Oldest pinned timestamp ages to minutes during reports. Cache absorbs it.",0],["Transition: a snapshot lives for hours","Versions cannot be freed; cache fills with un-reclaimable data; eviction pressure (Level 1) starts stalling application threads.",1],["Crash in this state","Recovery replays up to a checkpoint interval of journal, minutes of downtime sized by write rate, not by database size.",1]],
   diagram:[["Writes","timestamped versions in cache",""],["Checkpoint (~60 s)","stable blocks → collection-*.wt","good"],["WiredTiger.wt","metadata: last stable checkpoint",""],["Journal","covers everything since checkpoint","hot"]],
   why:"Checkpoint duration and pinned timestamps decide both recovery time and cache health. A snapshot held open by a slow aggregation or change stream quietly blocks version cleanup.",
   tradeoff:"More frequent checkpoints shrink journal replay and recovery time but add steady write I/O; the default 60 s is a balance, not a law.",
   practice:{out:`db.serverStatus().wiredTiger
cache:  "oldest timestamp pinned" : present, age growing  <span class="flag">← a snapshot is holding versions</span>
checkpoint: last checkpoint time lengthening week over week  <span class="c">← more dirty data per checkpoint</span>
transaction: snapshot windows open for hours  <span class="c">← find the reader: aggregation? change stream? backup?</span>`,
   note:"<b>What proves health:</b> checkpoint duration stable and the oldest pinned timestamp seconds-to-minutes old. <b>Red flags:</b> pinned-timestamp age and checkpoint duration trending up <i>together</i>, that pairing points at a long-lived reader, not at the storage layer."},
   detect:"db.serverStatus().wiredTiger\n// read: cache 'oldest timestamp pinned',\n// checkpoint times, transaction snapshot ranges",
   root:"A long-lived snapshot, an hour-long aggregation, a change stream, a backup read, pins the oldest timestamp, and WiredTiger may not free any version newer than it.",
   blast:"Version cleanup stops while writes continue: cache fills with versions nobody can reclaim, eviction stalls application threads, and crash recovery lengthens by exactly the journal accumulated since the last clean checkpoint.",
   mit:"Bound snapshot lifetimes in application code; run long analytical reads against secondaries; alert on oldest-pinned-timestamp age and checkpoint duration together.",
   mistake:"Running hour-long snapshot reads or aggregations against the primary and tuning the cache instead of the reader.",
   metric:"Age of the oldest pinned timestamp and checkpoint duration trending up together."}
 ]},
 {t:"Level 4, Replication and failover: copies that must not lie",problem:"A replica that lags, or a failover that loses acknowledged writes, is worse than no replica, because everyone trusted it.",take:"Replication is a contract: what does an acknowledged write guarantee, and how far behind is the copy right now? GTID, LSN, and optime exist to make both answers exact.",pairs:[
  {eng:"pg",title:"PostgreSQL, WAL streaming and synchronous standbys",
   hook:"The two prices, stated exactly. Synchronous replication adds <b>standby round-trip + standby fsync to every commit</b>: ~0.5–2 ms to a standby in the same region, 30–80 ms across regions. Asynchronous adds <b>0 ms</b>, and on failover loses up to <b>write rate × replay lag</b>: at 2,000 commits/s and 5 s of lag, that is 10,000 acknowledged transactions. There is no third price; every deployment pays one of these two.",
   problem:"Async replication can lose the last transactions in a crash; sync replication can block every commit if the standby disappears.",
   growth:[["Low write rate","Async lag is milliseconds. The loss window is theoretical.",0],["Peak load","Lag is set by standby apply throughput, not the network. Seconds appear.",0],["Transition: the standby dies","Sync: commits hang until it returns or the config changes, the safety feature causes the outage. Async: the loss window grows silently.",1],["Failover with unmeasured lag","Acknowledged writes are gone. The count is discovered from user complaints, not from monitoring.",1]],
   diagram:[["Primary WAL","walsender streams records",""],["Standby walreceiver","writes pg_wal, replays in order",""],["Async: commit returns now","lag = risk window","hot"],["Sync: commit waits for ack","synchronous_standby_names","good"]],
   why:"The sync/async dial is a business decision expressed in config: how many acknowledged writes may a failover lose, zero, or a few seconds worth?",
   tradeoff:"Synchronous commit adds standby RTT + fsync to every commit. Quorum-based ANY 1 of 2 standbys balances safety against one standby taking the whole system down with it.",
   practice:{out:`SELECT client_addr, state, sync_state, replay_lag FROM pg_stat_replication;
 10.0.1.52 | streaming | sync  | 00:00:00.003  <span class="good">← healthy synchronous standby</span>
 10.0.1.53 | streaming | async | 00:00:41.208  <span class="flag">← 41 s of acknowledged writes at risk in a failover</span>
SHOW synchronous_standby_names;  <span class="c">← empty = nobody is synchronous, whatever the runbook says</span>`,
   note:"<b>What proves health:</b> <span class='mono'>sync_state</span> matches the intended design and <span class='mono'>replay_lag</span> at peak load is inside the loss budget the business accepted. <b>Red flags:</b> a sync standby in the same failure domain as the primary; lag measured only at idle times."},
   detect:"SELECT client_addr, state, sync_state, replay_lag FROM pg_stat_replication;\nSHOW synchronous_standby_names; SHOW synchronous_commit;",
   root:"The sync/async choice was left at the default instead of being made as an explicit loss decision, or the synchronous standby shares the primary's availability zone, so one zone event kills both.",
   blast:"Two failure shapes: commits hang instance-wide when a synchronous standby dies (an outage caused by the safety feature), or a failover silently loses seconds of acknowledged writes (data loss caused by its absence).",
   mit:"Quorum <span class='mono'>ANY 1</span> of two standbys in different zones; alert on <span class='mono'>replay_lag</span> at peak write load; measure the commit p99 delta before and after enabling sync so the price is known, not discovered.",
   mistake:"Placing the synchronous standby in the same availability zone and calling it disaster recovery.",
   metric:"replay_lag at peak write load, and commit p99 latency before vs after enabling sync, the true price of zero-loss."},
  {eng:"my",title:"MySQL, GTID and semi-synchronous replication",
   hook:"Failover with GTIDs is set arithmetic: <b>source <span class='mono'>gtid_executed</span> minus replica <span class='mono'>gtid_executed</span> = exactly the transactions the replica lacks</b>. Without GTIDs the same question is answered by comparing binlog file names and byte positions across servers that may have diverged, forensics, not arithmetic. And semi-sync adds one ACK wait per commit, then <b>silently stops adding it after a timeout (default 10 s)</b>.",
   problem:"Position-based replication breaks on failover: which transactions did the new source have that the old one never sent?",
   growth:[["GTID on, semi-sync ON","Failover is arithmetic; the loss window is one ACK.",0],["A network event","Semi-sync times out and degrades to async. Nothing pages; the status variable flips to OFF.",0],["Transition: weeks of silent async","Every dashboard still says 'semi-sync enabled', the plugin is installed and the variable was set once.",1],["Failover","Writes everyone believed replicated are missing on the new source. Divergence surfaces as missing rows days later.",1]],
   diagram:[["Source binlog","every txn gets a GTID",""],["Replica I/O thread","relay log",""],["Applier threads","apply by GTID set",""],["Semi-sync ACK","source waits ≥1 replica before commit returns","good"]],
   why:"GTIDs make failover arithmetic: compare executed GTID sets and the missing transactions are a set difference, not a forensic investigation. Semi-sync closes the async loss window without full group replication.",
   tradeoff:"Semi-sync waits for an ACK per commit (rpl_semi_sync_source_wait_point = AFTER_SYNC is the safe point) but degrades to async silently once its timeout passes, the config keeps saying ON long after the protection is gone.",
   practice:{out:`SHOW STATUS LIKE 'Rpl_semi_sync_source_status';
→ OFF  <span class="flag">← plugin installed, protection OFF: it timed out and degraded</span>
→ ON   <span class="good">← actually waiting for replica ACKs</span>

SELECT @@gtid_executed;  <span class="c">← run on source and replica; the difference is the failover gap</span>
SHOW REPLICA STATUS\\G   <span class="c">← Seconds_Behind_Source + applier state</span>`,
   note:"<b>What proves health:</b> <span class='mono'>Rpl_semi_sync_source_status</span> is ON <i>now</i>, not at install time. <b>Red flags:</b> the status OFF with the enabled variable ON; applier lag (SQL thread) growing while I/O lag stays zero, the replica receives fine and cannot apply fast enough."},
   detect:"SHOW REPLICA STATUS\\G  -- GTID + Seconds_Behind_Source\nSELECT @@gtid_executed;\nSHOW STATUS LIKE 'Rpl_semi_sync%';",
   root:"Semi-sync degraded to asynchronous after a timeout event, and nothing alerted on the status variable, the system's belief about its durability diverged from its actual durability.",
   blast:"A failover loses writes that every dashboard and runbook claimed were replicated; the loss is discovered later as application-level inconsistencies, when the window to reconcile cheaply has closed.",
   mit:"Alert on <span class='mono'>Rpl_semi_sync_source_status != ON</span>; use the AFTER_SYNC wait point; verify GTID set differences as a scripted step of every failover, before promoting.",
   mistake:"Assuming semi-sync is active because the plugin is installed and the variable is set to ON at some point in the past.",
   metric:"Rpl_semi_sync_source_status staying ON and the semi-sync wait time, alongside applier (not I/O) lag on replicas."},
  {eng:"mo",title:"MongoDB, elections, write concern, read concern",
   hook:"Election arithmetic: heartbeats every <b>2 s</b>, an election is called after roughly <b>10 s</b> of silence, and the winner needs a majority of votes <i>and</i> the highest optime among voters. Only majority-committed writes are guaranteed to be on that winner. A <span class='mono'>w: 1</span> write acknowledged <b>5 seconds</b> before the primary died sits exactly inside the window that rolls back.",
   problem:"When the primary dies, the set must elect a replacement that actually holds the acknowledged writes, automatically, at 3 AM.",
   growth:[["Stable set","No elections for months. Concerns feel like ceremony.",0],["First real election","Majority writes survive; any w:1 writes in the final seconds roll back and appear as files in rollback/.",0],["Transition: flapping network or overloaded primary","Repeated elections; each one is a write outage of ~10 s plus a fresh rollback window.",1],["Chronic","Applications see intermittent 'data loss' that is actually rollback of writes that were never majority-safe.",1]],
   diagram:[["Primary","heartbeats every 2 s",""],["Heartbeats stop","election timeout ~10 s","hot"],["Majority votes","most up-to-date member wins",""],["New primary","w:majority writes survive; w:1 may roll back","good"]],
   why:"Elections are why write concern exists: only majority-committed writes are guaranteed present on whoever wins. Read concern majority gives the matching read guarantee.",
   tradeoff:"w: 'majority' + j: true costs the slowest majority member latency on every write. readConcern linearizable is stronger still and should be rare, it is the most expensive read MongoDB offers.",
   practice:{out:`rs.status()  // per member: stateStr + optime lag
 db1  PRIMARY    optime lag 0s    <span class="good">← the writer</span>
 db2  SECONDARY  optime lag 1s    <span class="c">← a viable winner</span>
 db3  SECONDARY  optime lag 47s   <span class="flag">← if this member wins an election, 47 s of writes are at risk</span>
ls $dbPath/rollback/  <span class="c">← any file here = writes that were acknowledged and then rolled back</span>`,
   note:"<b>What proves health:</b> all members within a second or two of optime and an empty <span class='mono'>rollback/</span> directory. <b>Red flags:</b> any election at all (each deserves a postmortem); a member whose lag would make it a data-losing winner."},
   detect:"rs.status()  // states, optime lag per member\nrs.conf()    // election + heartbeat settings\ndb.serverStatus().repl",
   root:"A network partition leaves a primary in the minority still accepting w: 1 writes until it steps down; or read-your-own-write flows are served from secondaries with default concerns, so users read state that a later election erases.",
   blast:"Acknowledged writes disappear after failover, the rollback files are the physical evidence, and users report phantom data loss against a cluster whose own health checks are green.",
   mit:"<span class='mono'>w: 'majority'</span> + <span class='mono'>j: true</span> for writes that must survive elections; readConcern majority for read-your-write flows; postmortem every election and alert on rollback file count.",
   mistake:"Serving read-your-own-write flows from secondaries with default concerns, then reporting phantom data loss.",
   metric:"Election frequency (any is worth a postmortem), per-member optime lag, and rollback file count after incidents."}
 ]},
 {t:"Level 5, Scale: size the log, split the data, bound the window",problem:"One server ends three ways: the log cannot recycle, the data must split, or a copy falls outside the window where catching up is possible.",take:"Scale work is window math: WAL generated per checkpoint, chunks balanced per shard, oplog hours per outage. If you cannot state the window, you do not know your headroom.",pairs:[
  {eng:"pg",title:"PostgreSQL, WAL sizing: max_wal_size is a checkpoint budget",
   hook:"Checkpoint frequency is a division: <b><span class='mono'>max_wal_size</span> ÷ WAL rate</b>. At 100 MB/min of WAL, a 1 GB budget forces a checkpoint every <b>10 minutes</b> of writes, and every checkpoint re-flushes the same hot pages. Raise the budget to 16 GB and the interval becomes <b>~2.7 hours</b>: the same total data written, spread evenly as background I/O instead of arriving in storms.",
   problem:"WAL segments can only be recycled after a checkpoint; write faster than checkpoints complete and the safety log becomes the outage.",
   growth:[["MB of WAL/day","Defaults are fine. Checkpoints are timed, an hour apart.",0],["GB/day","Requested checkpoints appear in pg_stat_bgwriter. Still self-managing, at a price in I/O smoothness.",0],["Transition: hundreds of MB/min","Checkpoint I/O competes with query I/O every few minutes. Latency spikes align with checkpoint starts.",1],["Archive failure at this rate","pg_wal grows unbounded, GB per hour, until the filesystem fills and the primary panics, by design.",1]],
   diagram:[["Write rate","WAL generated per minute",""],["max_wal_size / checkpoint_timeout","whichever hits first triggers checkpoint","hot"],["Checkpoint writes dirty pages","segments before it recycle","good"],["Budget too small","requested checkpoints, I/O storms","hot"]],
   why:"Checkpoint tuning is the most effective PostgreSQL write tuning there is: it converts random write bursts into steady background I/O, or fails to.",
   tradeoff:"Large max_wal_size (tens of GB on busy primaries) smooths I/O but lengthens crash recovery and the disk pg_wal can consume before recycling.",
   practice:{out:`SELECT checkpoints_req, checkpoints_timed FROM pg_stat_bgwriter;
 req = 214   timed = 30  <span class="flag">← 88% of checkpoints are size-triggered: the budget is the problem</span>
SELECT pg_size_pretty(sum(size)) FROM pg_ls_waldir();
 → 14 GB  <span class="c">← current pg_wal footprint; compare against the filesystem, not against zero</span>`,
   note:"<b>What proves health:</b> timed checkpoints dominate and <span class='mono'>pg_wal</span> size is a known, bounded share of its filesystem. <b>Red flags:</b> <span class='mono'>checkpoints_req</span> in the majority; <span class='mono'>pg_wal</span> growth during any archiving error, at production write rates that is a countdown, measured in hours."},
   detect:"SELECT * FROM pg_stat_bgwriter;  -- checkpoints_req vs timed\nSELECT pg_size_pretty(sum(size)) FROM pg_ls_waldir();",
   root:"<span class='mono'>max_wal_size</span> left at an install-era default (1 GB thinking) while the write rate grew by orders of magnitude, or archiving broke, removing the only exit for segments.",
   blast:"Either checkpoint I/O storms every few minutes indefinitely, or the terminal case: <span class='mono'>pg_wal</span> fills the filesystem and the primary panics and stops, a full write outage caused by the durability log itself.",
   mit:"Size <span class='mono'>max_wal_size</span> to hold 1–2 hours of peak WAL; alert on the requested:timed checkpoint ratio and on <span class='mono'>pg_wal</span> as a share of its filesystem; treat any archive failure as urgent at high write rates.",
   mistake:"Setting max_wal_size once at install (often 1 GB default-era thinking) for a primary writing hundreds of MB per minute.",
   metric:"Ratio of requested to timed checkpoints, and peak pg_wal size as a share of the filesystem."},
  {eng:"mo",title:"MongoDB, chunk migration and jumbo chunks",
   hook:"A chunk is capped at <b>128 MB</b> (64 MB in older versions). A chunk whose documents all share <b>one shard-key value</b> cannot be split below that value: a single tenant holding 500 MB under one key is a <b>500 MB jumbo chunk</b> that the balancer will skip on every pass, forever. Adding shards does not help, the unit that needs to move is the one unit that cannot.",
   problem:"Shards only help if data spreads evenly; a range that cannot split migrates forever or never moves at all.",
   growth:[["Small collection","Chunks split and balance automatically. The balancer is boring.",0],["Growth with a good key","Chunk counts per shard stay within ~10% of each other.",0],["Transition: skew appears","Balancer runs nightly; the hot shard's load does not fall. Migration logs show chunks being skipped.",1],["Jumbo established","One shard at 100% while the cluster idles. The fix is no longer tuning, it is a re-shard migration project.",1]],
   diagram:[["mongos","routes by shard key ranges",""],["Balancer","moves chunks off heavy shards",""],["Chunk migration","copy → delta catch-up → cutover",""],["Jumbo chunk","unsplittable range, will not migrate","hot"]],
   why:"A monotonic shard key routes all new writes to one shard; an unsplittable jumbo chunk (one key value holding more than chunk size, default 128 MB) defeats the balancer permanently.",
   tradeoff:"Hashed shard keys spread writes perfectly but scatter range queries to every shard. Ranged keys keep locality and risk hotspots. There is no third option, pick per query pattern.",
   practice:{out:`sh.status()  // chunk distribution per shard
 users  shard01: 412 chunks   shard02: 38 chunks  <span class="flag">← 11:1 skew: the balancer is losing</span>
 jumbo chunks flagged: 7                          <span class="flag">← unsplittable ranges; migration skips these</span>
db.users.getShardDistribution()  <span class="c">← per-shard data + doc counts to confirm</span>`,
   note:"<b>What proves health:</b> chunk counts within ~10% across shards and zero jumbo flags. <b>Red flags:</b> skew growing while the balancer reports active; any jumbo count above zero on a collection still receiving writes."},
   detect:"sh.status()  // chunk counts + jumbo flags\ndb.users.getShardDistribution()\nsh.getBalancerState()",
   root:"The shard key was chosen from the data model, monotonic (timestamps, ObjectIds) or low-cardinality (one whale tenant), instead of from the top five queries the system actually runs.",
   blast:"One shard saturates while the rest of the cluster idles; every remedy that does not change the key distribution (more shards, bigger nodes) changes nothing, and the eventual fix is a data migration under production load.",
   mit:"Choose shard keys from query patterns before launch; prefer hashed or compound keys where locality is not required; alert on chunk-count skew and jumbo count; use refineShardKey where the version supports it.",
   mistake:"Choosing the shard key from the data model instead of from the top five queries, and discovering it after 2 TB.",
   metric:"Chunk count skew across shards, jumbo chunk count, and per-shard operation rates in mongostat --discover."},
  {eng:"mo",title:"MongoDB, the oplog window is your maximum allowed downtime",
   hook:"The window is one division: <b>oplog size ÷ write rate</b>. 10 GB of oplog at 5 MB/min of writes is a <b>34-hour</b> downtime budget. Grow the write rate 10× without resizing and the same 10 GB is <b>3.4 hours</b>, shorter than one routine maintenance. The budget shrinks silently every time the business succeeds; nothing announces it.",
   problem:"A secondary catches up by replaying the oplog; entries older than the window are gone, and gone means a full resync.",
   growth:[["Window measured in days","Maintenance, AZ outages, slow restores all fit comfortably.",0],["Window in tens of hours","Planned work still fits; unplanned double failures start to matter.",0],["Transition: window < longest planned maintenance","The next routine patch window becomes a resync event. Nobody changed the oplog, the write rate changed it.",1],["Member returns after the window","Full initial sync at peak traffic: hours of elevated load on the primary plus a second copy of the dataset in flight.",1]],
   diagram:[["Primary writes","oplog entries appended",""],["local.oplog.rs","capped: fixed size, oldest fall off","hot"],["Secondary down 6 h","window is 2 h → entries missed",""],["Initial sync","full copy, hours, heavy load","hot"]],
   why:"Oplog size divided by write rate is a hard operational budget: maintenance windows, AZ outages, and slow restores must all fit inside it.",
   tradeoff:"A bigger oplog (oplogSizeMB) buys downtime tolerance with disk on every member and longer retention of rolled-back operations to reconcile.",
   practice:{out:`rs.printReplicationInfo()
configured oplog size:   5120 MB
log length start to end: 3.1 hours  <span class="flag">← shorter than the 4 h maintenance planned for Saturday</span>
oplog first event time:  Fri Nov 14 2026 22:03:11 GMT-08:00
oplog last event time:   Sat Nov 15 2026 01:11:48 GMT-08:00  <span class="c">← window = last − first, in wall-clock hours</span>`,
   note:"<b>What proves health:</b> the printed window exceeds your longest planned outage with margin, recomputed at current write rates. <b>Red flag:</b> the window falling month over month while the oplog size never changed, growth is spending the budget."},
   detect:"rs.printReplicationInfo()\n// 'log length start to end' = your window in hours\ndb.getSiblingDB('local').oplog.rs.stats().maxSize",
   root:"The oplog was sized once, as a percentage of disk at install time, and never recomputed after write volume grew, the window is a rate-dependent quantity being managed as a static one.",
   blast:"A routine 4-hour maintenance exceeds a 3-hour window; the member returns to a full initial sync during Monday peak traffic, hours of extra load on the primary and a second full copy of the dataset moving across the network.",
   mit:"Size the oplog so the window exceeds the longest planned maintenance plus margin; resize live with <span class='mono'>replSetResizeOplog</span>; recompute the window monthly against the current write rate and alert when it falls below your maintenance bound.",
   mistake:"Sizing the oplog by disk percentage at install and never recomputing the window after write volume grows 10×.",
   metric:"Oplog window in hours, recomputed monthly against write rate, alert when it falls below your longest planned maintenance."}
 ]}
];
var done={};
var levelsEl=document.getElementById('levels');
function esc(t){return t;}
function renderPair(P){
  var tagCls=P.eng==='pg'?'pg':P.eng==='my'?'my':'mo';
  var tagTxt=P.eng==='pg'?'PostgreSQL':P.eng==='my'?'MySQL · InnoDB':'MongoDB · WiredTiger';
  var flow=P.diagram.map(function(b,i){
    return (i?'<span class="darrow">→</span>':'')+'<div class="dbox '+(b[2]||'')+'"><b>'+b[0]+'</b>'+b[1]+'</div>';
  }).join('');
  var growth=P.growth.map(function(g){
    return '<div class="g'+(g[2]?' hot':'')+'"><b>'+g[0]+'</b>'+g[1]+'</div>';
  }).join('');
  return '<div class="paircard"><span class="tag '+tagCls+'">'+tagTxt+'</span>'+
   '<h4 class="ptitle">'+P.title+'</h4>'+
   '<div class="phook"><span>The number, why this mechanism exists</span>'+P.hook+'</div>'+
   '<div class="pprob"><b>Problem</b><p>'+P.problem+'</p></div>'+
   '<div class="growth">'+growth+'</div>'+
   '<div class="diagram"><p class="dcap">Situation, the physical organization, drawn for this problem</p><div class="dflow">'+flow+'</div></div>'+
   '<div class="staffmeta">'+
   '<div class="sm"><h5>Mechanism, derived from the layout</h5><p>'+P.why+'</p></div>'+
   '<div class="sm"><h5>The tradeoff</h5><p>'+P.tradeoff+'</p></div>'+
   '</div>'+
   '<div class="practice"><h5>In Practice, real output, red flags named</h5><pre class="evidence">'+P.practice.out+'</pre><p class="evnote">'+P.practice.note+'</p><div class="lookcmd">'+P.detect+'</div></div>'+
   '<div class="wib"><h5>Where it breaks</h5><p><b>Root cause:</b> '+P.root+'</p><p><b>Blast radius:</b> '+P.blast+'</p><p><b>Mitigation:</b> '+P.mit+'</p></div>'+
   '<div class="staffmeta">'+
   '<div class="sm warn"><h5>Common staff-level mistake</h5><p>'+P.mistake+'</p></div>'+
   '<div class="sm warn"><h5>The metric that exposes it first</h5><p>'+P.metric+'</p></div>'+
   '</div></div>';
}

var LEVEL_MINS=[15,20,20,25,20,20];
if(levelsEl){LEVELS.forEach(function(L,i){
  var d=document.createElement('div'); d.className='level'+(i===0?' open':''); d.id='lvl'+i;
  d.innerHTML='<button class="level-head" aria-expanded="'+(i===0)+'"><span class="lvl-num">'+i+'</span><span><h3>'+L.t+'</h3><p>Problem: '+L.problem+'</p><span class="lvl-meta">Level '+i+' · about '+LEVEL_MINS[i]+' minutes</span></span></button>'+
  '<div class="level-body"><div class="problem"><b class="label">Problem</b><p>'+L.problem+'</p></div>'+
  '<div class="pairgrid">'+L.pairs.map(renderPair).join('')+'</div>'+
  '<div class="takeaway">Remember: '+L.take+'</div>'+
  '<button class="markbtn" data-lvl="'+i+'">Mark as understood ✓</button></div>';
  levelsEl.appendChild(d);
});
levelsEl.addEventListener('click',function(e){
  var head=e.target.closest('.level-head');
  if(head){var lv=head.parentElement; lv.classList.toggle('open'); head.setAttribute('aria-expanded',lv.classList.contains('open')); return;}
  var mb=e.target.closest('.markbtn');
  if(mb){var i=mb.getAttribute('data-lvl'); done[i]=!done[i];
    document.getElementById('lvl'+i).classList.toggle('done',!!done[i]);
    mb.textContent=done[i]?'✓ Understood, tap to undo':'Mark as understood ✓';
    var n=Object.keys(done).filter(function(k){return done[k]}).length;
    document.getElementById('pfill').style.width=(n/LEVELS.length*100)+'%';
    document.getElementById('plabel').textContent=n+' / '+LEVELS.length+' levels';
    if(done[i]){var nx=document.getElementById('lvl'+(+i+1)); if(nx){nx.classList.add('open');}}
  }
});}
var PAGES={
 pg:[["Page header, 24 bytes","Holds the page's LSN (how far the WAL had got when this page was last written) and a checksum. On recovery, PostgreSQL compares page LSN against WAL position to know what still needs replaying."],
     ["Line pointer array","A small directory at the top: “tuple 1 at offset X, tuple 2 at offset Y”. Indexes point at line pointers, not at tuples directly, so tuples can move inside the page during a VACUUM without breaking index entries."],
     ["Free space","The gap in the middle. New tuples grow from the end, the pointer array grows from the start; they meet when the page is full."],
     ["Tuples (the rows)","Each tuple carries xmin (the transaction that created it) and xmax (the one that deleted or updated it). Those two stamps are the entire MVCC mechanism, a reader compares them against its snapshot."],
     ["Special space","Reserved at the very end, used only by some index page types. Empty on ordinary heap pages."]],
 my:[["FIL header, 38 bytes","Page number, previous/next page in the B+ tree, the page's LSN, and a checksum InnoDB verifies on every read, a torn or corrupt page is detected, not served."],
     ["Index header + system records","Which index this page belongs to (in InnoDB every page belongs to an index, the table IS the clustered index), plus two fixed records: infimum and supremum, the page's lower and upper bounds."],
     ["User records, the rows","Rows in primary-key order. Each record carries a hidden transaction id and a roll pointer into the undo log, that pointer is how InnoDB rebuilds the old version of the row for a reader's snapshot."],
     ["Free space","Room for new records in key order. When a page fills and splits, half the records move to a new page, the reason random-order inserts are expensive."],
     ["Page directory","Slots pointing into the record chain, so a lookup inside the page can binary-search to the right slot instead of walking record by record."]],
 mo:[["Block header","WiredTiger blocks are variable-size and written to a new location each checkpoint, never overwritten in place. The header carries the block's address and a checksum."],
     ["Keys, prefix-compressed","Keys are stored sorted, with shared prefixes stored once. This, plus Snappy compression of values, is why .wt files are much smaller than the same data in memory."],
     ["Values, the documents","Whole BSON documents. A document that outgrows its slot is handled by versioning in the cache and rewritten at the next checkpoint, not patched in place on disk."],
     ["Overflow blocks","Very large values spill into separate overflow blocks so the main B-tree stays shallow and lookups stay fast."],
     ["Reconciliation / checkpoint state","WiredTiger only makes data durable in the .wt files at checkpoints (~60 s). Between checkpoints, durability comes from the journal in journal/WiredTigerLog.*, reads are served from the cache."]]
};
var curEngine='pg';
function renderPage(){
  var box=document.getElementById('pageBox'); box.innerHTML='';
  PAGES[curEngine].forEach(function(r,i){
    var d=document.createElement('div'); if(i===0)d.className='sel';
    d.innerHTML='<b>'+r[0]+'</b>'; d.setAttribute('data-i',i); box.appendChild(d);
  });
  showPageDetail(0);
}
function showPageDetail(i){
  var r=PAGES[curEngine][i];
  document.getElementById('pageDetail').innerHTML='<h4>'+r[0]+'</h4><p style="margin:0;color:var(--muted)">'+r[1]+'</p>';
  document.querySelectorAll('#pageBox div').forEach(function(d,j){d.classList.toggle('sel',j===i)});
}
if(document.getElementById('pageBox')){document.getElementById('pageBox').addEventListener('click',function(e){
  var d=e.target.closest('div'); if(d)showPageDetail(+d.getAttribute('data-i'));
});
document.getElementById('engineSeg').addEventListener('click',function(e){
  var b=e.target.closest('button'); if(!b)return;
  document.querySelectorAll('#engineSeg button').forEach(function(x){x.setAttribute('aria-pressed','false')});
  b.setAttribute('aria-pressed','true'); curEngine=b.getAttribute('data-e'); renderPage();
});
renderPage();}
function fmt(n){return n.toLocaleString('en-US')}
if(document.getElementById('findBtn')){document.getElementById('findBtn').addEventListener('click',function(){
  var key=+document.getElementById('findKey').value||0;
  document.querySelectorAll('.bnode span').forEach(function(s){s.classList.remove('hit')});
  var root=document.querySelector('[data-node="root"]');
  var branch = key<30?0 : key<70?1 : 2;
  var midNodes=document.querySelectorAll('[data-node="mid"]');
  var leafNodes=document.querySelectorAll('[data-node="leaf"]');
  var seq=[root,midNodes[branch],leafNodes[branch]];
  seq.forEach(function(node,idx){
    setTimeout(function(){
      node.querySelectorAll('span').forEach(function(s){ if(+s.getAttribute('data-k')<=key) s.classList.add('hit'); });
      if(idx===2){
        var found=false;
        node.querySelectorAll('span').forEach(function(s){ if(+s.getAttribute('data-k')===key) found=true; });
        document.getElementById('findMsg').textContent = found ?
          'Found '+key+' in 3 page reads: root → internal → leaf.' :
          key+' is not in the tree, and we know after the same 3 reads, because the leaf page is exactly where it would have to be.';
      }
    }, idx*450);
  });
});}
if(document.getElementById('rowRange')){document.getElementById('rowRange').addEventListener('input',function(e){
  var rows=Math.pow(10,+e.target.value);
  document.getElementById('rowLabel').textContent=fmt(rows);
  var depth=Math.max(2,Math.ceil(Math.log(rows/20)/Math.log(400))+1);
  document.getElementById('depthLabel').textContent='tree depth ≈ '+depth+' · a full scan would read ≈ '+fmt(Math.round(rows/100))+' pages';
});
}
var tx={a:false,b:false,committed:100,pending:null,bSnap:null};
var logEl=document.getElementById('mvccLog');
function log(m){logEl.textContent=m}
function renderVers(){
  var html='<div class="ver">Version 1 · balance = 100 · committed ✓</div>';
  if(tx.pending!==null) html+='<div class="ver">Version 2 · balance = '+tx.pending+' · written by A · uncommitted (only A can see it)</div>';
  else if(tx.committed!==100) html+='<div class="ver">Version 2 · balance = '+tx.committed+' · written by A · committed ✓ (version 1 kept until no snapshot needs it, then removed by VACUUM / purge)</div>';
  document.getElementById('versA').innerHTML=html;
}
if(document.getElementById('versA')){document.querySelectorAll('[data-tx]').forEach(function(btn){
  btn.addEventListener('click',function(){
    var a=btn.getAttribute('data-tx');
    if(a==='a-begin'){tx.a=true;log('A began. A\'s snapshot sees the balance as committed now: '+tx.committed+'.');}
    if(a==='b-begin'){tx.b=true;tx.bSnap=tx.committed;document.querySelector('#versB b').textContent='snapshot frozen at '+tx.bSnap;log('B began and took a snapshot at balance '+tx.bSnap+'. Whatever commits later, B keeps reading this version.');}
    if(a==='a-write'){ if(!tx.a){log('BEGIN A first (button 1).');return;} tx.pending=150; renderVers(); log('A updated: a NEW version (150) was created and the change written to the log. Version 1 (100) was NOT overwritten, so B is not disturbed.');}
    if(a==='a-commit'){ if(tx.pending===null){log('Nothing to commit yet, let A run the UPDATE first.');return;} tx.committed=150; tx.pending=null; tx.a=false; renderVers(); log('A committed: the commit record is forced to the log on disk. New transactions now see 150. B, which began earlier, still sees its snapshot. Version 1 will be removed once no snapshot can see it.');}
    if(a==='b-read'){ if(!tx.b){log('BEGIN B first, so B holds a snapshot.');return;} document.querySelector('#versB b').textContent=tx.bSnap+' (snapshot)'; log('B reads: '+tx.bSnap+', even though the latest committed value is '+tx.committed+'. No locking, no waiting, no wrong total. That is snapshot isolation.');}
  });
});
renderVers();}


var REFS=[
 ["pg","Storage","Table files & TOAST","A table must stay fast to scan even when some rows hold huge values.","Every table is one file, base/<db oid>/<relfilenode>, of 8 KB heap pages. A value bigger than ~2 KB is compressed or moved to a side table (TOAST) and replaced by a pointer, so normal rows stay small and pages stay dense.","Find it: SELECT pg_relation_filepath('users'); · \\d+ users"],
 ["my","Storage","users.ibd, the table is the index","Looking up by primary key should need no separate structure at all.","With innodb_file_per_table (default), each table is one .ibd file whose pages form the primary-key B+ tree: rows physically sit in ID order. Sequential IDs append at the end; random IDs insert all over the file and split pages.","Check: ls $datadir/shop/ · SHOW TABLE STATUS"],
 ["mo","Storage","collection-*.wt files & compression","Flexible documents shouldn't cost flexible amounts of disk.","Each collection is one WiredTiger file (collection-*.wt), each index another (index-*.wt). On disk everything is block-compressed (Snappy by default); in the WiredTiger cache it is uncompressed. _mdb_catalog.wt maps names to files.","Check: db.users.stats().wiredTiger.uri"],
 ["all","Storage","The memory cache comes first","Most reads should never touch a disk at all.","All three engines cache hot pages in RAM: PostgreSQL shared_buffers, InnoDB buffer pool, WiredTiger cache (~50% of RAM − 1 GB by default). If the working set doesn't fit, no index or query trick will save you, size memory first.","PG: shared_buffers · MySQL: innodb_buffer_pool_size · Mongo: storage.wiredTiger.engineConfig.cacheSizeGB"],
 ["pg","Indexes","GIN, GiST, BRIN, indexes beyond B-tree","Some questions aren't 'equal to', they're 'contains', 'overlaps', or 'in this range'.","GIN indexes what's inside a value (JSONB keys, array elements, full-text words). GiST handles ranges and geometry. BRIN stores min/max per block range, tiny, and perfect for time-ordered append-only tables.","Try: CREATE INDEX … USING gin (doc) · USING brin (created_at)"],
 ["my","Indexes","Covering index","A lookup shouldn't open the table file if the index already has the answer.","If every column the query needs is in the secondary index, InnoDB answers from the index alone, EXPLAIN shows “Using index”. The index stores the primary key, so non-covered lookups hop index → clustered row.","Try: EXPLAIN SELECT name FROM users WHERE name='Asha';"],
 ["mo","Indexes","Compound index order, the ESR rule","A combined index silently stops helping if its fields are in the wrong order.","Derived, not conventional: a compound B-tree stores keys sorted by field 1, then within equal field-1 values by field 2, then by field 3. Equality on field 1 therefore collapses the scan to one contiguous range (O(log N) to locate); within that range field 2 is already in stored sort order, so no SORT stage is needed; a range predicate ends the usable ordering, so range fields must come last or they destroy the sort guarantee for everything after them. Equality → Sort → Range (ESR) is the only order preserving all three. Full derivation in 'Reading the evidence' above.","Try: db.users.find(…).explain('executionStats'), check totalDocsExamined ÷ nReturned"],
 ["all","Indexes","Partial (filtered) index","Indexing rows nobody ever searches for wastes disk and slows every write.","Index only the rows that match a condition, e.g. only active users, WHERE deleted_at IS NULL. PostgreSQL and MongoDB support it directly; smaller index = faster writes and faster lookups.","PG: CREATE INDEX … WHERE active · Mongo: partialFilterExpression"],
 ["pg","Safety","VACUUM & autovacuum","UPDATE and DELETE leave dead row versions behind; something must reclaim them or files bloat forever.","VACUUM marks dead-tuple space reusable and updates the visibility map; autovacuum runs it automatically per table. If it falls behind, tables and indexes bloat, and in the extreme, transaction ID wraparound forces a shutdown. Never disable it.","Check: SELECT relname, n_dead_tup FROM pg_stat_user_tables;"],
 ["my","Safety","Undo log & purge","Readers need old row versions, and failed transactions need to be undone, both come from the same place.","InnoDB writes undo records (in undo_001/undo_002 tablespaces) before modifying a row. A reader's snapshot rebuilds old versions from them; rollback replays them in reverse. The purge thread deletes undo only when no open transaction can still need it, one long transaction makes undo grow without bound.","Watch: “History list length” in SHOW ENGINE INNODB STATUS"],
 ["mo","Safety","Oplog size & the replication window","A secondary that was down must be able to catch up without copying the whole database.","Secondaries catch up by replaying local.oplog.rs, a capped collection. If downtime exceeds the window the oplog covers (size ÷ write rate), the needed entries have rolled off and the member must do a full initial sync.","Try: rs.printReplicationInfo(), 'log length start to end' is your window"],
 ["all","Safety","Isolation levels","When two transactions touch the same rows, someone must decide what each is allowed to see.","Levels trade surprises for speed: Read Committed (fresh snapshot per statement), Repeatable Read (one snapshot per transaction), Serializable (as if transactions ran one at a time; PostgreSQL may abort one to keep that promise). Know your engine's default before debugging 'weird reads'.","Defaults: PG Read Committed · InnoDB Repeatable Read · Mongo snapshot (primary)"],
 ["pg","Copies","Streaming vs logical replication","Sometimes you need an exact clone; sometimes you need only some tables, on a different version.","Streaming replication ships WAL bytes, the standby must be the same version and ends up byte-identical. Logical replication decodes WAL into per-table row changes, use it for major-version upgrades and selective copies.","Check: pg_stat_replication · pg_stat_subscription"],
 ["my","Copies","Binlog + GTID","A replica must always know exactly which transactions it has applied, no guessing after a failover.","Every transaction committed with the binlog on gets a GTID (server UUID + sequence). A replica records the GTIDs it has executed, so reconnecting or promoting is arithmetic, not archaeology. Use ROW binlog format for exactness.","Try: SHOW REPLICA STATUS\\G · SELECT @@gtid_executed;"],
 ["mo","Copies","Elections & majority write concern","If the primary dies at 3 AM, the replica set must recover without a human.","Members heartbeat each other; if the primary is unreachable, the most up-to-date secondaries elect a new one. writeConcern w:'majority' means an acknowledged write exists on a majority of members, so it survives any single election. Pair with j:true for journal durability.","Try: rs.conf() · rs.status() · { writeConcern: { w: 'majority', j: true } }"],
 ["mo","Growing","Shard key","Data must spread across servers evenly, and queries must land on as few of them as possible.","The shard key is the field(s) mongos uses to route each document. Hashed keys spread perfectly but range queries scatter to all shards; ranged keys keep neighbours together but risk hotspots. Refining a shard key is possible in newer versions, but the original choice is close to permanent.","Try: sh.status() · sh.shardCollection('shop.users', {region: 1, _id: 1})"],
 ["pg","Growing","Declarative partitioning","Old data should be droppable in milliseconds, and queries on recent data shouldn't scan history.","One logical table, many physical files, PARTITION BY RANGE (created_at) gives each month its own file. Dropping a month = DROP TABLE on one partition. Queries with a date filter are pruned to the relevant partitions only.","Try: CREATE TABLE … PARTITION BY RANGE (created_at);"],
 ["my","Growing","Vitess & ProxySQL","MySQL has no built-in sharding, something has to route queries when data spans servers.","Vitess (built at YouTube) sits between app and MySQL, routes each query to the right shard by keyspace ID, and manages topology. ProxySQL is the lighter tool: connection pooling, read/write splitting, and query routing without sharding.","Pattern: app → ProxySQL/Vitess → the right mysqld"],
 ["all","Speed","Connection pooling","Thousands of app connections crush every engine, each one costs memory and bookkeeping.","A pooler keeps a small set of real connections and multiplexes app sessions onto them: PgBouncer (PostgreSQL), ProxySQL (MySQL), or the driver's maxPoolSize (MongoDB). Measure queue wait at the pooler, not just query time.","PG: PgBouncer · MySQL: ProxySQL · Mongo: maxPoolSize"],
 ["all","Speed","Slow query logs","You can't fix the slow queries you haven't identified.","Each engine can log statements over a time threshold, with rows examined: PostgreSQL log_min_duration_statement, MySQL slow_query_log (+ pt-query-digest), MongoDB profiler (db.setProfilingLevel). The fix order is almost always: missing index → bad plan from stale stats → chatty app.","PG: log_min_duration_statement · MySQL: long_query_time · Mongo: db.setProfilingLevel(1, {slowms: 100})"],
 ["pg","Under the hood","WAL & checkpoints","The WAL can't grow forever; dirty pages must eventually reach their files so segments can be recycled.","A checkpoint writes all dirty pages in shared_buffers to their heap/index files and records the point in pg_control; WAL segments before it are renamed and reused. Checkpoints too frequent (max_wal_size too small) = I/O storms; too rare = slow crash recovery.","Tune: max_wal_size, checkpoint_timeout · Inspect: pg_waldump, pg_stat_bgwriter"],
 ["my","Under the hood","Redo log & doublewrite buffer","A committed change must survive a crash, and a page being written during the crash must not end up torn in half.","Redo (ib_logfile0/1, or #innodb_redo/ in 8.0.30+) replays page changes after a crash. The doublewrite buffer (#ib_16384_*.dblwr) writes each flushed page to a safe area first, then to its real place; on recovery a torn page is restored from the doublewrite copy.","Tune: innodb_redo_log_capacity · innodb_flush_log_at_trx_commit = 1"],
 ["mo","Under the hood","Journal & checkpoints","Data files are only consistent at checkpoints, something must cover the minutes in between.","Every write goes to journal/WiredTigerLog.* first (group-committed, up to every 100 ms by default). A checkpoint (~60 s) writes a consistent snapshot of all dirty pages into the .wt files; restart = last checkpoint + journal replay. j:true makes a write wait for the journal specifically.","Check: ls journal/ · storage.journal.commitIntervalMs"],
 ["all","Under the hood","Statistics & the planner","A planner choosing from stale statistics will pick a full scan for a needle, the classic 'slow overnight, no deploy' bug.","Planners cost plans from row counts and value histograms: PostgreSQL ANALYZE (autovacuum runs it), MySQL ANALYZE TABLE, MongoDB updates stats on index builds. After bulk loads or big deletes, refresh stats before blaming the query.","PG: ANALYZE · MySQL: ANALYZE TABLE · Mongo: db.collection.stats()"]
];
var REF_EXTRA={
"Table files & TOAST":{d:["Heap page 8 KB","Value > ~2 KB → TOAST side table","Normal rows stay dense"],tr:"TOAST keeps scans fast but a wide-row read pays an extra fetch; compress first, out-of-line second.",br:"Huge values inline in your mental model only, check pg_column_size() and TOAST size in \\d+; a bloated TOAST table shows up as slow point reads on wide rows."},
"users.ibd, the table is the index":{d:["Insert id=42","Leaf page in PK order","Row lives in the tree"],tr:"Clustered storage makes PK lookups one walk, but every secondary index stores the PK and random PKs fragment the whole table.",br:"Random UUID PKs → page splits and a file far bigger than the data. Detect: SHOW TABLE STATUS (Data_free) and fragmentation in information_schema."},
"collection-*.wt files & compression":{d:["Document in cache (raw)","Checkpoint","Compressed blocks in collection-*.wt"],tr:"Compression saves disk and I/O but costs CPU; cache holds the uncompressed form, so RAM, not disk size, is the working-set limit.",br:"Assuming disk size equals memory need. Detect: db.users.stats() storageSize vs size, and cache pressure in serverStatus().wiredTiger.cache."},
"The memory cache comes first":{d:["Query","Cache hit → answer","Miss → disk read + cache fill"],tr:"Cache sized for the working set beats any query tuning; oversizing starves the OS cache these engines also use.",br:"Working set outgrows RAM → hit ratio falls off a cliff. Detect per engine: pg_statio_user_tables, buffer pool hit ratio in INNODB STATUS, WT cache bytes read into cache."},
"GIN, GiST, BRIN, indexes beyond B-tree":{d:["Question: contains / overlaps / range","GIN · GiST · BRIN","Right rows only"],tr:"Specialized indexes answer questions B-trees cannot, but each adds write cost; BRIN is nearly free yet only works when physical order matches value order.",br:"Using a B-tree on a JSONB containment query → seq scan forever. Detect: EXPLAIN shows Seq Scan on a query with @> or && operators."},
"Covering index":{d:["Secondary index","Key + PK stored in leaf","Answer without the clustered row"],tr:"Wider covering indexes speed one query and tax every write; cover the top queries, not all of them.",br:"EXPLAIN loses 'Using index' after a column is added to the SELECT list. Detect: watch Extra in EXPLAIN for the top 5 queries after every deploy."},
"Compound index order, the ESR rule":{d:["Equality fields","Sort fields","Range fields"],tr:"One compound index serves a family of queries only in ESR order; the wrong order silently serves half the query.",br:"Index exists but explain shows a COLLSCAN or huge docsExamined. Detect: explain('executionStats'), index used yet totalDocsExamined >> nReturned."},
"Partial (filtered) index":{d:["All rows","Only active rows indexed","Smaller index, faster writes"],tr:"Smaller and faster, but the query filter must match the index predicate exactly or the planner cannot use it.",br:"Query adds one extra condition and the partial index is ignored. Detect: EXPLAIN before/after, look for the index name disappearing."},
"VACUUM & autovacuum":{d:["Dead tuples","Autovacuum","Reusable space + frozen xids"],tr:"Steady background I/O now versus bloat and wraparound risk later; per-table tuning beats global on any uneven workload.",br:"Long transactions block it → bloat + age(datfrozenxid) climbing. Detect: pg_stat_user_tables n_dead_tup and pg_database age(datfrozenxid)."},
"Undo log & purge":{d:["UPDATE","Undo record in undo_001","Purge when no read view needs it"],tr:"Undo enables consistent reads without locking, priced as purge debt that one long transaction can make unbounded.",br:"History list length in the millions. Detect: SHOW ENGINE INNODB STATUS, TRANSACTIONS section; oldest entry in information_schema.innodb_trx."},
"Oplog size & the replication window":{d:["Writes","local.oplog.rs (capped)","Window = size ÷ write rate"],tr:"Bigger oplog buys downtime tolerance with disk on every member; the window must exceed your longest planned outage.",br:"Secondary returns after the window → full initial sync at peak. Detect: rs.printReplicationInfo() 'log length start to end'."},
"Isolation levels":{d:["Two txns, same rows","Level decides what each sees","Anomalies allowed vs retries paid"],tr:"Stronger isolation removes surprises and adds aborts/retries; weaker is faster and pushes correctness into the application.",br:"Debugging 'impossible' reads without knowing the default. Detect: SHOW transaction_isolation (PG) / @@transaction_isolation (MySQL) before anything else."},
"Streaming vs logical replication":{d:["WAL bytes → byte-identical standby","Decoded row changes → selective copy","Pick per upgrade / subset need"],tr:"Streaming is exact and version-locked; logical is flexible (subsets, major upgrades) and needs primary keys plus conflict thinking.",br:"Logical replica without PKs → full scans per update. Detect: pg_stat_subscription lag and REPLICA IDENTITY on source tables."},
"Binlog + GTID":{d:["Commit","Binlog event + GTID","Replica executes by GTID set"],tr:"ROW format is exact and heavier; STATEMENT is light and can diverge on nondeterministic functions. GTID makes failover set arithmetic.",br:"gtid_executed differs unexpectedly after failover. Detect: SELECT @@gtid_executed on both sides; SHOW REPLICA STATUS\\G."},
"Elections & majority write concern":{d:["Primary lost","Majority elects","w:majority writes survive"],tr:"Majority concern prices every write at the slowest majority member; anything weaker can roll back and must be treated as provisional.",br:"Rollback files appear after an election. Detect: rs.status() states/optimes and ls of the rollback/ directory in dbPath."},
"Shard key":{d:["Document","mongos routes by shard key","One shard (good) or all shards (scatter)"],tr:"Hashed spreads writes, ranged keeps locality; the choice is near-permanent, so it is made from query patterns, not from the schema diagram.",br:"Jumbo chunks + one hot shard. Detect: sh.status() chunk distribution and jumbo flags; getShardDistribution()."},
"Declarative partitioning":{d:["Parent table","Pruning by range","One month = one file, dropped whole"],tr:"Partitioning makes retention and pruning cheap but adds planning overhead per partition; hundreds of partitions need discipline.",br:"Query without the partition key scans every partition. Detect: EXPLAIN shows all partitions under Append instead of a pruned few."},
"Vitess & ProxySQL":{d:["App","ProxySQL / Vitess routes","Right mysqld shard"],tr:"A routing layer buys sharding and pooling at the cost of another system to run, upgrade, and debug at 3 AM.",br:"Read/write splitting sends a just-written read to a lagging replica. Detect: ProxySQL stats + replica lag during the complaint window."},
"Connection pooling":{d:["1,000 app sessions","Pooler multiplexes","~cores-sized real connections"],tr:"Pooling caps DB load but adds queueing at the pooler; transaction pooling breaks session state (prepared statements, SET) if misused.",br:"Pool queue wait exceeds query time. Detect: PgBouncer SHOW POOLS cl_waiting, ProxySQL connection pool stats, driver maxPoolSize vs currentOp count."},
"Slow query logs":{d:["Every statement","Over threshold → logged","Digest → top by total time"],tr:"Logging everything costs overhead; logging nothing costs blindness. Threshold + digest review is the working compromise.",br:"Fixing by mean time instead of total time. Detect: pg_stat_statements / events_statements_summary_by_digest ordered by total, not average."},
"WAL & checkpoints":{d:["Dirty pages in shared_buffers","Checkpoint","WAL segments recycle"],tr:"Frequent checkpoints = I/O storms; rare = slow recovery and a huge pg_wal. max_wal_size is the budget knob.",br:"checkpoints_req > 0 daily. Detect: pg_stat_bgwriter / pg_stat_checkpointer and pg_ls_waldir() size."},
"Redo log & doublewrite buffer":{d:["Dirty page flush","Doublewrite copy first","Real place second, torn page recoverable"],tr:"Doublewrite costs an extra write per flush to make torn pages impossible to serve; disabling it on non-atomic storage is gambling.",br:"Checkpoint age near redo capacity → flush stalls. Detect: SHOW ENGINE INNODB STATUS LOG + FILE I/O sections."},
"Journal & checkpoints":{d:["Write","journal/WiredTigerLog.*","Checkpoint ~60 s makes .wt consistent"],tr:"Journal group-commit batches fsyncs (up to 100 ms window); j:true removes the batching risk for that write at latency cost.",br:"Crash loses up to the checkpoint gap when journaling is off or misdirected. Detect: ls journal/ and storage.journal.enabled in getCmdLineOpts."},
"Statistics & the planner":{d:["Table changes","ANALYZE refreshes histograms","Planner costs plans from fresh stats"],tr:"Auto-analyze lags after bulk loads; manual ANALYZE after a big import is cheaper than a night of wrong plans.",br:"Plan flips to seq scan the morning after a bulk load. Detect: compare EXPLAIN estimated vs actual rows; check last_analyze in pg_stat_user_tables."}
};
var refFilter='all';
function renderRefs(){
  var q=(document.getElementById('refSearch').value||'').toLowerCase();
  var grid=document.getElementById('refGrid'); grid.innerHTML=''; var n=0;
  REFS.forEach(function(r){
    var eng=r[0],topic=r[1],title=r[2],solves=r[3],body=r[4],knob=r[5];
    if(refFilter!=='all'&&eng!=='all'&&eng!==refFilter)return;
    var hay=(title+' '+solves+' '+body+' '+topic+' '+knob).toLowerCase();
    if(q&&hay.indexOf(q)===-1)return;
    n++;
    var tagCls=eng==='pg'?'pg':eng==='my'?'my':eng==='mo'?'mo':'all';
    var tagTxt=eng==='pg'?'PostgreSQL':eng==='my'?'MySQL':eng==='mo'?'MongoDB':'All 3';
    var d=document.createElement('div'); d.className='refcard';
    var X=REF_EXTRA[title]||{d:["Problem","Structure","Effect"],tr:"Every mechanism here is paid for on writes and repaid on reads, size it from measured workload, not defaults.",br:"Detect with the command below before changing any setting."};
    var dflow=X.d.map(function(b,i){return (i?'<span class="darrow">→</span>':'')+'<div class="dbox">'+b+'</div>';}).join('');
    d.innerHTML='<div><span class="tag '+tagCls+'">'+tagTxt+'</span><span class="tag all">'+topic+'</span></div><h4>'+title+'</h4><p class="solves">Problem: '+solves+'</p><div class="refdiag"><p class="dcap">Diagram, one problem, one diagram</p><div class="dflow">'+dflow+'</div></div><p class="body">'+body+'</p><div class="refextra"><p><b>Tradeoff:</b> '+X.tr+'</p><p><b>What breaks &amp; the check:</b> '+X.br+'</p></div><div class="knob">'+knob+'</div>';
    grid.appendChild(d);
  });
  document.getElementById('refCount').textContent=n+' idea'+(n===1?'':'s')+' shown';
  if(n===0){grid.innerHTML='<p style="color:var(--muted)">No match. Try a real name: “wal”, “binlog”, “ibd”, “oplog”, “vacuum”, or a problem word like “crash” or “slow”.</p>';}
}
if(document.getElementById('refGrid')){document.getElementById('refSearch').addEventListener('input',renderRefs);
document.getElementById('refSeg').addEventListener('click',function(e){
  var b=e.target.closest('button'); if(!b)return;
  document.querySelectorAll('#refSeg button').forEach(function(x){x.setAttribute('aria-pressed','false')});
  b.setAttribute('aria-pressed','true'); refFilter=b.getAttribute('data-f'); renderRefs();
});
renderRefs();}
var QUIZ=[
 ["COMMIT returned in 1 ms, but the table's data file hasn't been written yet. Why is the row still safe?","Because the change was forced to disk in the log first, pg_wal / ib_logfile0 / journal, and a crash replays the log to rebuild the data pages.",["The database promises to write the file soon","Because the change was forced to disk in the log first, pg_wal / ib_logfile0 / journal, and a crash replays the log to rebuild the data pages.","Because a replica confirmed it in memory"]],
 ["In MySQL, why do random UUID primary keys hurt as the table grows?","Rows are stored in primary-key order inside the .ibd file, so random keys insert all over it, splitting pages and wasting space.",["UUIDs are too long to index","Rows are stored in primary-key order inside the .ibd file, so random keys insert all over it, splitting pages and wasting space.","InnoDB can't index UUID columns"]],
 ["You need a correct report total while other people are still updating accounts. Cheapest safe way?","Run it in one transaction at a snapshot isolation level, it reads row versions as of one moment, without locking anyone.",["Lock the whole table until the report finishes","Run it in one transaction at a snapshot isolation level, it reads row versions as of one moment, without locking anyone.","Run the report twice and average the results"]],
 ["A PostgreSQL table keeps growing and slowing down despite few live rows. SELECT shows a huge n_dead_tup. Cause?","Lots of UPDATEs/DELETEs plus autovacuum not keeping up, so dead tuples pile up in the heap file.",["The index needs rebuilding every week","The disk is fragmented","Lots of UPDATEs/DELETEs plus autovacuum not keeping up, so dead tuples pile up in the heap file."]],
 ["In MongoDB you query by region, but the shard key is user ID only. What happens to the query?","mongos must scatter it to every shard, because each shard holds some of every region's documents.",["It uses the _id index on one shard","mongos must scatter it to every shard, because each shard holds some of every region's documents.","The query is rejected for not using the shard key"]],
 ["A MongoDB secondary was down for 6 hours, but the oplog window is only 2 hours. What happens when it returns?","It cannot catch up from the oplog, the entries it missed have rolled off the capped collection, so it must do a full initial sync.",["It replays the journal to catch up","It catches up from the primary's data files directly","It cannot catch up from the oplog, the entries it missed have rolled off the capped collection, so it must do a full initial sync."]]
];
var score=0,answered=0;
var quizEl=document.getElementById('quiz');
if(quizEl){QUIZ.forEach(function(Q,qi){
  var d=document.createElement('div'); d.className='quizq';
  d.innerHTML='<p>'+(qi+1)+'. '+Q[0]+'</p><div class="opts"></div><div class="why"><b>In one line:</b> '+Q[1]+'</div>';
  var opts=d.querySelector('.opts');
  Q[2].forEach(function(o){
    var b=document.createElement('button'); b.textContent=o;
    b.addEventListener('click',function(){
      if(d.classList.contains('answered'))return;
      d.classList.add('answered'); answered++;
      if(o===Q[1]){b.classList.add('right'); score++;}
      else{b.classList.add('wrong'); opts.querySelectorAll('button').forEach(function(x){if(x.textContent===Q[1])x.classList.add('right')});}
      document.getElementById('quizScore').textContent='Score: '+score+' / '+answered+' answered'+(answered===QUIZ.length?(score>=5?', you can reason about real database files like an architect now.':score>=3?', solid. Re-run the insert walkthrough and check the log-file cards once more.':', good start. Walk the 6 levels once more, slowly.'):'');
    });
    opts.appendChild(b);
  });
  quizEl.appendChild(d);
});}
/* ===== INSERT, END TO END ===== */
var INS_SQL={
 pg:"INSERT INTO users (id, name) VALUES (42, 'Asha');",
 my:"INSERT INTO users (id, name) VALUES (42, 'Asha');",
 mo:"db.users.insertOne({ _id: 42, name: 'Asha' })"
};
var INS_META={
 pg:{stages:["libpq / JDBC / driver","backend process","pg_wal/","shared_buffers","users_pkey file","checkpoint + WAL stream"],
     panels:["pg_wal/000000010000000000000003, WAL segment, on disk","Heap page, shared_buffers → base/16384/16397","users_pkey, index file base/16384/16405","Replica, replaying the WAL stream"]},
 my:{stages:["MySQL protocol / driver","server thread + InnoDB","ib_logfile0 + mysql-bin","buffer pool","users.ibd (the table file)","checkpoint + binlog pull"],
     panels:["Redo log ib_logfile0 · binlog mysql-bin.000007, on disk","Buffer pool page, → shop/users.ibd","Secondary indexes, inside users.ibd","Replica, applying binlog events by GTID"]},
 mo:{stages:["driver (wire protocol)","mongod (primary)","journal/WiredTigerLog.*","WiredTiger cache","index-*.wt files","checkpoint + oplog tail"],
     panels:["journal/WiredTigerLog.0000000123, on disk","WiredTiger cache page, → collection-2-….wt","_id index, index-3-….wt","Secondary, applying local.oplog.rs"]}
};
var INS_STEPS={
pg:[
 {s:0,t:"The app sends one line of SQL",d:"Your app sends the INSERT over one open connection (libpq, JDBC, or a driver). A PostgreSQL backend process picks it up. Nothing is saved yet, so far this is just a request travelling down a wire.",log:null,page:0,index:0,rep:0},
 {s:1,t:"The server parses it and checks the catalog",d:"PostgreSQL parses the statement, then checks pg_catalog: table users exists, 42 fits the integer id column, 'Asha' fits the text column, and this role may write here. A typo or wrong type dies right here, before a single byte is written anywhere.",log:null,page:0,index:0,rep:0},
 {s:1,t:"The work gets a transaction ID",d:"PostgreSQL stamps this work with a transaction ID, say xid 801. Every change this transaction makes carries 801, and pg_xact will record whether 801 committed. This stamp is the whole secret behind snapshots (Diagram 3).",log:null,page:0,index:0,rep:0},
 {s:1,t:"The right page is found, memory first",d:"Rows live in 8 KB pages inside the table file base/16384/16397. PostgreSQL looks in shared_buffers for a page of users with free space. Found in memory = instant. Not there = that one page is read from the file once, then all work happens in memory.",log:null,page:1,index:0,rep:0},
 {s:2,t:"The WAL record is written FIRST",d:"Before the page itself is touched, the change is described in the Write-Ahead Log: a record lands in the current pg_wal segment (16 MB files like 000000010000000000000003) saying “xid 801 inserted (42, 'Asha') into users”. The golden rule of every engine on this page: the log record must reach disk before the data page ever needs to.",log:"pg_wal/…0003 · xid 801 · INSERT users (42, 'Asha')",page:1,index:0,rep:0},
 {s:3,t:"The row is placed inside the page",d:"Now the tuple itself is written into free space in the page in shared_buffers, a line pointer is added pointing at it, and the tuple is stamped xmin = 801 (“created by xid 801”). The page is now dirty, changed in memory, not yet in base/16384/16397. That is fine, because of step 5.",log:null,page:2,index:0,rep:0},
 {s:4,t:"Every index file gets a pointer to it",d:"For each index on the table, PostgreSQL walks that index's own B+ tree file (about 3 page reads, Diagram 2) and slots in an entry: users_pkey gets 42 → “page 7, line pointer 3”. If 42 already existed in the unique index, the insert fails right here and everything is undone. Three indexes? This step happens three times, that is why extra indexes make inserts slower.",log:null,page:2,index:1,rep:0},
 {s:2,t:"COMMIT, the WAL is forced to disk",d:"The app says COMMIT. PostgreSQL fsyncs the WAL up to the commit record for xid 801, and only then replies “done”. Notice: the data page may still be sitting in shared_buffers. It does not matter. The WAL on disk can rebuild it after any crash, even a power cut.",log:"pg_wal/…0003 · xid 801 · COMMIT · LSN 0/3A4F8C0 ✓ fsynced",page:2,index:1,rep:0},
 {s:3,t:"Now, and only now, others can see row 42",d:"Because xid 801 is now recorded as committed in pg_xact, anyone who starts reading from this moment sees the row. Anyone who started earlier still sees their old snapshot without it. Nobody was ever locked out, and nobody ever saw a half-finished insert.",log:null,page:3,index:1,rep:0},
 {s:5,t:"The WAL is streamed to the replica",d:"A walsender process streams the very same WAL records over the network to the standby, which replays them in order and ends up byte-identical, row 42 included. Normally this trails by milliseconds; watch it in pg_stat_replication. (With a synchronous standby, step 8 would have waited for this before saying “done”.)",log:null,page:3,index:1,rep:1},
 {s:5,t:"Later, quietly: a checkpoint writes the page to its file",d:"In the background, a checkpoint writes the dirty page into base/16384/16397, records the new position in global/pg_control, and the old WAL segments get recycled. Much later, autovacuum tidies dead tuples. The insert was already permanent back at step 8, this is just housekeeping catching up.",log:null,page:3,index:1,rep:1}
],
my:[
 {s:0,t:"The app sends one line of SQL",d:"Your app sends the INSERT over one open connection and a MySQL server thread picks it up. Nothing is saved yet, it is just a request.",log:null,page:0,index:0,rep:0},
 {s:1,t:"The server parses it and checks the data dictionary",d:"MySQL parses the statement and checks its data dictionary: table users exists in schema shop, 42 fits the id column, 'Asha' fits the name column. Errors stop here, before anything is written.",log:null,page:0,index:0,rep:0},
 {s:1,t:"A transaction starts, and an undo record is prepared",d:"InnoDB opens a transaction and writes an undo record (into the undo tablespaces, undo_001/undo_002): how to reverse this insert if it fails. Undo is also what lets other readers rebuild the old version of a row while this one is mid-change.",log:"undo_001 · undo record: how to reverse this insert",page:0,index:0,rep:0},
 {s:1,t:"The right leaf page is found, memory first",d:"In InnoDB the table IS its primary-key index: rows live inside the B+ tree in shop/users.ibd, sorted by id. InnoDB looks in the buffer pool for the leaf page where 42 belongs, between 25 and 87. Miss in memory = read that 16 KB page from users.ibd once.",log:null,page:1,index:0,rep:0},
 {s:2,t:"The redo record is written FIRST",d:"Before the page changes, a redo record describing the page change goes into the redo log buffer, on its way to ib_logfile0 (or #innodb_redo/ on 8.0.30+): the same write-ahead trick PostgreSQL calls WAL. If MySQL crashes, redo replays every change that was promised. The page itself can stay in the buffer pool, the log is the guarantee.",log:"ib_logfile0 · redo · INSERT (42, 'Asha') into users",page:1,index:0,rep:0},
 {s:3,t:"The row goes straight into the sorted tree",d:"The row is written into the leaf page, in id order, between 25 and 87. No separate heap file, the row's home is the index itself, inside users.ibd, which is why primary-key lookups are one short walk. If the page is full it splits in two and the tree rebalances, correct, but a burst of splits is why random, out-of-order IDs insert slowly.",log:null,page:2,index:1,rep:0},
 {s:4,t:"Each secondary index gets a small entry",d:"Every secondary index (say, on name) lives inside the same users.ibd file and gets its own entry: 'Asha' → 42. It stores the primary key, not the row, so a lookup by name then hops to the clustered tree. A duplicate in a unique index fails the whole insert here.",log:null,page:2,index:1,rep:0},
 {s:2,t:"The binlog event is written; redo + binlog flush together",d:"MySQL also appends the change to the binary log, mysql-bin.000007, stamped with a GTID (a permanent transaction ID). At COMMIT, redo and binlog are flushed to disk in one coordinated two-phase commit (innodb_flush_log_at_trx_commit=1, sync_binlog=1), so InnoDB and the binlog can never disagree about whether row 42 exists.",log:"mysql-bin.000007 · GTID 3E11FA47…:23 · INSERT (42, 'Asha') · COMMIT ✓",page:2,index:1,rep:0},
 {s:3,t:"COMMIT returns, row 42 is visible",d:"Only after those flushes does the app hear “done”. Readers now see the row, subject to isolation: someone mid-report on Repeatable Read still sees their snapshot without it.",log:null,page:3,index:1,rep:0},
 {s:5,t:"Replicas pull and replay the binlog",d:"Each replica's I/O thread pulls binlog events from the source; its SQL thread applies them in order. Because every transaction has a GTID, a replica that reconnects knows precisely where to resume, check Seconds_Behind_Source in SHOW REPLICA STATUS. No guesswork, no full re-copy.",log:null,page:3,index:1,rep:1},
 {s:5,t:"Later: checkpoint flushes pages, purge deletes the undo",d:"In the background, dirty pages are flushed from the buffer pool into users.ibd (advancing the checkpoint LSN in the redo log), and once no reader can still need the old version, the purge thread deletes the undo record from step 3. A transaction left open for hours blocks purge, the undo log grows and grows, a classic MySQL slow-burn problem.",log:null,page:3,index:1,rep:1}
],
mo:[
 {s:0,t:"The driver sends one document",d:"Your app's driver sends a single wire-protocol message: insertOne({ _id: 42, name: 'Asha' }). No SQL, the document itself is the data, sent to the primary of the replica set. Only the primary accepts writes.",log:null,page:0,index:0,rep:0},
 {s:1,t:"mongod checks it, loosely, but _id is strict",d:"mongod checks the basics. The collection users is created on the fly if it does not exist yet, and fields do not need to match any fixed schema. One rule is hard, though: _id must be unique, enforced by the automatic _id index. A second 42 will be rejected.",log:null,page:0,index:0,rep:0},
 {s:1,t:"The document is encoded and the pages are found in cache",d:"The document is encoded as BSON (binary JSON). WiredTiger looks in its cache, by default about half the machine's RAM, for the pages of the users collection. Hot data lives there uncompressed, for speed; on disk the same data sits compressed in collection-*.wt.",log:null,page:1,index:0,rep:0},
 {s:2,t:"The journal is written FIRST",d:"Before the write is considered durable, it is recorded in WiredTiger's journal on disk: journal/WiredTigerLog.0000000123. MongoDB's version of the write-ahead rule. The .wt data files are only made consistent at checkpoints about every 60 seconds, the journal is what bridges that gap after a crash.",log:"journal/WiredTigerLog.0000000123 · INSERT users { _id: 42, name: 'Asha' }",page:1,index:0,rep:0},
 {s:3,t:"The document is placed in the collection's tree",d:"The document is inserted into the collection's B-tree in the cache and the page is marked dirty. On disk, WiredTiger never overwrites in place: at checkpoint time it writes fresh compressed blocks into collection-2-….wt and frees the old ones.",log:null,page:2,index:0,rep:0},
 {s:4,t:"Every index file gets an entry",d:"The _id index (its own index-3-….wt file) gets 42 → a pointer to the document, and so does every secondary index you created. As with the other two engines: indexes make reads fast, and every insert pays for each one.",log:null,page:2,index:1,rep:0},
 {s:2,t:"One entry is appended to the oplog",d:"The primary appends the insert to its oplog, local.oplog.rs, a capped collection in the local database, stamped with a timestamp (ts). This is not for crash recovery (the journal did that). The oplog exists purely so secondaries can replay exactly what the primary did, in the same order.",log:"local.oplog.rs · ts 7461234567890123456 · insert users { _id: 42 }",page:2,index:1,rep:0},
 {s:2,t:"Write concern: “done” can mean “a majority have it”",d:"With the recommended writeConcern { w: 'majority', j: true }, mongod waits until a majority of replica set members have journaled this insert before replying “done”. With w: 1 it replies as soon as the primary has it, faster, but a crash at the wrong second can roll it back. This dial is MongoDB's version of the sync/async choice.",log:null,page:2,index:1,rep:1},
 {s:3,t:"Row 42 is readable, with the right read concern",d:"Reads on the primary see the document immediately. Reads asking for readConcern 'majority' only see data a majority of members hold, so they never see a write that could still be rolled back by an election.",log:null,page:3,index:1,rep:1},
 {s:5,t:"Secondaries tail the oplog and apply it",d:"Each secondary continuously pulls new oplog entries and applies them, converging on the same data. If the primary dies, the most up-to-date members vote and elect a new primary, and majority write concern is what guarantees this insert survives that election.",log:null,page:3,index:1,rep:1},
 {s:5,t:"Later (~60 s): a checkpoint makes it permanent in the .wt files",d:"At the next checkpoint, WiredTiger writes a consistent snapshot of all dirty pages into collection-2-….wt, updates its metadata in WiredTiger.wt, and old journal files are removed. The insert was safe since the journal + majority steps, the checkpoint is the final tidy-up.",log:null,page:3,index:1,rep:1}
]};
var insEng='pg', insCur=-1, insTimer=null;
function insState(){
  var st={log:[],page:0,index:0,rep:0};
  var steps=INS_STEPS[insEng];
  for(var i=0;i<=insCur&&i<steps.length;i++){var x=steps[i]; if(x.log)st.log.push(x.log); if(x.page>st.page)st.page=x.page; if(x.index>st.index)st.index=x.index; if(x.rep>st.rep)st.rep=x.rep;}
  return st;
}
function renderInsSteps(){
  var box=document.getElementById('insSteps'); box.innerHTML='';
  INS_STEPS[insEng].forEach(function(x,i){
    var b=document.createElement('button'); b.className='istep'; b.setAttribute('data-i',i);
    b.innerHTML='<span class="n">'+(i+1)+'</span><span><b>'+x.t+'</b></span>';
    box.appendChild(b);
  });
}
function applyInsMeta(){
  var M=INS_META[insEng];
  M.stages.forEach(function(s,i){ var el=document.getElementById('st'+i); if(el)el.textContent=s; });
  document.getElementById('ipLogH').textContent=M.panels[0];
  document.getElementById('ipPageH').textContent=M.panels[1];
  document.getElementById('ipIndexH').textContent=M.panels[2];
  document.getElementById('ipRepH').textContent=M.panels[3];
}
function updateIns(){
  var steps=INS_STEPS[insEng]; var st=insState();
  document.querySelectorAll('#insStages .istage').forEach(function(el,i){
    el.classList.remove('lit','done');
    if(insCur>=0){ if(steps[insCur].s===i)el.classList.add('lit'); else {
      for(var j=0;j<=insCur;j++){ if(steps[j].s===i){el.classList.add('done');break;} } } }
  });
  document.querySelectorAll('#insSteps .istep').forEach(function(el,i){
    el.classList.toggle('cur',i===insCur); el.classList.toggle('seen',i<insCur);
  });
  if(insCur>=0){ var x=steps[insCur];
    document.getElementById('insTitle').textContent='Step '+(insCur+1)+' of '+steps.length+', '+x.t;
    document.getElementById('insText').textContent=x.d;
  } else {
    document.getElementById('insTitle').textContent='Press Play, or tap any step below';
    document.getElementById('insText').textContent='Every step names the real file or memory area it touches, and the four boxes underneath show the state changing for real: what landed in the log file, what is in the data page, what is in the index, and what the replica has.';
  }
  document.getElementById('insProgress').textContent='Step '+Math.max(0,insCur+1)+' of '+steps.length+(insCur===steps.length-1?' · insert complete ✓':'');
  var lg=document.getElementById('insLog');
  lg.innerHTML=st.log.length? st.log.map(function(l){return '<div class="ilogline">'+l+'</div>'}).join('') : '<span class="empty">Empty. Nothing written yet.</span>';
  var pg=document.getElementById('insPage');
  if(st.page===0)pg.innerHTML='<span class="empty">Existing rows live here. Row 42 is not in yet.</span>';
  else if(st.page===1)pg.innerHTML='<div class="ilogline">data page loaded into memory, free space found</div><span class="empty">Row 42 is not written yet.</span>';
  else if(st.page===2)pg.innerHTML='<div class="irow">id 42 · name ‘Asha’ · in memory only (dirty page)</div><span class="empty">Changed in memory. Not yet visible to others.</span>';
  else pg.innerHTML='<div class="irow">id 42 · name ‘Asha’ · committed ✓ visible to everyone</div>';
  var ix=document.getElementById('insIndex');
  if(st.index)ix.innerHTML='<div class="ikeys"><span>10</span><span>25</span><span class="new">42 → row</span><span>87</span></div><span class="empty" style="display:block;margin-top:6px">42 now sits in sorted order. A lookup finds row 42 in ~3 page reads.</span>';
  else ix.innerHTML='<div class="ikeys"><span>10</span><span>25</span><span>87</span></div><span class="empty" style="display:block;margin-top:6px">42 has no entry yet, a search for 42 would find nothing.</span>';
  var rp=document.getElementById('insReplica');
  rp.innerHTML=st.rep? '<div class="irow">id 42 · name ‘Asha’ · replica is up to date ✓</div>' : '<span class="empty">The replica has users 10, 25, 87, same as the primary. No row 42 yet.</span>';
}
function insGo(i){
  var steps=INS_STEPS[insEng];
  insCur=Math.max(-1,Math.min(steps.length-1,i)); updateIns();
}
function insStopPlay(){ if(insTimer){clearInterval(insTimer); insTimer=null; document.getElementById('insPlay').textContent='▶ Play all steps';} }
if(document.getElementById('insSteps')){document.getElementById('insSteps').addEventListener('click',function(e){
  var b=e.target.closest('.istep'); if(!b)return; insStopPlay(); insGo(+b.getAttribute('data-i'));
});
document.getElementById('insNext').addEventListener('click',function(){insStopPlay(); insGo(insCur+1);});
document.getElementById('insPrev').addEventListener('click',function(){insStopPlay(); insGo(insCur-1);});
document.getElementById('insReset').addEventListener('click',function(){insStopPlay(); insGo(-1);});
document.getElementById('insPlay').addEventListener('click',function(){
  if(insTimer){insStopPlay(); return;}
  if(insCur>=INS_STEPS[insEng].length-1)insCur=-1;
  document.getElementById('insPlay').textContent='⏸ Pause';
  insTimer=setInterval(function(){
    if(insCur>=INS_STEPS[insEng].length-1){insStopPlay(); return;}
    insGo(insCur+1);
  },1600);
  insGo(insCur+1);
});
document.getElementById('insSeg').addEventListener('click',function(e){
  var b=e.target.closest('button'); if(!b)return;
  document.querySelectorAll('#insSeg button').forEach(function(x){x.setAttribute('aria-pressed','false')});
  b.setAttribute('aria-pressed','true'); insStopPlay(); insEng=b.getAttribute('data-ie'); insCur=-1;
  document.getElementById('insSql').textContent=INS_SQL[insEng];
  applyInsMeta(); renderInsSteps(); updateIns();
});
applyInsMeta(); renderInsSteps(); updateIns();}
