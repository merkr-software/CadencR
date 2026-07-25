-- Marker for the one-time import of usage stats from existing conversations.
--
-- `provider_usage_stats` only starts filling once a turn runs, so on an
-- existing install the Stats tab would open empty despite months of history
-- sitting in `agent_messages`. A startup task counts those words once and
-- records itself here.
--
-- The counting itself cannot live in this migration: words are counted in Rust
-- (see `usage_stats::word_count`), and SQL can only approximate that by counting
-- space characters — which over-counts badly on agent output, where indented
-- code and blank lines are everywhere. A migration that wrote different numbers
-- than the live recorder would make the chart's history disagree with its
-- present.
--
-- `cutoff_message_id` is claimed up front, before any words are counted, and is
-- what makes a retry safe: whatever happens to the import, it always covers
-- exactly the messages that existed before it first ran, so a turn taken while
-- an earlier attempt was dying can never be counted twice.
--
-- `version` is 0 for a claimed-but-unfinished import and the importer's version
-- once it commits. Raising that version re-runs the import, so a future bump
-- must ship alongside a migration that clears the rows the old one wrote.
CREATE TABLE provider_usage_backfill (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 0,
    cutoff_message_id INTEGER NOT NULL,
    messages_scanned INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT
);
