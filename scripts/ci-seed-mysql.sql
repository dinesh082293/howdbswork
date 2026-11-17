-- CI seed for MySQL 8.4. Creates the shop database the site's commands
-- reference: users and orders with the columns the extracted commands read.
-- Run once against a fresh server.
CREATE DATABASE IF NOT EXISTS shop;
USE shop;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00
);

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  FOREIGN KEY (user_id) REFERENCES users (id)
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
CREATE INDEX idx_orders_status_created ON orders (status, createdAt);
