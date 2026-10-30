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
    ensure_user_message_count_prerequisites(pool).await;
}

/// The sub-agent registry migration (20261030120000) references
/// `agent_sessions` and indexes `agent_messages` carriers by their tool
/// columns and creation time, which late-baselined fixtures omit or declare
/// without them.
pub(crate) async fn ensure_subagent_runs_prerequisites(pool: &SqlitePool) {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS agent_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT);
         CREATE TABLE IF NOT EXISTS agent_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL
         );",
    )
    .execute(pool)
    .await
    .unwrap();
    for (column, ddl_type) in [
        ("message_type", "TEXT NOT NULL DEFAULT 'text'"),
        ("tool_name", "TEXT"),
        ("tool_use_id", "TEXT"),
        ("parent_tool_use_id", "TEXT"),
        ("created_at", "TEXT"),
    ] {
        ensure_column(pool, "agent_messages", column, ddl_type).await;
    }
}

/// The unified custom-action schedules migration (20261029100000) copies
/// `custom_action_schedules` rows into `schedules` and drops the table, so it
/// needs both tables with the columns the copy reads and writes. Fixtures
/// baselined after the migrations that created them (20260425153153 and
/// 20260724120000) either omit them or declare only the columns their own era
/// needed; the missing pieces are added here, nullable where the copy fills
/// them. Fixtures baselined earlier get the real tables from those migrations.
pub(crate) async fn ensure_custom_action_schedule_prerequisites(pool: &SqlitePool) {
    ensure_subagent_runs_prerequisites(pool).await;
    if migration_applied(pool, 20260425153153).await {
        sqlx::raw_sql(
            "CREATE TABLE IF NOT EXISTS features (id INTEGER PRIMARY KEY AUTOINCREMENT);
             CREATE TABLE IF NOT EXISTS custom_actions (id INTEGER PRIMARY KEY AUTOINCREMENT);
             CREATE TABLE IF NOT EXISTS custom_action_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT);",
        )
        .execute(pool)
        .await
        .unwrap();
        for (column, ddl_type) in [
            ("action_id", "INTEGER NOT NULL DEFAULT 0"),
            ("feature_id", "INTEGER NOT NULL DEFAULT 0"),
            ("interval_seconds", "INTEGER NOT NULL DEFAULT 60"),
            ("enabled", "INTEGER NOT NULL DEFAULT 1"),
        ] {
            ensure_column(pool, "custom_action_schedules", column, ddl_type).await;
        }
    }
    if migration_applied(pool, 20260724120000).await {
        sqlx::raw_sql(
            "CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT)",
        )
        .execute(pool)
        .await
        .unwrap();
        for column in [
            "prompt",
            "target_kind",
            "feature_id",
            "recurrence_kind",
            "interval_seconds",
            "timezone",
            "enabled",
            "next_run_at",
        ] {
            ensure_column(pool, "schedules", column, "").await;
        }
    }
}

/// The sent-message counter migration (20261011120000) adds a column to
/// `provider_usage_stats` and backfills it from `agent_messages` joined to
/// `agent_sessions` and `agent_message_origins`, which minimal fixtures omit.
///
/// A table is only declared when the fixture's applied migrations say it
/// already exists — declaring it earlier would make its own migration fail —
/// so call this, and `create_schedules_migration_prerequisites` which calls
/// it, after seeding `_sqlx_migrations`.
pub(crate) async fn ensure_user_message_count_prerequisites(pool: &SqlitePool) {
    // Baseline tables: every seeded fixture has them applied.
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS agent_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await
    .unwrap();
    if migration_applied(pool, 20260618120000).await {
        sqlx::raw_sql(
            "CREATE TABLE IF NOT EXISTS agent_message_origins (
                message_id INTEGER PRIMARY KEY,
                origin_kind TEXT NOT NULL
            )",
        )
        .execute(pool)
        .await
        .unwrap();
    }
    // Token-only shape: the one 20260802120000 leaves behind.
    if migration_applied(pool, 20260802120000).await {
        sqlx::raw_sql(
            "CREATE TABLE IF NOT EXISTS provider_usage_stats (
                day TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model_id TEXT NOT NULL DEFAULT '',
                thinking_effort TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (day, provider_id, model_id, thinking_effort)
            )",
        )
        .execute(pool)
        .await
        .unwrap();
    }
    for column in ["runtime_provider", "model", "thinking_effort"] {
        ensure_column(pool, "agent_sessions", column, "TEXT").await;
    }
    for (column, ddl_type) in [
        ("content", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT"),
        ("message_type", "TEXT NOT NULL DEFAULT 'text'"),
        ("parent_tool_use_id", "TEXT"),
        // The sub-agent registry migration (20261030120000) indexes carriers.
        ("tool_name", "TEXT"),
        ("tool_use_id", "TEXT"),
    ] {
        ensure_column(pool, "agent_messages", column, ddl_type).await;
    }
    if migration_applied(pool, 20260712200000).await {
        ensure_column(pool, "agent_messages", "message_uuid", "TEXT").await;
    }
    ensure_schedule_condition_prerequisites(pool).await;
    ensure_custom_action_schedule_prerequisites(pool).await;
}

/// The command-condition migration (20261016120000) adds columns to
/// `schedules`. Fixtures baselined after the runtime-pins migration
/// (20260725101500) never created it, because nothing later touched it. An
/// `ADD COLUMN` needs only the table to exist, so the bare shape suffices.
async fn ensure_schedule_condition_prerequisites(pool: &SqlitePool) {
    if migration_applied(pool, 20260725101500).await {
        sqlx::raw_sql(
            "CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT)",
        )
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Panics on an unseeded fixture: "not applied" would then silently skip the
/// tables the helpers above declare.
async fn migration_applied(pool: &SqlitePool, version: i64) -> bool {
    assert!(
        support::table_exists(pool, "_sqlx_migrations")
            .await
            .unwrap(),
        "seed _sqlx_migrations before declaring migration prerequisites"
    );
    !support::is_upgrade_migration_pending(pool, version)
        .await
        .unwrap()
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

/// The plugin-tabs migration (20261017090000) moves the authoring-marker
/// columns aside and re-adds them, so fixtures baselined after the marker
/// migration (20260912090000) need its era-accurate shape: both columns, their
/// CHECKs and the partial identity index.
pub(crate) async fn ensure_project_authoring_marker(pool: &SqlitePool) {
    if !support::table_exists(pool, "projects").await.unwrap()
        || support::table_has_column(pool, "projects", "authoring_target")
            .await
            .unwrap()
    {
        return;
    }
    sqlx::raw_sql(
        "ALTER TABLE projects ADD COLUMN authoring_target TEXT \
         CHECK (authoring_target IN ('theme', 'provider')); \
         ALTER TABLE projects ADD COLUMN plugin_id TEXT \
         CHECK ((authoring_target IS NULL) = (plugin_id IS NULL)); \
         CREATE UNIQUE INDEX projects_authoring_identity ON projects (authoring_target, plugin_id) \
         WHERE authoring_target IS NOT NULL;",
    )
    .execute(pool)
    .await
    .unwrap();
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
