-- Seed data for howdbswork.com
-- One table, the same data every example on the site uses.
-- Run it in psql, the mysql client, mongosh, or the live panel on Home.
-- PostgreSQL and MySQL:
CREATE TABLE users (
  id   integer PRIMARY KEY,
  name text
);
INSERT INTO users (id, name) VALUES
  (10, 'User Ten'),
  (25, 'User TwentyFive'),
  (87, 'User EightySeven');
-- The walkthrough row, added live on the Home page:
-- INSERT INTO users (id, name) VALUES (42, 'Asha');
-- Check it:
-- SELECT * FROM users ORDER BY id;
-- MongoDB:
-- db.users.insertMany([
--   { _id: 10, name: 'User Ten' },
--   { _id: 25, name: 'User TwentyFive' },
--   { _id: 87, name: 'User EightySeven' }
-- ]);
-- db.users.insertOne({ _id: 42, name: 'Asha' });
-- db.users.find().sort({ _id: 1 });
