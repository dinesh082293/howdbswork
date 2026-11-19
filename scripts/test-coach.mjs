// Tests for assets/js/querycoach.js: run with  node scripts/test-coach.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../assets/js/querycoach.js', import.meta.url), 'utf8'), ctx);
const { review } = ctx.window.HDW_COACH;
const ORDERS = `CREATE TABLE customers (id bigint PRIMARY KEY, email text NOT NULL);
CREATE TABLE orders (id bigint PRIMARY KEY, customer_id bigint NOT NULL REFERENCES customers(id), status text, total numeric(12,2), created_at timestamptz NOT NULL);
CREATE INDEX orders_cc ON orders (customer_id, created_at);`;
const cases = [
  // [name, input, ids that must appear, ids that must not]
  ['update without where', { sql: 'UPDATE accounts SET balance = 0' }, ['no-where'], []],
  ['delete with where is fine', { sql: 'DELETE FROM sessions WHERE id = $1' }, [], ['no-where', 'retention-delete']],
  ['where in a string is not a where', { sql: "UPDATE t SET note = 'where it was'" }, ['no-where'], []],
  ['select star', { sql: 'SELECT * FROM orders WHERE id = 1' }, ['select-star'], ['no-where-select']],
  ['exists select star is fine', { sql: 'SELECT id FROM a WHERE EXISTS (SELECT * FROM b WHERE b.a_id = a.id)' }, [], ['select-star']],
  ['count star is not select star', { sql: 'SELECT count(*) FROM orders WHERE status = $1' }, [], ['select-star', 'count-all']],
  ['count whole table', { sql: 'SELECT count(*) FROM orders' }, ['count-all'], ['no-where-select']],
  ['deep offset', { sql: 'SELECT id FROM orders ORDER BY id LIMIT 20 OFFSET 50000' }, ['offset'], []],
  ['mysql limit offset form', { engine: 'my', sql: 'SELECT id FROM orders ORDER BY id LIMIT 50000, 20' }, ['offset'], []],
  ['function on column', { sql: "SELECT id FROM users WHERE lower(email) = 'a@b.c'" }, ['fn-col'], []],
  ['date function', { sql: "SELECT id FROM orders WHERE date(created_at) = '2026-11-01'" }, ['fn-col'], []],
  ['function in select list is fine', { sql: "SELECT lower(email) FROM users WHERE id = 3" }, [], ['fn-col']],
  ['cast on column', { sql: "SELECT id FROM orders WHERE created_at::date = '2026-11-01'" }, ['fn-col'], []],
  ['leading wildcard', { sql: "SELECT id FROM users WHERE name LIKE '%son'" }, ['like-leading'], []],
  ['prefix like is fine', { sql: "SELECT id FROM users WHERE name LIKE 'son%'" }, [], ['like-leading']],
  ['not in subquery', { sql: 'SELECT id FROM a WHERE x NOT IN (SELECT y FROM b)' }, ['not-in-null'], []],
  ['order by random', { engine: 'my', sql: 'SELECT id FROM t ORDER BY RAND() LIMIT 1' }, ['order-random'], []],
  ['queue without skip locked', { sql: 'SELECT id FROM jobs WHERE state = $1 ORDER BY id LIMIT 1 FOR UPDATE' }, ['skip-locked'], []],
  ['queue with skip locked', { sql: 'SELECT id FROM jobs WHERE state = $1 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED' }, [], ['skip-locked']],
  ['cartesian', { sql: 'SELECT a.id, b.id FROM a, b' }, ['cartesian'], []],
  ['lost update', { sql: 'SELECT stock FROM products WHERE id = 42; UPDATE products SET stock = 6 WHERE id = 42;' }, ['lost-update'], []],
  ['atomic update is fine', { sql: 'SELECT stock FROM products WHERE id = 42; UPDATE products SET stock = stock - 1 WHERE id = 42 AND stock >= 1;' }, [], ['lost-update']],
  ['for update is fine', { sql: 'SELECT stock FROM products WHERE id = 42 FOR UPDATE; UPDATE products SET stock = 6 WHERE id = 42;' }, [], ['lost-update']],
  ['optimistic version check is fine', { sql: 'SELECT stock, version FROM products WHERE id = 42; UPDATE products SET stock = 6, version = 8 WHERE id = 42 AND version = 7;' }, [], ['lost-update']],
  ['pg index without concurrently', { sql: 'CREATE INDEX orders_status ON orders (status)' }, ['index-lock'], []],
  ['pg index concurrently', { sql: 'CREATE INDEX CONCURRENTLY orders_status ON orders (status)' }, [], ['index-lock']],
  ['index on a table created here', { sql: 'CREATE TABLE t (id int primary key, a int); CREATE INDEX t_a ON t (a);' }, [], ['index-lock']],
  ['volatile default', { sql: 'ALTER TABLE orders ADD COLUMN ref uuid DEFAULT gen_random_uuid()' }, ['add-volatile-default', 'lock-timeout'], []],
  ['constant default is fine', { sql: "SET lock_timeout = '5s'; ALTER TABLE orders ADD COLUMN flag boolean NOT NULL DEFAULT false" }, [], ['add-volatile-default', 'lock-timeout']],
  ['fk without not valid', { sql: 'ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (customer_id) REFERENCES customers(id)' }, ['constraint-valid'], []],
  ['set not null', { sql: 'ALTER TABLE orders ALTER COLUMN status SET NOT NULL' }, ['set-not-null'], []],
  ['mysql modify column', { engine: 'my', sql: 'ALTER TABLE orders MODIFY COLUMN note TEXT' }, ['alter-type', 'mdl'], []],
  ['mysql alter with algorithm', { engine: 'my', sql: 'ALTER TABLE orders ADD COLUMN x INT, ALGORITHM=INSTANT' }, ['mdl'], ['algorithm']],
  ['retention delete', { sql: "DELETE FROM events WHERE created_at < now() - interval '90 days'" }, ['retention-delete'], []],
  ['single inserts', { sql: 'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3);' }, ['batch-insert'], []],
  ['multi-row insert is fine', { sql: 'INSERT INTO t VALUES (1), (2), (3)' }, [], ['batch-insert']],
  ['second column only', { sql: "SELECT id FROM orders WHERE created_at >= '2026-11-01'", schema: ORDERS }, ['missing-index'], []],
  ['both columns are fine', { sql: "SELECT id FROM orders WHERE customer_id = 42 AND created_at >= '2026-11-01'", schema: ORDERS }, [], ['missing-index']],
  ['order by not covered', { sql: 'SELECT id FROM orders WHERE customer_id = 42 ORDER BY total DESC LIMIT 20', schema: ORDERS }, ['order-index'], []],
  ['order by covered', { sql: 'SELECT id FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20', schema: ORDERS }, [], ['order-index', 'missing-index']],
  ['join without index', { sql: 'SELECT c.email FROM customers c JOIN orders o ON o.status = c.email WHERE c.id = 1', schema: ORDERS }, ['join-index'], []],
  ['join on primary key is fine', { sql: 'SELECT o.id, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.customer_id = 9', schema: ORDERS }, [], ['join-index', 'missing-index']],
  ['type mismatch mysql', { engine: 'my', sql: 'SELECT id FROM users WHERE phone = 5551234', schema: 'CREATE TABLE users (id int primary key, phone varchar(20), KEY (phone))' }, ['type-mismatch'], []],
  ['no pk', { schema: 'CREATE TABLE log (msg text)' , sql: ''}, ['no-pk'], []],
  ['money float', { schema: 'CREATE TABLE p (id int primary key, price double precision)', sql: '' }, ['money-float'], []],
  ['timestamp without tz', { schema: 'CREATE TABLE p (id int primary key, at timestamp)', sql: '' }, ['tz'], []],
  ['pg fk without index', { schema: 'CREATE TABLE a (id int primary key); CREATE TABLE b (id int primary key, a_id int references a(id))', sql: '' }, ['fk-index'], []],
  ['mysql uuid pk', { engine: 'my', schema: 'CREATE TABLE u (id char(36) primary key, n int)', sql: '' }, ['uuid-pk'], []],
  ['redundant index', { schema: 'CREATE TABLE t (id int primary key, a int, b int); CREATE INDEX i1 ON t (a); CREATE INDEX i2 ON t (a, b);', sql: '' }, ['redundant-index'], []],
  ['pg plan', { sql: 'SELECT 1', plan: "Seq Scan on orders  (cost=0.00..21571.00 rows=10000 width=16) (actual time=0.031..111.902 rows=1204 loops=1)\n  Filter: (status = 'refunded'::text)\n  Rows Removed by Filter: 998796\n  Buffers: shared hit=212 read=8121" }, ['plan-seq', 'plan-buffers'], []],
  ['pg plan bad estimate', { sql: 'SELECT 1', plan: 'Index Scan using i on t  (cost=0.43..8.45 rows=1 width=8) (actual time=0.01..40.2 rows=50000 loops=1)' }, ['plan-estimate'], []],
  ['pg sort to disk', { sql: 'SELECT 1', plan: 'Sort  (cost=1.00..2.00 rows=100000 width=8) (actual time=1..900 rows=100000 loops=1)\n  Sort Method: external merge  Disk: 51200kB' }, ['plan-sort-disk'], []],
  ['mysql table plan', { engine: 'my', sql: 'SELECT 1', plan: '| id | select_type | table  | partitions | type | possible_keys | key  | key_len | ref  | rows   | filtered | Extra                       |\n|  1 | SIMPLE      | orders | NULL       | ALL  | NULL          | NULL | NULL    | NULL | 998012 |    10.00 | Using where; Using filesort |' }, ['plan-seq', 'plan-filesort'], []],
  ['mysql tree plan', { engine: 'my', sql: 'SELECT 1', plan: "-> Limit: 20 row(s)  (cost=101000 rows=20) (actual time=480..480 rows=20 loops=1)\n    -> Sort: orders.created_at DESC, limit input to 20 row(s) per chunk  (cost=101000 rows=998012) (actual time=480..480 rows=20 loops=1)\n        -> Filter: (orders.`status` = 'refunded')  (cost=101000 rows=99801) (actual time=0.1..470 rows=1204 loops=1)\n            -> Table scan on orders  (cost=101000 rows=998012) (actual time=0.09..400 rows=1000000 loops=1)" }, ['plan-seq', 'plan-estimate'], []],
  ['limit cuts a sort short, not a bad estimate', { sql: 'SELECT 1', plan: 'Limit  (cost=1.00..2.00 rows=20 width=8) (actual time=1..2 rows=20 loops=1)\n  ->  Sort  (cost=1.00..2.00 rows=10000 width=8) (actual time=1..2 rows=20 loops=1)' }, [], ['plan-estimate']],
  ['clean query', { sql: 'SELECT id, total FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20', schema: ORDERS }, [], ['missing-index', 'order-index', 'select-star', 'offset', 'no-where-select']],
];
let fail = 0;
for (const [name, input, must, mustNot] of cases) {
  const ids = review(input).findings.map(f => f.id);
  const miss = must.filter(i => !ids.includes(i)), extra = mustNot.filter(i => ids.includes(i));
  if (miss.length || extra.length) { fail++; console.log(`FAIL ${name}: missing [${miss}] unexpected [${extra}] got [${ids}]`); }
}
console.log(`${cases.length - fail} of ${cases.length} passed`);
process.exit(fail ? 1 : 0);
