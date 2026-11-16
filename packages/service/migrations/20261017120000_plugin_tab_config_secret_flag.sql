-- Remember whether a custom tab setting was saved as a secret. Masking must not
-- depend on the current manifest alone: a tab that re-declares a `secret` field
-- as `string` would otherwise read the saved secret back through `config.get()`.
-- Rows saved before this flag existed are pre-release test data only.
ALTER TABLE plugin_tab_config ADD COLUMN is_secret INTEGER NOT NULL DEFAULT 0
    CHECK (is_secret IN (0, 1));
