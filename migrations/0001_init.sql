CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  unsub_token TEXT NOT NULL UNIQUE,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);
CREATE INDEX idx_subscribers_status ON subscribers (status);
CREATE INDEX idx_subscribers_sweep ON subscribers (status, created_at);
CREATE INDEX idx_subscribers_ip ON subscribers (ip_hash, created_at);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry TEXT NOT NULL,
  take_profit TEXT NOT NULL,
  stop_loss TEXT NOT NULL,
  note TEXT,
  transcript TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  draft_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  recipient_count INTEGER
);

CREATE TABLE send_log (
  trade_id INTEGER NOT NULL,
  subscriber_id INTEGER NOT NULL,
  chunk INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (trade_id, subscriber_id)
);
CREATE INDEX idx_send_log_pending ON send_log (trade_id, status);
