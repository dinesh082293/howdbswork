// Tests for assets/js/planreader.js. Run: node scripts/test-plan.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../assets/js/planreader.js');
let pass = 0, fail = 0;
function t(name, text, want, notWant = [], engine) {
  const r = P.read(text, engine), titles = r.findings.map(f => f.sev + ':' + f.title);
  const miss = want.filter(w => !titles.some(x => w.test(x))), extra = notWant.filter(w => titles.some(x => w.test(x)));
  if (r.unreadable && want.length) { fail++; console.log('FAIL', name, 'unreadable'); return r; }
  if (miss.length || extra.length) { fail++; console.log('FAIL', name, 'missing', miss.map(String), 'unwanted', extra.map(String), 'got', titles); } else pass++;
  return r;
}
const pgSeq = `                                                    QUERY PLAN
--------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.00..2041.00 rows=20 width=48) (actual time=58.112..58.120 rows=20 loops=1)
   Buffers: shared hit=1203 read=16170
   ->  Sort  (cost=0.00..2041.00 rows=20 width=48) (actual time=58.110..58.114 rows=20 loops=1)
         Sort Key: created_at DESC
         Sort Method: top-N heapsort  Memory: 27kB
         ->  Seq Scan on orders  (cost=0.00..20406.00 rows=95 width=48) (actual time=0.031..57.600 rows=4870 loops=1)
               Filter: (customer_id = 4242)
               Rows Removed by Filter: 995130
               Buffers: shared hit=1203 read=16170
 Planning Time: 0.140 ms
 Execution Time: 58.161 ms
(11 rows)`;
let r = t('pg seq scan', pgSeq, [/Full scan keeps 4,870 of 1\.0M/, /estimate off by 51×/, /Most of the time is in Seq Scan on orders/, /pages read from outside/]);
if (r.root && r.root.kids[0].kids[0].name !== 'Seq Scan on orders') { fail++; console.log('FAIL pg tree shape'); } else pass++;
t('pg spill and batches', `Hash Join  (cost=1.00..100.00 rows=1000 width=8) (actual time=10.0..900.0 rows=1000 loops=1)
  Hash Cond: (a.id = b.a_id)
  ->  Seq Scan on a  (cost=0.00..10.00 rows=1000 width=8) (actual time=0.01..5.0 rows=1000 loops=1)
  ->  Hash  (cost=1.00..1.00 rows=1000 width=8) (actual time=400.0..400.0 rows=1000 loops=1)
        Buckets: 65536  Batches: 8  Memory Usage: 4097kB
        ->  Sort  (cost=1.00..1.00 rows=1000 width=8) (actual time=300.0..390.0 rows=1000 loops=1)
              Sort Key: b.x
              Sort Method: external merge  Disk: 52000kB
              ->  Seq Scan on b  (cost=0.00..10.00 rows=1000 width=8) (actual time=0.01..50.0 rows=1000 loops=1)
Execution Time: 905.0 ms`, [/Sort spilled/, /Hash used 8 batches/, /Most of the time is in Hash Join/]);
t('pg nested loop seq inner', `Nested Loop  (cost=0.00..5000.00 rows=10 width=8) (actual time=0.05..2400.0 rows=5000 loops=1)
  ->  Seq Scan on customers c  (cost=0.00..10.00 rows=10 width=4) (actual time=0.01..1.0 rows=5000 loops=1)
  ->  Seq Scan on orders o  (cost=0.00..400.00 rows=1 width=4) (actual time=0.2..0.48 rows=1 loops=5000)
        Filter: (o.customer_id = c.id)
        Rows Removed by Filter: 9999
Execution Time: 2401.0 ms`, [/full scan runs 5,000 times/i, /estimate off by 500×/]);
t('pg index only heap fetches', `Index Only Scan using t_idx on t  (cost=0.43..100.00 rows=50000 width=4) (actual time=0.02..40.0 rows=50000 loops=1)
  Index Cond: (x > 10)
  Heap Fetches: 48000
Execution Time: 41.0 ms`, [/fetched 48k rows from the table/]);
t('pg healthy', `Index Scan using orders_pkey on orders  (cost=0.43..8.45 rows=1 width=40) (actual time=0.019..0.019 rows=1 loops=1)
  Index Cond: (id = 42)
  Buffers: shared hit=4
Planning Time: 0.080 ms
Execution Time: 0.035 ms`, [], [/estimate/, /Full scan/, /Most of the time/]);
t('pg estimates only', `Seq Scan on orders  (cost=0.00..20406.00 rows=95 width=48)
  Filter: (customer_id = 4242)`, [/estimates only/]);
t('pg jit', `Seq Scan on t  (cost=0.00..1.00 rows=1 width=4) (actual time=0.01..2.0 rows=1 loops=1)
Planning Time: 0.1 ms
JIT:
  Functions: 4
  Timing: Generation 1.0 ms, Inlining 20.0 ms, Optimization 30.0 ms, Emission 40.0 ms, Total 91.0 ms
Execution Time: 95.0 ms`, [/JIT took/]);
const my = `EXPLAIN
-> Limit: 20 row(s)  (cost=101225 rows=20) (actual time=412..412 rows=20 loops=1)
    -> Sort: orders.created_at DESC, limit input to 20 row(s) per chunk  (cost=101225 rows=997116) (actual time=412..412 rows=20 loops=1)
        -> Filter: (orders.customer_id = 4242)  (cost=101225 rows=99712) (actual time=0.9..410 rows=4870 loops=1)
            -> Table scan on orders  (cost=101225 rows=997116) (actual time=0.06..355 rows=1000000 loops=1)`;
r = t('my table scan', my, [/Full table scan of 1\.0M rows/, /A filter keeps 4,870 of 1\.0M/, /Most of the time is in Table scan on orders/], [/off by 50k/], 'auto');
if (r.engine !== 'my') { fail++; console.log('FAIL my detect', r.engine); } else pass++;
t('my piped table', `| -> Nested loop inner join  (cost=2.5 rows=3) (actual time=0.05..0.08 rows=3 loops=1)
|     -> Table scan on c  (cost=0.55 rows=3) (actual time=0.02..0.03 rows=3 loops=1)
|     -> Index lookup on o using fk (customer_id=c.id)  (cost=0.3 rows=1) (actual time=0.01..0.01 rows=1 loops=3)`, [], [/Full table scan/, /estimate/]);
const mo = '{"queryPlanner":{"winningPlan":{"stage":"SORT","sortPattern":{"created_at":-1},"inputStage":{"stage":"COLLSCAN"}}},"executionStats":{"nReturned":20,"executionTimeMillis":436,"totalKeysExamined":0,"totalDocsExamined":1000000,"executionStages":{"stage":"SORT","nReturned":20,"executionTimeMillisEstimate":430,"sortPattern":{"created_at":-1},"inputStage":{"stage":"COLLSCAN","nReturned":4870,"executionTimeMillisEstimate":410,"docsExamined":1000000}}}}';
r = t('mo collscan sort', mo, [/Collection scan/, /Blocking sort in memory/, /Examined 1\.0M documents to return 20/]);
if (r.engine !== 'mo') { fail++; console.log('FAIL mo detect'); } else pass++;
t('mo good index', '{"queryPlanner":{"winningPlan":{"stage":"FETCH","inputStage":{"stage":"IXSCAN","indexName":"customer_id_1_created_at_-1"}}},"executionStats":{"nReturned":20,"executionTimeMillis":1,"totalKeysExamined":20,"totalDocsExamined":20,"executionStages":{"stage":"FETCH","nReturned":20,"docsExamined":20,"executionTimeMillisEstimate":0,"inputStage":{"stage":"IXSCAN","nReturned":20,"keysExamined":20,"indexName":"customer_id_1_created_at_-1","executionTimeMillisEstimate":0}}}}',
  [], [/Collection scan/, /Examined/]);
t('mo sbe winning plan', '{"queryPlanner":{"winningPlan":{"queryPlan":{"stage":"COLLSCAN","filter":{"a":{"$eq":1}}},"slotBasedPlan":{}}},"executionStats":{"nReturned":5,"executionTimeMillis":300,"totalKeysExamined":0,"totalDocsExamined":500000,"executionStages":{"stage":"filter","nReturned":5}}}',
  [/Collection scan/, /Examined 500k documents to return 5/]);
t('mo shell syntax', `{ queryPlanner: { winningPlan: { stage: 'COLLSCAN' } }, executionStats: { nReturned: 1, executionTimeMillis: 50, totalDocsExamined: 200000, totalKeysExamined: 0, executionStages: { stage: 'COLLSCAN', nReturned: 1, docsExamined: 200000 } } }`, [/Collection scan/]);
if (!P.read('hello').unreadable) { fail++; console.log('FAIL unreadable'); } else pass++;
console.log(`${pass} of ${pass + fail} passed`);
process.exit(fail ? 1 : 0);
