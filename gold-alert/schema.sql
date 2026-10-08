-- Gold Price Alert System - Cloudflare D1 Schema

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  triggered INTEGER NOT NULL DEFAULT 0,
  last_trigger_direction TEXT,
  last_trigger_time TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  price REAL,
  bid REAL,
  ask REAL,
  ea_online INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  updated_at TEXT,
  config_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  step REAL NOT NULL DEFAULT 5.0,
  telegram_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed single-row tables
INSERT OR IGNORE INTO system_status (id, symbol, price, bid, ask, ea_online, last_seen, updated_at, config_version)
VALUES (1, 'XAUUSD', NULL, NULL, NULL, 0, NULL, datetime('now'), 1);

INSERT OR IGNORE INTO settings (id, step, telegram_enabled, updated_at)
VALUES (1, 5.0, 1, datetime('now'));
