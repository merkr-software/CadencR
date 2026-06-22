-- Pin conversations (features) so they sort into a dedicated "Pinned" section
-- at the top of the sidebar. Defaults to unpinned for every existing row.
ALTER TABLE features ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_features_is_pinned ON features(is_pinned);
