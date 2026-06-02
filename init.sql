CREATE TABLE IF NOT EXISTS machines (
    machine_id   VARCHAR(50) PRIMARY KEY,
    factory_id   VARCHAR(50),
    line_id      VARCHAR(50) NOT NULL,
    machine_type VARCHAR(10) NOT NULL CHECK (machine_type IN ('input','output')),
    last_seen    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_events (
    id           SERIAL PRIMARY KEY,
    machine_id   VARCHAR(50) NOT NULL,
    line_id      VARCHAR(50) NOT NULL,
    machine_type VARCHAR(10) NOT NULL,
    count_ab     INTEGER DEFAULT 0,
    count_27     INTEGER DEFAULT 0,
    count_cur    INTEGER DEFAULT 0,
    count_output INTEGER DEFAULT 0,
    current_amps FLOAT   DEFAULT 0,
    synced_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS batches (
    id             SERIAL PRIMARY KEY,
    batch_code     VARCHAR(50) UNIQUE NOT NULL,
    line_id        VARCHAR(50) NOT NULL,
    product_name   VARCHAR(100) NOT NULL,
    operator_name  VARCHAR(100) NOT NULL,
    target_count   INTEGER NOT NULL,
    status         VARCHAR(20) DEFAULT 'active'
                   CHECK (status IN ('active','completed','paused')),
    notes          TEXT DEFAULT '',
    started_at     TIMESTAMPTZ DEFAULT NOW(),
    completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_machine ON sync_events (machine_id, synced_at);
CREATE INDEX IF NOT EXISTS idx_sync_line    ON sync_events (line_id, synced_at);
CREATE INDEX IF NOT EXISTS idx_sync_at      ON sync_events (synced_at);
CREATE INDEX IF NOT EXISTS idx_batch_line   ON batches (line_id, status);
