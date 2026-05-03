const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "p2p.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  exchange TEXT NOT NULL,
  order_no TEXT NOT NULL,
  trade_type TEXT NOT NULL,
  asset TEXT,
  fiat TEXT,
  amount REAL,
  unit_price REAL,
  total_price REAL,
  counterparty TEXT,
  status TEXT,
  create_time INTEGER NOT NULL,
  raw TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (exchange, order_no)
);
CREATE INDEX IF NOT EXISTS idx_orders_create_time ON orders(create_time);
CREATE INDEX IF NOT EXISTS idx_orders_exchange_side ON orders(exchange, trade_type);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  exchange TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
`);

const stmtGetKv = db.prepare("SELECT value FROM kv WHERE key = ?");
const stmtPutKv = db.prepare(
  "INSERT INTO kv(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
);

function kvGet(key, fallback = null) {
  const row = stmtGetKv.get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function kvSet(key, value) {
  stmtPutKv.run(key, JSON.stringify(value), Date.now());
}

const stmtUpsertOrder = db.prepare(`
  INSERT INTO orders(exchange, order_no, trade_type, asset, fiat, amount, unit_price, total_price, counterparty, status, create_time, raw, fetched_at)
  VALUES(@exchange, @order_no, @trade_type, @asset, @fiat, @amount, @unit_price, @total_price, @counterparty, @status, @create_time, @raw, @fetched_at)
  ON CONFLICT(exchange, order_no) DO UPDATE SET
    status = excluded.status,
    raw = excluded.raw,
    fetched_at = excluded.fetched_at
`);
const upsertOrders = db.transaction((rows) => {
  for (const r of rows) stmtUpsertOrder.run(r);
});

function saveOrders(exchange, rawOrders) {
  if (!Array.isArray(rawOrders) || rawOrders.length === 0) return 0;
  const now = Date.now();
  const rows = rawOrders.map((o) => ({
    exchange,
    order_no: String(o.orderNumber || o.orderNo || o.id || ""),
    trade_type: o.tradeType || null,
    asset: o.asset || null,
    fiat: o.fiat || null,
    amount: parseFloat(o.amount) || null,
    unit_price: parseFloat(o.unitPrice) || null,
    total_price: parseFloat(o.totalPrice) || null,
    counterparty: o.counterPartNickName || null,
    status: o.orderStatus || null,
    create_time: Number(o.createTime) || now,
    raw: JSON.stringify(o),
    fetched_at: now,
  }));
  upsertOrders(rows.filter((r) => r.order_no));
  return rows.length;
}

const stmtListOrders = db.prepare(`
  SELECT * FROM orders
  WHERE exchange = ? AND create_time >= ? AND create_time <= ?
  ORDER BY create_time DESC
  LIMIT ?
`);

function listOrders(exchange, startMs, endMs, limit = 1000) {
  return stmtListOrders.all(exchange, startMs, endMs, limit);
}

const stmtMaxCreateTime = db.prepare(
  "SELECT MAX(create_time) AS t FROM orders WHERE exchange = ?"
);
function lastOrderTime(exchange) {
  return stmtMaxCreateTime.get(exchange)?.t || 0;
}

const stmtInsertAlert = db.prepare(
  "INSERT INTO alerts(type, exchange, payload, created_at) VALUES(?, ?, ?, ?)"
);
function saveAlert(type, exchange, payload) {
  stmtInsertAlert.run(type, exchange || null, JSON.stringify(payload), Date.now());
}
const stmtListAlerts = db.prepare(
  "SELECT * FROM alerts WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?"
);
function listAlerts(sinceMs, limit = 200) {
  return stmtListAlerts.all(sinceMs, limit).map((r) => ({
    id: r.id,
    type: r.type,
    exchange: r.exchange,
    payload: JSON.parse(r.payload),
    t: r.created_at,
  }));
}

module.exports = {
  db,
  kvGet,
  kvSet,
  saveOrders,
  listOrders,
  lastOrderTime,
  saveAlert,
  listAlerts,
};
