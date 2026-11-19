-- howdbswork.com health check for PostgreSQL. Read-only.
-- Run:  psql -At -F'|' -X -d yourdb -f health-pg.sql > report.txt
-- Then paste report.txt into https://howdbswork.com/health/
-- Needs: a role that can read pg_stat_* (pg_monitor is enough).
-- If pg_stat_statements is not installed, that one query prints an error; the rest still runs.
SELECT 'engine', 'pg';
SELECT 'version', current_setting('server_version');
SELECT 'uptime_s', extract(epoch FROM now() - pg_postmaster_start_time())::bigint;
SELECT 'stats_since_s', coalesce(extract(epoch FROM now() - stats_reset)::bigint, -1) FROM pg_stat_database WHERE datname = current_database();
SELECT 'db', datname, pg_database_size(datname) FROM pg_database WHERE datname = current_database();
SELECT 'cache', blks_hit, blks_read FROM pg_stat_database WHERE datname = current_database();
SELECT 'max_conn', current_setting('max_connections');
SELECT 'conn', coalesce(state, 'background'), count(*) FROM pg_stat_activity GROUP BY 2;
SELECT 'oldest_xact', pid, extract(epoch FROM now() - xact_start)::bigint, coalesce(state, ''), left(regexp_replace(coalesce(query, ''), '\s+', ' ', 'g'), 120)
  FROM pg_stat_activity WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid() ORDER BY xact_start LIMIT 3;
SELECT 'xid_age', datname, age(datfrozenxid) FROM pg_database ORDER BY age(datfrozenxid) DESC LIMIT 3;
SELECT 'table', schemaname || '.' || relname, pg_total_relation_size(relid), n_live_tup, n_dead_tup,
       coalesce(extract(epoch FROM now() - greatest(last_vacuum, last_autovacuum))::bigint, -1), seq_scan, coalesce(idx_scan, 0)
  FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15;
SELECT 'unused_index', s.schemaname || '.' || s.indexrelname, s.schemaname || '.' || s.relname, pg_relation_size(s.indexrelid), s.idx_scan
  FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
  WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
  ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 15;
SELECT 'invalid_index', indexrelid::regclass, indrelid::regclass FROM pg_index WHERE NOT indisvalid;
SELECT 'replica', coalesce(application_name, ''), coalesce(client_addr::text, ''), state, coalesce(extract(epoch FROM replay_lag), 0) FROM pg_stat_replication;
SELECT 'standby', pg_is_in_recovery(), CASE WHEN pg_is_in_recovery() THEN coalesce(extract(epoch FROM now() - pg_last_xact_replay_timestamp())::bigint, -1) ELSE 0 END;
SELECT 'slot', slot_name, active, coalesce(pg_wal_lsn_diff(CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn() ELSE pg_current_wal_lsn() END, restart_lsn), 0)::bigint FROM pg_replication_slots;
SELECT 'setting', name, setting, coalesce(unit, '') FROM pg_settings WHERE name IN
  ('shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size', 'max_connections', 'max_wal_size',
   'random_page_cost', 'synchronous_commit', 'fsync', 'full_page_writes', 'autovacuum', 'wal_level', 'archive_mode',
   'idle_in_transaction_session_timeout', 'statement_timeout', 'log_min_duration_statement', 'shared_preload_libraries', 'track_io_timing');
SELECT 'stmt', calls, round(total_exec_time)::bigint, round(mean_exec_time::numeric, 2), left(regexp_replace(query, '\s+', ' ', 'g'), 140)
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 8;
