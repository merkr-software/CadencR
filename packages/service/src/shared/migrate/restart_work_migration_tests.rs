use sqlx::migrate::Migrator;
use sqlx::sqlite::SqlitePoolOptions;

const VERSION: i64 = 20261126120000;

#[tokio::test]
async fn existing_work_and_stops_survive_the_upgrade() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let migrator = sqlx::migrate!("./migrations");
    let before = Migrator {
        migrations: migrator
            .iter()
            .filter(|m| m.version < VERSION)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    before.run(&pool).await.unwrap();
    sqlx::raw_sql(
        "PRAGMA foreign_keys = ON;
         INSERT INTO projects (id, name, path) VALUES (1, 'p', '/p');
         INSERT INTO features (id, project_id, title, status) VALUES (1, 1, 'f', 'active');
         INSERT INTO agent_sessions (id, feature_id, agent_type) VALUES
             (10, 1, 'session'), (11, 1, 'session');
         INSERT INTO agent_sessions (id, feature_id, agent_type, status) VALUES
             (12, 1, 'session', 'running');
         INSERT INTO agent_background_work (session_id) VALUES (10);
         INSERT INTO agent_user_stops (session_id, stopped_at) VALUES (11, '2026-11-25');
         INSERT INTO agent_user_stops (session_id, stopped_at) VALUES (12, '2026-11-25');
         INSERT INTO agent_messages (session_id, role, content, message_type) VALUES
             (11, 'system', '', 'turn_interrupted');",
    )
    .execute(&pool)
    .await
    .unwrap();

    migrator.run(&pool).await.unwrap();

    let reader: Option<String> =
        sqlx::query_scalar("SELECT reader_id FROM agent_background_work WHERE session_id = 10")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        reader.is_none(),
        "work left by an older service is still discoverable"
    );
    let (stopped_at, pending): (String, Option<bool>) = sqlx::query_as(
        "SELECT stopped_at, marker_pending FROM agent_user_stops WHERE session_id = 11",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stopped_at, "2026-11-25");
    assert!(
        pending.is_none(),
        "startup checks legacy stops against their transcripts"
    );
    let markers: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM agent_messages WHERE session_id = 11")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(markers, 1);
    let missing: Option<bool> =
        sqlx::query_scalar("SELECT marker_pending FROM agent_user_stops WHERE session_id = 12")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(missing.is_none());
    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(violations, 0);
}
