-- Usage writes that were lost rather than merely delayed.
--
-- Recording is fire-and-forget, and shutdown drains what is still in flight —
-- but a drain that times out really does lose those words. Counting that in
-- process memory is useless: the process is on its way out, so the "next read
-- will warn you" promise could never be kept. It is recorded here instead, so
-- the next start still knows the numbers are short and the Stats tab can say
-- so.
--
-- One row, like the other markers. `dropped_writes` accumulates because the
-- loss is permanent: nothing re-derives those words later.
CREATE TABLE usage_recording_losses (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    dropped_writes INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    last_at TEXT
);
