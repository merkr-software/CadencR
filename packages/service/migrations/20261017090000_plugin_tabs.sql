-- Custom tabs (docs/CUSTOM_TABS.md §4.1).
--
-- 1. Widen the plugin-authoring marker to `'tab'`.
--
--    SQLite cannot alter a CHECK in place, and rebuilding `projects` is unsafe
--    here: sqlx runs this file inside a transaction with `foreign_keys = ON`,
--    where the pragma cannot be switched off, and `DROP TABLE projects` would
--    then cascade-delete every feature, session and message. The marker
--    columns are the table's last two and are referenced only by
--    `projects_authoring_identity`, so they are moved aside and re-added with
--    the wider CHECK instead. `ALTER TABLE ... DROP COLUMN` never fires
--    foreign-key actions, and every other column, index, trigger and child row
--    of `projects` is untouched. Marker values are restored row for row.
CREATE TABLE _project_authoring_marker_backup (
    project_id INTEGER PRIMARY KEY,
    authoring_target TEXT NOT NULL,
    plugin_id TEXT NOT NULL
);
INSERT INTO _project_authoring_marker_backup (project_id, authoring_target, plugin_id)
    SELECT id, authoring_target, plugin_id FROM projects WHERE authoring_target IS NOT NULL;

DROP INDEX projects_authoring_identity;
ALTER TABLE projects DROP COLUMN plugin_id;
ALTER TABLE projects DROP COLUMN authoring_target;

ALTER TABLE projects ADD COLUMN authoring_target TEXT
    CHECK (authoring_target IN ('theme', 'provider', 'tab'));
ALTER TABLE projects ADD COLUMN plugin_id TEXT
    CHECK ((authoring_target IS NULL) = (plugin_id IS NULL));

UPDATE projects
SET (authoring_target, plugin_id) = (
    SELECT backup.authoring_target, backup.plugin_id
    FROM _project_authoring_marker_backup backup
    WHERE backup.project_id = projects.id
)
WHERE id IN (SELECT project_id FROM _project_authoring_marker_backup);

CREATE UNIQUE INDEX projects_authoring_identity
    ON projects (authoring_target, plugin_id)
    WHERE authoring_target IS NOT NULL;

DROP TABLE _project_authoring_marker_backup;

-- 2. Enablement: one optional global row per plugin plus optional per-project
--    overrides. Effective = project ?? global ?? off, gated on consent.
CREATE TABLE plugin_tab_enablements (
    id INTEGER PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX plugin_tab_enablements_global
    ON plugin_tab_enablements (plugin_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX plugin_tab_enablements_project
    ON plugin_tab_enablements (plugin_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX plugin_tab_enablements_project_id ON plugin_tab_enablements (project_id);

-- 3. Consent is recorded against the manifest's permissions hash; a widened
--    manifest no longer matches and needs a new consent.
CREATE TABLE plugin_tab_consents (
    plugin_id TEXT PRIMARY KEY,
    permissions_hash TEXT NOT NULL,
    consented_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Settings-form values (JSON text), global or per project. Secrets live here
--    too and are never returned by the API.
CREATE TABLE plugin_tab_config (
    id INTEGER PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX plugin_tab_config_global
    ON plugin_tab_config (plugin_id, key) WHERE project_id IS NULL;
CREATE UNIQUE INDEX plugin_tab_config_project
    ON plugin_tab_config (plugin_id, project_id, key) WHERE project_id IS NOT NULL;
CREATE INDEX plugin_tab_config_project_id ON plugin_tab_config (project_id);

-- 5. The plugin's own key/value store, always per project.
CREATE TABLE plugin_tab_storage (
    plugin_id TEXT NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (plugin_id, project_id, key)
);
CREATE INDEX plugin_tab_storage_project_id ON plugin_tab_storage (project_id);
