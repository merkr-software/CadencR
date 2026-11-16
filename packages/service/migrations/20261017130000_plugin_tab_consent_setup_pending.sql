-- Remember that a custom tab's creation consented to its permissions but never
-- reached its first availability choice. "Open project" finishes such a setup
-- by turning the tab on in its project. Any later on/off/inherit choice clears
-- the flag, so reopening the project never overrides what the user picked.
ALTER TABLE plugin_tab_consents ADD COLUMN setup_pending INTEGER NOT NULL DEFAULT 0
    CHECK (setup_pending IN (0, 1));
