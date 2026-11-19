// Tests for assets/js/healthcheck.js.
//   node scripts/test-health.mjs                 fixtures only
//   node scripts/test-health.mjs report.txt ...  also check real reports (CI runs the scripts on live servers)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
globalThis.window = globalThis;
require('../assets/js/configcheck.js');
const H = require('../assets/js/healthcheck.js');
let pass = 0, fail = 0;
function ok(c, msg) { if (c) pass++; else { fail++; console.log('FAIL', msg); } }
const titles = r => r.findings.map(f => f.sev + ':' + f.title);
const has = (r, re) => titles(r).some(t => re.test(t));

let r = H.analyze(readFileSync(new URL('./fixtures/health-pg.txt', import.meta.url), 'utf8'), { ramGB: 16 });
ok(r.engine === 'pg', 'pg fixture engine');
ok(has(r, /shared_buffers is still the 128 MB default/), 'pg fixture shared_buffers');
ok(has(r, /1 index has not been used/), 'pg fixture unused index');
ok(!has(r, /no query statistics/i), 'pg fixture no duplicate pg_stat_statements finding');
ok(r.tables.tables.rows.length === 1, 'pg fixture tables');

const pgBad = ['engine|pg', 'version|18.1', 'uptime_s|900000', 'max_conn|100', 'conn|active|20', 'conn|idle|50', 'conn|idle in transaction|15',
  'cache|1000000|200000', 'oldest_xact|4242|7300|idle in transaction|UPDATE orders SET', 'xid_age|shop|1300000000',
  'table|public.orders|5000000000|1000000|900000|86400|5000|10', 'invalid_index|orders_new_idx|orders', 'slot|old_slot|f|5368709120',
  'replica|app|10.0.0.2|streaming|45'].join('\n');
r = H.analyze(pgBad);
for (const re of [/Connections at 85%/, /15 sessions idle in a transaction/, /83\.3% of reads/, /open for 2\.0 h/, /Transaction ID age/, /47% dead rows/, /mostly read by sequential scans/, /Invalid index/, /old_slot is inactive/, /45 s behind/])
  ok(has(r, re), 'pg synthetic ' + re);
ok(r.findings[0].sev === 'risk', 'risks first');

const my = ['engine\tmy', 'version\t8.4.3', 'status\tUptime\t100000', 'status\tThreads_connected\t950', 'status\tThreads_running\t40',
  'status\tInnodb_buffer_pool_read_requests\t100000000', 'status\tInnodb_buffer_pool_reads\t5000000', 'status\tCreated_tmp_disk_tables\t2000000',
  'history_len\t2500000', 'oldest_xact\t77\t5000\tRUNNING\tSELECT * FROM big', 'table\tshop.orders\t1073741824\t5000000\t4194304',
  'unused_index\tshop.idx_old\tshop.orders\t0\t0', 'replica\t\tOFF\tError reading relay log', 'setting\tmax_connections\t1000',
  'setting\tinnodb_flush_log_at_trx_commit\t2', 'setting\tinnodb_buffer_pool_size\t134217728'].join('\n');
r = H.analyze(my, { ramGB: 32 });
ok(r.engine === 'my', 'my engine');
for (const re of [/Connections at 95%/, /5\.0% of page reads go to disk/, /History list length is 2,500,000/, /open for 83 min/, /temporary tables a second/, /1 index has not been used/, /applier .* is OFF/, /redo log flush/, /buffer pool is the 128 MB default/])
  ok(has(r, re), 'my synthetic ' + re);

const mo = ['engine|mo', 'version|8.0.4', 'uptime_s|50000', 'conn|current|120', 'conn|available|51000', 'wt_cache|8000000000|10000000000|2500000000|123',
  'member|a:27017|PRIMARY|0', 'member|b:27017|SECONDARY|120', 'member|c:27017|RECOVERING|-1', 'oplog_window_s|7200', 'long_op|991|300|query|shop.orders',
  'table|shop.orders|9000000000|30000000', 'unused_index|shop.orders.sku_1|shop.orders|50000000|0', 'setting|net.bindIp|0.0.0.0', 'setting|replication.replSet|rs0'].join('\n');
r = H.analyze(mo, { ramGB: 32 });
ok(r.engine === 'mo', 'mo engine');
for (const re of [/Dirty data/, /oplog window is 2\.0 h/, /b:27017 is 2 min behind/, /c:27017 is RECOVERING/, /run for 5 min/, /1 index has not been used/, /Authentication is not enforced/])
  ok(has(r, re), 'mo synthetic ' + re);
ok(!has(r, /Not a replica set/), 'mo replSet from command line is recognised');
ok(H.analyze('nothing here').engine === null, 'no engine');

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, 'utf8');
  const rr = H.analyze(text);
  ok(!!rr.engine, file + ': engine line found');
  ok(!/^error\|/m.test(text), file + ': no error lines');
  ok(rr.tables.tables !== undefined, file + ': tables section');
  console.log(file, rr.engine, rr.facts, rr.findings.length, 'findings');
}
console.log(`${pass} of ${pass + fail} passed`);
process.exit(fail ? 1 : 0);
