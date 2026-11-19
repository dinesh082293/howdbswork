// Tests for assets/js/configcheck.js. Run: node scripts/test-config.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../assets/js/configcheck.js');
let pass = 0, fail = 0;
function t(name, o, want, notWant = []) {
  const r = C.check(o), ids = r.findings.map(f => f.key + ':' + f.sev);
  const miss = want.filter(w => !ids.includes(w)), extra = notWant.filter(w => ids.includes(w));
  if (miss.length || extra.length) { fail++; console.log('FAIL', name, 'missing', miss, 'unwanted', extra, 'got', ids); } else pass++;
}
t('pg conf basics', { text: 'shared_buffers = 128MB\nfsync = off\nwork_mem = 64MB\nmax_connections = 800', ramGB: 64 },
  ['fsync:risk', 'shared_buffers:slow', 'work_mem:risk', 'max_connections:slow']);
t('pg healthy', { text: "shared_buffers = 16GB\nwork_mem = 16MB\nmax_connections = 200\neffective_cache_size = 40GB\nmaintenance_work_mem = 1GB\nmax_wal_size = 8GB\nrandom_page_cost = 1.1\nshared_preload_libraries = 'pg_stat_statements'", ramGB: 64 },
  [], ['shared_buffers:slow', 'work_mem:risk', 'max_wal_size:tip', 'effective_cache_size:tip', 'shared_preload_libraries:tip']);
t('pg SHOW ALL table', { text: '        name         | setting | description\n---------------------+---------+------------\n shared_buffers      | 128MB   | x\n synchronous_commit  | off     | y\n autovacuum          | off     | z', ramGB: 32 },
  ['shared_buffers:slow', 'synchronous_commit:risk', 'autovacuum:risk']);
t('pg pg_settings with 8kB unit', { text: 'shared_buffers | 16384 | 8kB', ramGB: 64 }, ['shared_buffers:slow']);
t('pg shared_buffers too big', { text: 'shared_buffers = 40GB', ramGB: 64 }, ['shared_buffers:slow']);
t('pg sync local is a tip', { text: 'synchronous_commit = local' }, ['synchronous_commit:tip']);
t('pg timeouts', { text: 'idle_in_transaction_session_timeout = 0\nstatement_timeout = 0\nlog_min_duration_statement = -1' },
  ['idle_in_transaction_session_timeout:tip', 'statement_timeout:tip', 'log_min_duration_statement:tip']);
t('pg wal minimal', { text: 'wal_level = minimal\narchive_mode = off' }, ['wal_level:risk', 'archive_mode:tip']);
t('detect pg', { engine: 'auto', text: 'work_mem = 4MB\nautovacuum = on' }, [], ['autovacuum:risk']);
t('my cnf', { text: '[mysqld]\ninnodb-buffer-pool-size = 128M\ninnodb_flush_log_at_trx_commit = 2\nsync_binlog = 0\nsql_mode = NO_ENGINE_SUBSTITUTION\nskip-name-resolve', ramGB: 32 },
  ['innodb_buffer_pool_size:slow', 'innodb_flush_log_at_trx_commit:risk', 'sync_binlog:risk', 'sql_mode:risk']);
t('my SHOW VARIABLES table', { text: '+--------------------------------+-----------+\n| Variable_name                  | Value     |\n+--------------------------------+-----------+\n| innodb_flush_log_at_trx_commit | 1         |\n| sync_binlog                    | 1         |\n| binlog_format                  | STATEMENT |\n| lock_wait_timeout              | 31536000  |\n| innodb_buffer_pool_size        | 60129542144 |', ramGB: 64 },
  ['binlog_format:risk', 'lock_wait_timeout:tip', 'innodb_buffer_pool_size:risk'], ['innodb_flush_log_at_trx_commit:risk', 'sync_binlog:risk']);
t('my tab separated', { text: 'innodb_flush_log_at_trx_commit\t0\nslow_query_log\tOFF\ngtid_mode\tOFF' }, ['innodb_flush_log_at_trx_commit:risk', 'slow_query_log:tip', 'gtid_mode:tip']);
t('my healthy', { text: 'innodb_flush_log_at_trx_commit = 1\nsync_binlog = 1\nbinlog_format = ROW\nsql_mode = STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION\ninnodb_buffer_pool_size = 48G\ninnodb_redo_log_capacity = 4G', ramGB: 64 },
  [], ['innodb_flush_log_at_trx_commit:risk', 'sync_binlog:risk', 'binlog_format:risk', 'sql_mode:risk', 'innodb_buffer_pool_size:slow', 'innodb_buffer_pool_size:risk', 'innodb_redo_log_capacity:tip']);
t('mo yaml open', { text: 'storage:\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 60\nnet:\n  bindIp: 0.0.0.0\nreplication:\n  oplogSizeMB: 1024', ramGB: 64 },
  ['cacheSizeGB:risk', 'security.authorization:risk', 'replication.oplogSizeMB:tip', 'replication.replSetName:risk']);
t('mo yaml good', { text: 'net:\n  bindIp: 10.0.0.5\nsecurity:\n  authorization: enabled\nreplication:\n  replSetName: rs0\n  oplogSizeMB: 51200\nstorage:\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 31', ramGB: 64 },
  [], ['security.authorization:risk', 'security.authorization:tip', 'replication.replSetName:risk', 'cacheSizeGB:risk', 'cacheSizeGB:slow']);
t('mo getCmdLineOpts json', { engine: 'auto', text: '{"parsed":{"net":{"bindIp":"0.0.0.0"},"storage":{"dbPath":"/data"}}}' },
  ['security.authorization:risk', 'replication.replSetName:risk']);
t('unknown text', { text: 'hello world' }, []);
const r = C.check({ text: 'hello world' }); if (!r.unknownFormat) { fail++; console.log('FAIL unknown not flagged'); } else pass++;
console.log(`${pass} of ${pass + fail} passed`);
process.exit(fail ? 1 : 0);
