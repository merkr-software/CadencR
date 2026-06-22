-- Web Push subscriptions for PWA/remote devices. Each row is one browser push
-- endpoint, keyed to the paired remote device. Revoking a device (soft-delete on
-- remote_devices) does NOT cascade here because that delete is an UPDATE, so the
-- push dispatcher must additionally skip revoked devices via the join — but a
-- hard device delete (if ever added) cascades. `endpoint` is unique: a browser
-- re-subscribing with the same endpoint upserts rather than duplicating.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  INTEGER NOT NULL,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (device_id) REFERENCES remote_devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_device ON push_subscriptions (device_id);
