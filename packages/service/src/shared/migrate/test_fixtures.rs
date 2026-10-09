use sqlx::{AssertSqlSafe, SqlitePool};

use super::support;

pub(crate) async fn seed_applied_migrations_before(pool: &SqlitePool, version: i64) {
    sqlx::query(
        "CREATE TABLE _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        )",
    )
    .execute(pool)
    .await
    .unwrap();

    let migrator = sqlx::migrate!("./migrations");
    for migration in migrator
        .iter()
        .filter(|migration| migration.version < version)
    {
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, installed_on, success, checksum, execution_time)
             VALUES (?, ?, CURRENT_TIMESTAMP, TRUE, ?, 0)",
        )
        .bind(migration.version)
        .bind(&*migration.description)
        .bind(&*migration.checksum)
        .execute(pool)
        .await
        .unwrap();
    }
}

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
/// The archived_at migration (20260803120000) additionally backfills from the
/// message history, so `agent_sessions` / `agent_messages` must exist and
/// `features` must carry `status` and `created_at`. Fixtures that predate those
/// columns get them added here rather than in each fixture, so the next
/// late migration only has one place to update.
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
        );
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            feature_id INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS agent_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'assistant',
            content TEXT NOT NULL DEFAULT '',
            message_type TEXT NOT NULL DEFAULT 'text',
            created_at TEXT
        );"#,
    )
    .execute(pool)
    .await
    .unwrap();
    // A fixture that declared these tables itself gets nothing from the
    // CREATE IF NOT EXISTS above, so patch the columns in separately.
    ensure_column(pool, "features", "status", "TEXT NOT NULL DEFAULT 'active'").await;
    ensure_column(pool, "features", "created_at", "TEXT").await;
    ensure_column(
        pool,
        "agent_sessions",
        "feature_id",
        "INTEGER NOT NULL DEFAULT 1",
    )
    .await;
    ensure_column(pool, "agent_messages", "created_at", "TEXT").await;
    ensure_agent_session_context_window(pool).await;
    // The FTS narrowing migration (20260803122000) filters on message_type in
    // both its triggers and its repopulate.
    ensure_column(
        pool,
        "agent_messages",
        "message_type",
        "TEXT NOT NULL DEFAULT 'text'",
    )
    .await;
}

/// The context-window default migration (20261009120000) swaps
/// `agent_sessions.context_window`, which every real schema has had since the
/// baseline but minimal fixtures omit. Era-accurate: the baseline's 200000
/// default.
pub(crate) async fn ensure_agent_session_context_window(pool: &SqlitePool) {
    ensure_column(
        pool,
        "agent_sessions",
        "context_window",
        "INTEGER DEFAULT 200000",
    )
    .await;
}

/// Add `column` to `table` when the fixture's baseline predates it.
///
/// `ALTER TABLE ADD COLUMN` rejects non-constant defaults, so timestamp columns
/// are added nullable rather than defaulting to `datetime('now')`. The archived_at
/// backfill already `COALESCE`s over both, and a fixture row with no timestamp
/// simply isn't eligible for retention — which is the correct outcome anyway.
async fn ensure_column(pool: &SqlitePool, table: &str, column: &str, ddl_type: &str) {
    if !support::table_exists(pool, table).await.unwrap()
        || support::table_has_column(pool, table, column)
            .await
            .unwrap()
    {
        return;
    }
    // Table/column names are test-local literals, never user input.
    sqlx::query(AssertSqlSafe(format!(
        "ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"
    )))
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
