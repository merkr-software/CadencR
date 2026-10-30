use super::{run_migrations, test_fixtures::seed_applied_migrations_before, MigrationContext};

#[tokio::test]
async fn prompt_queue_identity_preserves_legacy_rows_and_deduplicates_sources() {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY);
         INSERT INTO agent_sessions VALUES (1), (2);",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/20261024210000_session_prompt_queue.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        "INSERT INTO agent_session_prompt_queue (id,session_id,content,status,error) VALUES
         (1,1,'pending legacy','pending',NULL),
         (2,1,'failed legacy','error','provider refused'),
         (3,2,'delivered legacy','delivered',NULL);",
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_applied_migrations_before(&pool, 20261026210000).await;
    super::test_fixtures::ensure_custom_action_schedule_prerequisites(&pool).await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    type QueueRow = (
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<QueueRow> = sqlx::query_as(
        "SELECT id,content,status,error,source_message_uuid,message_uuid
         FROM agent_session_prompt_queue ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                1,
                "pending legacy".into(),
                "pending".into(),
                None,
                None,
                None
            ),
            (
                2,
                "failed legacy".into(),
                "error".into(),
                Some("provider refused".into()),
                None,
                None
            ),
            (
                3,
                "delivered legacy".into(),
                "delivered".into(),
                None,
                None,
                None
            ),
        ]
    );
    let insert = "INSERT INTO agent_session_prompt_queue
        (session_id,content,source_message_uuid,message_uuid) VALUES (?,'new','source','delivery')";
    sqlx::query(insert).bind(1).execute(&pool).await.unwrap();
    assert!(sqlx::query(insert).bind(1).execute(&pool).await.is_err());
    sqlx::query(insert).bind(2).execute(&pool).await.unwrap();
    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(violations, 0);
}
