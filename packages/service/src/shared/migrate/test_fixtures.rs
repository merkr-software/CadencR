use sqlx::SqlitePool;

/// Declare the tables the schedules migration (20260724120000) FKs into.
///
/// Historical fixtures build deliberately minimal schemas, but every migration
/// after their baseline still runs against them — so a fixture must provide
/// whatever a later migration needs, the same way
/// `create_pre_agent_message_index_schema` provides `features` and
/// `custom_actions`. The schedules migration carries `scheduled_messages` rows
/// into `schedules`, which references both of these.
///
/// Deliberately does NOT create `scheduled_messages`: fixtures baselined before
/// 20260621120100 have that table created for them by that migration, and
/// pre-creating it would make it fail. Later-baselined fixtures declare it
/// themselves, in their own era-accurate shape.
///
/// `IF NOT EXISTS` so this can be applied uniformly.
pub(crate) async fn create_schedules_migration_prerequisites(pool: &SqlitePool) {
    sqlx::raw_sql(
        r#"CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS features (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL DEFAULT 1
        );"#,
    )
    .execute(pool)
    .await
    .unwrap();
}

pub(super) async fn create_pre_agent_message_index_schema(pool: &SqlitePool) {
    sqlx::raw_sql(
        r#"-- The pin_features migration (20260621120000) alters features, which
        -- already existed at this baseline, so the fixture must provide it.
        CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT);
        -- The run_in_terminal migration (20260609120000) alters custom_actions,
        -- which already existed at this baseline, so the fixture must provide it.
        CREATE TABLE custom_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'global'
        );
        -- The pin rework drops agent_sessions.is_pinned (migration
        -- 20260621130000); the column existed at this baseline (added by
        -- 20260504001317), so the fixture must provide it for the drop to run.
        CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, is_pinned INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE agent_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
            role TEXT NOT NULL DEFAULT 'assistant',
            content TEXT NOT NULL,
            message_type TEXT NOT NULL DEFAULT 'text',
            tool_name TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            tool_use_id TEXT,
            parent_tool_use_id TEXT,
            model TEXT DEFAULT NULL
        );
        CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);
        INSERT INTO agent_sessions (id, feature_id) VALUES (1, 1);
        INSERT INTO agent_messages
            (session_id, role, content, message_type, tool_name, tool_use_id)
        VALUES
            (1, 'assistant', '{}', 'tool_call', 'TaskCreate', 'create-1'),
            (1, 'assistant', '{"id":"task-1"}', 'tool_result', NULL, 'create-1');"#,
    )
    .execute(pool)
    .await
    .unwrap();
}
