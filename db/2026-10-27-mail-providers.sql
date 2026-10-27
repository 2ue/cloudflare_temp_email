CREATE TABLE IF NOT EXISTS mail_provider_usage (
    provider TEXT NOT NULL,
    period TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider, period)
);

CREATE TABLE IF NOT EXISTS mail_provider_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    provider_type TEXT,
    from_address TEXT,
    to_mail TEXT,
    success INTEGER NOT NULL DEFAULT 0,
    error_kind TEXT,
    error TEXT,
    duration_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mail_provider_log_created_at ON mail_provider_log(created_at);

CREATE INDEX IF NOT EXISTS idx_mail_provider_log_provider ON mail_provider_log(provider);
