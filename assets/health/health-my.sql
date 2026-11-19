-- howdbswork.com health check for MySQL 8.0 and later. Read-only.
-- Run:  mysql -B -N -u youruser -p < health-my.sql > report.txt
-- Then paste report.txt into https://howdbswork.com/health/
-- Needs: SELECT on performance_schema, information_schema and sys (PROCESS helps).
SELECT 'engine', 'my';
SELECT 'version', VERSION();
SELECT 'status', VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME IN
  ('Uptime', 'Threads_connected', 'Threads_running', 'Max_used_connections', 'Aborted_connects', 'Aborted_clients',
   'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads', 'Innodb_row_lock_waits', 'Innodb_deadlocks', 'Slow_queries', 'Created_tmp_disk_tables');
SELECT 'history_len', `COUNT` FROM information_schema.INNODB_METRICS WHERE NAME = 'trx_rseg_history_len';
SELECT 'oldest_xact', trx_mysql_thread_id, TIMESTAMPDIFF(SECOND, trx_started, NOW()), trx_state, LEFT(REPLACE(REPLACE(COALESCE(trx_query, ''), '\n', ' '), '\t', ' '), 120)
  FROM information_schema.INNODB_TRX ORDER BY trx_started LIMIT 3;
SELECT 'table', CONCAT(table_schema, '.', table_name), data_length + index_length, table_rows, data_free
  FROM information_schema.TABLES WHERE table_schema NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema') AND table_type = 'BASE TABLE'
  ORDER BY data_length + index_length DESC LIMIT 15;
SELECT 'unused_index', CONCAT(object_schema, '.', index_name), CONCAT(object_schema, '.', object_name), 0, 0 FROM sys.schema_unused_indexes LIMIT 15;
SELECT 'replica', CHANNEL_NAME, SERVICE_STATE, LEFT(REPLACE(COALESCE(LAST_ERROR_MESSAGE, ''), '\n', ' '), 120) FROM performance_schema.replication_applier_status_by_worker;
SELECT 'setting', VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_variables WHERE VARIABLE_NAME IN
  ('innodb_buffer_pool_size', 'innodb_flush_log_at_trx_commit', 'sync_binlog', 'log_bin', 'binlog_format', 'gtid_mode', 'innodb_redo_log_capacity',
   'sql_mode', 'lock_wait_timeout', 'max_connections', 'slow_query_log', 'long_query_time', 'innodb_file_per_table', 'performance_schema',
   'innodb_print_all_deadlocks', 'binlog_expire_logs_seconds');
SELECT 'stmt', COUNT_STAR, ROUND(SUM_TIMER_WAIT / 1e9), ROUND(AVG_TIMER_WAIT / 1e9, 2), LEFT(REPLACE(COALESCE(DIGEST_TEXT, ''), '\n', ' '), 140)
  FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 8;
