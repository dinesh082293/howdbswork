-- CI seed for PostgreSQL 18. Creates the demo schema the site's commands
-- reference: users and orders with the columns the extracted commands read.
-- Run once against a fresh database named shop.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0
);

INSERT INTO users (name, email, status, amount) VALUES
  ('Asha', 'asha@example.com', 'active', 42.00),
  ('Ben', 'ben@example.com', 'active', 18.50),
  ('Cleo', 'cleo@example.com', 'inactive', 99.00);

INSERT INTO orders (user_id, status, amount) VALUES
  (1, 'shipped', 120.00),
  (1, 'shipped', 250.00),
  (2, 'pending', 45.00);

CREATE INDEX idx_users_status ON users (status);
CREATE INDEX idx_orders_status_created ON orders (status, created_at);

-- Populate pg_stat_statements so the site's queries against it return rows.
SELECT count(*) FROM users WHERE status = 'active';
SELECT count(*) FROM orders WHERE status = 'shipped';
SELECT pg_stat_statements_reset();
SELECT count(*) FROM users WHERE status = 'active';
SELECT count(*) FROM orders WHERE status = 'shipped';
