// CI seed for MongoDB 8. Creates the shop database the site's commands
// reference: users and orders with the fields the extracted commands read.
// Run once against a fresh single-node replica set (rs0), after the primary
// is elected.
db = db.getSiblingDB("shop");

db.users.insertMany([
  { _id: 10, name: "Asha", email: "asha@example.com", status: "active", createdAt: new Date("2026-01-05"), amount: 42 },
  { _id: 25, name: "Ben", email: "ben@example.com", status: "active", createdAt: new Date("2026-01-06"), amount: 18.5 },
  { _id: 87, name: "Cleo", email: "cleo@example.com", status: "inactive", createdAt: new Date("2026-01-07"), amount: 99 }
]);

db.orders.insertMany([
  { user_id: 10, status: "shipped", createdAt: new Date("2026-01-05"), amount: 120 },
  { user_id: 10, status: "shipped", createdAt: new Date("2026-01-06"), amount: 250 },
  { user_id: 25, status: "pending", createdAt: new Date("2026-01-07"), amount: 45 }
]);

db.users.createIndex({ email: 1 });
db.orders.createIndex({ status: 1, createdAt: -1, amount: 1 });

// Populate the plan cache so the site's $planCacheStats queries return rows.
db.orders.find({ status: "shipped", amount: { $gte: 100 } }).sort({ createdAt: -1 }).toArray();
db.users.find({ email: "asha@example.com" }).toArray();
