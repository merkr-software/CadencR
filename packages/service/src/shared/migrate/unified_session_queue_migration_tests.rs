use super::{run_migrations, test_fixtures::seed_applied_migrations_before, MigrationContext};

/// The agent queue as it stood before the merge, with its legacy columns.
const OLD_AGENT_QUEUE: &str = "CREATE TABLE agent_session_message_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    source_session_id INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'delivering', 'delivered', 'error', 'cancelled')
    ),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT,
    error TEXT,
    message_uuid TEXT,
    claim_token TEXT,
    claimed_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0
);";

type MovedRow = (
    i64,
    String,
    String,
    String,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

#[tokio::test]
async fn open_agent_messages_move_into_the_session_queue() {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL DEFAULT 1,
                                      status TEXT NOT NULL DEFAULT 'idle');
         INSERT INTO agent_sessions (id) VALUES (1), (2), (3);",
    )
    .execute(&pool)
    .await
    .unwrap();
    for sql in [
        OLD_AGENT_QUEUE,
        include_str!("../../../migrations/20261024210000_session_prompt_queue.sql"),
        include_str!("../../../migrations/20261026210000_prompt_queue_message_identity.sql"),
        include_str!("../../../migrations/20261026230000_restart_continuations.sql"),
        include_str!("../../../migrations/20261120143700_restart_background_work.sql"),
        include_str!("../../../migrations/20261120183000_restart_stop_and_quit_intent.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&pool).await.unwrap();
    }
    seed_applied_migrations_before(&pool, 20261122010000).await;
    super::test_fixtures::ensure_custom_action_schedule_prerequisites(&pool).await;
    sqlx::raw_sql(
        "INSERT INTO agent_session_prompt_queue
             (id, session_id, content, source_message_uuid, message_uuid)
         VALUES (1, 1, 'user prompt', '6168c375-ab33-46b2-b597-0a317dddd85d',
                 '6168c375-ab33-46b2-b597-0a317dddd85d'),
                (8, 1, 'another user prompt', 'c34fe5ab-4f1e-4538-93d0-cf6cc0a39b02',
                 'c34fe5ab-4f1e-4538-93d0-cf6cc0a39b02');
         INSERT INTO agent_session_message_queue
             (id, target_session_id, source_session_id, content, status, error, message_uuid,
              claim_token, attempt_count)
         VALUES (1, 1, 2, 'pending from 2', 'pending', NULL,
                 '6168c375-ab33-46b2-b597-0a317dddd85d', NULL, 0),
                (2, 1, 3, 'in flight from 3', 'delivering', NULL,
                 'c34fe5ab-4f1e-4538-93d0-cf6cc0a39b02', 'tok', 1),
                (3, 1, 2, 'failed from 2', 'error', 'offline', 'a-3', NULL, 1),
                (4, 1, 2, 'delivered', 'delivered', NULL, 'a-4', NULL, 1),
                (5, 2, NULL, 'legacy event', 'pending', NULL, NULL, NULL, 0);
         INSERT INTO agent_messages (id, session_id, role, content, message_uuid)
         VALUES (1, 1, 'user', 'in flight from 3', 'c34fe5ab-4f1e-4538-93d0-cf6cc0a39b02');
         INSERT INTO agent_message_origins (message_id, origin_kind, source_session_id, note)
         VALUES (1, 'session_generated', 3, 'delivered from queued session message');
         PRAGMA foreign_keys=OFF;
         INSERT INTO agent_session_message_queue
             (id, target_session_id, source_session_id, content, status, message_uuid)
         VALUES (6, 99, 2, 'for a deleted session', 'pending', 'a-6'),
                (7, 2, 98, 'from a deleted session', 'pending', 'a-7');
         PRAGMA foreign_keys=ON;",
    )
    .execute(&pool)
    .await
    .unwrap();
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    let rows: Vec<MovedRow> = sqlx::query_as(
        "SELECT session_id, content, status, origin_kind, source_session_id,
                source_message_uuid, message_uuid, original_content, attempt_count
         FROM agent_session_prompt_queue ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let row =
        |session: i64, content: &str, status: &str, kind: &str, source, uuid: Option<&str>| {
            (
                session,
                content.to_string(),
                status.to_string(),
                kind.to_string(),
                source,
                uuid.map(str::to_string),
                uuid.map(str::to_string),
                (kind == "session").then(|| content.to_string()),
                i64::from(status == "delivering"),
            )
        };
    let shared_uuid = Some("6168c375-ab33-46b2-b597-0a317dddd85d");
    let sent_uuid = Some("c34fe5ab-4f1e-4538-93d0-cf6cc0a39b02");
    let user = row(1, "user prompt", "pending", "user", None, shared_uuid);
    let mut agent = row(
        1,
        "pending from 2",
        "pending",
        "session",
        Some(2),
        shared_uuid,
    );
    let mut other_user = row(1, "another user prompt", "pending", "user", None, sent_uuid);
    for (expected, actual) in [(&mut other_user, &rows[1]), (&mut agent, &rows[2])] {
        let replacement = actual.6.as_deref().unwrap();
        assert_ne!(Some(replacement), expected.5.as_deref());
        assert_eq!(
            uuid::Uuid::parse_str(replacement).unwrap().to_string(),
            replacement
        );
        expected.6 = actual.6.clone();
    }
    assert_eq!(
        rows,
        vec![
            user,
            other_user,
            agent,
            row(
                1,
                "in flight from 3",
                "delivering",
                "session",
                Some(3),
                sent_uuid
            ),
            row(2, "legacy event", "pending", "session", None, None),
            row(
                2,
                "from a deleted session",
                "pending",
                "session",
                None,
                Some("a-7")
            ),
        ]
    );
    let left: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, status FROM agent_session_message_queue ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        left,
        [
            (1, "cancelled".into()),
            (2, "cancelled".into()),
            (3, "error".into()),
            (4, "delivered".into()),
            (5, "cancelled".into()),
            (6, "cancelled".into()),
            (7, "cancelled".into())
        ]
    );
    // Deleting a sender keeps what it queued.
    sqlx::query("DELETE FROM agent_sessions WHERE id = 3")
        .execute(&pool)
        .await
        .unwrap();
    let orphaned: Option<i64> = sqlx::query_scalar(
        "SELECT source_session_id FROM agent_session_prompt_queue WHERE content = 'in flight from 3'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(orphaned, None);
    assert!(sqlx::query(
        "INSERT INTO agent_session_prompt_queue (session_id, content, origin_kind)
         VALUES (1, 'x', 'robot')"
    )
    .execute(&pool)
    .await
    .is_err());
    // The old table keeps its orphans; the queue gained none.
    let violations: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_foreign_key_check('agent_session_prompt_queue')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(violations, 0);
}
