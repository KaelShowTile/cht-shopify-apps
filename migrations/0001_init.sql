-- Core key-value settings table for App settings & all custom features
CREATE TABLE IF NOT EXISTS settings (
	setting_id TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (setting_id, key)
);

-- Execution & deduplication logs for webhooks / feature runs
CREATE TABLE IF NOT EXISTS webhook_logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	feature TEXT NOT NULL,
	webhook_id TEXT,
	topic TEXT NOT NULL,
	order_id TEXT NOT NULL,
	order_name TEXT,
	address_hash TEXT,
	destination_address TEXT,
	distance_meters INTEGER,
	status TEXT NOT NULL,
	message TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_logs_webhook_id
	ON webhook_logs(webhook_id)
	WHERE webhook_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_logs_feature_order
	ON webhook_logs(feature, order_id, id DESC);
