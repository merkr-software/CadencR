use sqlx::{AssertSqlSafe, FromRow, SqlitePool};

use super::limits::MAX_AGENT_MESSAGE_LIMIT;
use super::models::{
    UnifiedAgentEntry, UnifiedAgentFeature, UnifiedAgentProject, UnifiedAgentsMode,
    UnifiedAgentsResponse,
};
use super::repository;
use crate::error::AppError;

#[derive(Debug, FromRow)]
struct UnifiedAgentCandidate {
    project_id: i64,
    project_name: String,
    project_path: String,
    feature_id: i64,
    feature_title: String,
    feature_type: String,
    feature_label: Option<String>,
    feature_created_at: String,
    session_id: i64,
    agent_created_at: String,
    last_activity_at: Option<String>,
    is_pinned: bool,
}

#[derive(Debug, Clone)]
pub struct UnifiedAgentsQuery {
    pub mode: UnifiedAgentsMode,
    pub fresh_minutes: i64,
    pub project_id: Option<i64>,
    pub message_limit: i64,
}

pub async fn list_unified_agents(
    pool: &SqlitePool,
    query: UnifiedAgentsQuery,
) -> Result<UnifiedAgentsResponse, AppError> {
    let candidates = load_candidates(pool, &query).await?;
    if candidates.is_empty() {
        return Ok(UnifiedAgentsResponse { agents: Vec::new() });
    }

    let candidate_session_ids: Vec<i64> = candidates.iter().map(|c| c.session_id).collect();
    let limit = query.message_limit.clamp(1, MAX_AGENT_MESSAGE_LIMIT);
    let mut states_by_session =
        repository::get_sessions_agent_state_batch(pool, &candidate_session_ids, limit).await?;

    let mut agents = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let Some(session) = states_by_session.remove(&candidate.session_id) else {
            continue;
        };
        agents.push(UnifiedAgentEntry {
            project: UnifiedAgentProject {
                id: candidate.project_id,
                name: candidate.project_name,
                path: candidate.project_path,
            },
            feature: UnifiedAgentFeature {
                id: candidate.feature_id,
                title: candidate.feature_title,
                type_: candidate.feature_type,
                label: candidate.feature_label,
                created_at: candidate.feature_created_at,
            },
            session,
            agent_created_at: candidate.agent_created_at,
            last_activity_at: candidate.last_activity_at,
            is_pinned: candidate.is_pinned,
        });
    }

    Ok(UnifiedAgentsResponse { agents })
}

fn load_candidates_sql(query: &UnifiedAgentsQuery) -> String {
    let mut sql = String::from(
        r#"WITH candidates AS MATERIALIZED (
               SELECT
                   p.id AS project_id,
                   p.name AS project_name,
                   p.path AS project_path,
                   f.id AS feature_id,
                   f.title AS feature_title,
                   f.type AS feature_type,
                   f.label AS feature_label,
                   f.created_at AS feature_created_at,
                   s.id AS session_id,
                   s.status AS session_status,
                   s.pending_questions AS pending_questions,
                   s.pending_permission AS pending_permission,
                   COALESCE(s.started_at, f.created_at) AS created_raw,
                   COALESCE(
                       (SELECT m.created_at
                        FROM agent_messages m
                        WHERE m.session_id = s.id
                        ORDER BY m.created_at DESC
                        LIMIT 1),
                       s.started_at,
                       f.created_at
                   ) AS activity_raw,
                   f.is_pinned != 0 AS is_pinned
               FROM agent_sessions s
               INNER JOIN features f ON f.id = s.feature_id
               INNER JOIN projects p ON p.id = f.project_id
               WHERE f.status = 'active'
                 AND (f.is_pinned != 0 OR (1 = 1"#,
    );
    if query.project_id.is_some() {
        sql.push_str(" AND p.id = ?");
    }
    sql.push_str(
        r#"))
           )
           SELECT
               project_id,
               project_name,
               project_path,
               feature_id,
               feature_title,
               feature_type,
               feature_label,
               feature_created_at,
               session_id,
               strftime('%Y-%m-%dT%H:%M:%SZ', created_raw) AS agent_created_at,
               strftime('%Y-%m-%dT%H:%M:%SZ', activity_raw) AS last_activity_at,
               is_pinned
           FROM candidates"#,
    );
    if matches!(query.mode, UnifiedAgentsMode::Recent) {
        sql.push_str(
            r#" WHERE is_pinned != 0
                 OR session_status = 'running'
                 OR pending_questions IS NOT NULL
                 OR pending_permission IS NOT NULL
                 OR datetime(activity_raw) >= datetime('now', ?)"#,
        );
    }
    sql.push_str(" ORDER BY agent_created_at DESC, session_id DESC");
    sql
}

async fn load_candidates(
    pool: &SqlitePool,
    query: &UnifiedAgentsQuery,
) -> Result<Vec<UnifiedAgentCandidate>, AppError> {
    let sql = load_candidates_sql(query);
    let mut q = sqlx::query_as::<_, UnifiedAgentCandidate>(AssertSqlSafe(sql));
    if let Some(project_id) = query.project_id {
        q = q.bind(project_id);
    }
    if matches!(query.mode, UnifiedAgentsMode::Recent) {
        q = q.bind(format!("-{} minutes", query.fresh_minutes.max(1)));
    }
    Ok(q.fetch_all(pool).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real migrated schema: hydration reads origins and names the todo
    /// index, so a hand-written subset would drift from production.
    async fn setup_pool() -> SqlitePool {
        crate::shared::test_query_plan::migrated_pool().await
    }

    #[tokio::test]
    async fn recent_mode_includes_running_and_orders_by_creation() {
        let pool = setup_pool().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/p')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title, status, created_at, type) VALUES (1, 1, 'old', 'active', datetime('now', '-1 day'), 'ws-session'), (2, 1, 'new', 'active', datetime('now', '-12 hours'), 'ws-session')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_sessions (id, feature_id, agent_type, status, started_at) VALUES (10, 1, 'session', 'running', datetime('now', '-1 day')), (20, 2, 'session', 'running', datetime('now', '-12 hours'))")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_messages (session_id, role, content, message_type, created_at) VALUES (10, 'assistant', 'fresh', 'text', datetime('now'))",
        )
        .execute(&pool)
        .await
        .unwrap();

        let result = list_unified_agents(
            &pool,
            UnifiedAgentsQuery {
                mode: UnifiedAgentsMode::Recent,
                fresh_minutes: 5,
                project_id: None,
                message_limit: 10,
            },
        )
        .await
        .unwrap();

        assert_eq!(result.agents.len(), 2);
        assert_eq!(result.agents[0].session.session_db_id, 20);
        assert_eq!(result.agents[1].session.session_db_id, 10);
        assert!(result.agents[1].agent_created_at.ends_with('Z'));
        assert!(result.agents[0]
            .last_activity_at
            .as_deref()
            .is_some_and(|value| value.contains('T') && value.ends_with('Z')));
    }

    #[tokio::test]
    async fn all_mode_excludes_archived_features() {
        let pool = setup_pool().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/p')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, created_at, type) VALUES \
             (1, 1, 'visible', 'active', datetime('now'), 'ws-session'), \
             (2, 1, 'hidden', 'archived', datetime('now'), 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, started_at) VALUES \
             (1, 1, 'session', 'completed', datetime('now')), \
             (2, 2, 'session', 'completed', datetime('now'))",
        )
        .execute(&pool)
        .await
        .unwrap();

        let result = list_unified_agents(
            &pool,
            UnifiedAgentsQuery {
                mode: UnifiedAgentsMode::All,
                fresh_minutes: 5,
                project_id: None,
                message_limit: 10,
            },
        )
        .await
        .unwrap();

        assert_eq!(result.agents.len(), 1);
        assert_eq!(result.agents[0].feature.id, 1);
    }

    #[tokio::test]
    async fn conversations_in_theme_projects_show_up_like_any_other() {
        // A theme is edited in a real conversation rooted at the theme's own
        // folder, in a project the user can see. An agent restyling the app is
        // work in progress like any other, so the grid lists it.
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO projects (id, name, path, kind) VALUES (1, 'p', '/p', 'user'), (2, 'My Theme', '/themes/my-theme', 'theme')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title, status, created_at, type) VALUES (1, 1, 'work', 'active', datetime('now'), 'ws-session'), (2, 2, 'My Theme', 'active', datetime('now'), 'ws-session')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_sessions (id, feature_id, agent_type, status, started_at) VALUES (10, 1, 'session', 'idle', datetime('now')), (20, 2, 'session', 'idle', datetime('now'))")
            .execute(&pool)
            .await
            .unwrap();

        let result = list_unified_agents(
            &pool,
            UnifiedAgentsQuery {
                mode: UnifiedAgentsMode::All,
                fresh_minutes: 5,
                project_id: None,
                message_limit: 10,
            },
        )
        .await
        .unwrap();

        let mut features: Vec<i64> = result.agents.iter().map(|agent| agent.feature.id).collect();
        features.sort_unstable();
        assert_eq!(features, vec![1, 2]);
    }

    #[tokio::test]
    async fn pinned_features_bypass_recent_and_project_filters() {
        let pool = setup_pool().await;
        sqlx::query(
            "INSERT INTO projects (id, name, path) VALUES (1, 'p1', '/p1'), (2, 'p2', '/p2')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Feature 2 is pinned, so its session must surface even though it lives
        // in another project and falls outside the Recent window.
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, created_at, type, is_pinned) VALUES (1, 1, 'a', 'active', datetime('now', '-1 day'), 'ws-session', 0), (2, 2, 'b', 'active', datetime('now', '-1 day'), 'ws-session', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, started_at) VALUES (1, 1, 'session', 'completed', datetime('now', '-1 day')), (2, 2, 'session', 'completed', datetime('now', '-1 day'))",
        )
        .execute(&pool)
        .await
        .unwrap();

        let result = list_unified_agents(
            &pool,
            UnifiedAgentsQuery {
                mode: UnifiedAgentsMode::Recent,
                fresh_minutes: 5,
                project_id: Some(1),
                message_limit: 10,
            },
        )
        .await
        .unwrap();

        assert_eq!(result.agents.len(), 1);
        assert_eq!(result.agents[0].session.session_db_id, 2);
        assert!(result.agents[0].is_pinned);
    }

    #[tokio::test]
    async fn load_candidates_uses_session_created_index_on_migrated_db() {
        use crate::shared::test_query_plan::{assert_no_full_scan, migrated_pool, plan_details};
        let pool = migrated_pool().await;

        for (mode, project_id) in [
            (UnifiedAgentsMode::All, None),
            (UnifiedAgentsMode::Recent, None),
            (UnifiedAgentsMode::Recent, Some(1)),
        ] {
            let query = UnifiedAgentsQuery {
                mode,
                fresh_minutes: 30,
                project_id,
                message_limit: 10,
            };
            let explain_sql = format!("EXPLAIN QUERY PLAN {}", load_candidates_sql(&query));
            let mut q = sqlx::query_as::<_, (i64, i64, i64, String)>(AssertSqlSafe(explain_sql));
            if let Some(project_id) = project_id {
                q = q.bind(project_id);
            }
            if matches!(query.mode, UnifiedAgentsMode::Recent) {
                q = q.bind("-30 minutes");
            }
            let details = plan_details(&q.fetch_all(&pool).await.unwrap());
            assert!(
                details.contains("idx_agent_messages_session_created"),
                "expected idx_agent_messages_session_created seek:\n{details}"
            );
            assert!(
                details.contains("idx_agent_sessions_feature_id"),
                "expected sessions to be reached per feature through idx_agent_sessions_feature_id:\n{details}"
            );
            assert_no_full_scan(&details, &["candidates"]);
        }
    }

    #[tokio::test]
    async fn batched_unified_agents_matches_feature_agent_state_parity() {
        let pool = setup_pool().await;

        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p1', '/p1')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, created_at, type) VALUES \
             (1, 1, 'f1', 'active', datetime('now', '-2 hours'), 'ws-session'), \
             (2, 1, 'f2', 'active', datetime('now', '-1 hour'), 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, started_at) VALUES \
             (10, 1, 'session', 'completed', datetime('now', '-2 hours')), \
             (20, 2, 'session', 'running', datetime('now', '-1 hour'))",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Session 10: initial user message + origin + 4 messages (so limit=2 triggers has_more + anchor) + TodoWrite.
        let user_msg_id: (i64,) = sqlx::query_as(
            "INSERT INTO agent_messages (session_id, role, content, message_type, created_at) \
             VALUES (10, 'user', 'initial prompt', 'user_message', datetime('now', '-90 minutes')) RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_message_origins (message_id, origin_kind, source_session_id, note) \
             VALUES (?, 'session_generated', 20, 'delegated')",
        )
        .bind(user_msg_id.0)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_messages (session_id, role, content, message_type, tool_name, tool_use_id, created_at) VALUES \
             (10, 'assistant', '{\"todos\":[{\"content\":\"ship\",\"status\":\"completed\",\"activeForm\":\"shipping\"}]}', 'tool_call', 'TodoWrite', 'tw-1', datetime('now', '-80 minutes')), \
             (10, 'assistant', '{\"cmd\":\"ls\"}', 'tool_call', 'Bash', 'b-1', datetime('now', '-70 minutes')), \
             (10, 'assistant', 'output', 'tool_result', NULL, 'b-1', datetime('now', '-60 minutes'))",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Session 20: simple text message, no has_more.
        sqlx::query(
            "INSERT INTO agent_messages (session_id, role, content, message_type, created_at) \
             VALUES (20, 'assistant', 'working', 'text', datetime('now', '-5 minutes'))",
        )
        .execute(&pool)
        .await
        .unwrap();

        let unified = list_unified_agents(
            &pool,
            UnifiedAgentsQuery {
                mode: UnifiedAgentsMode::All,
                fresh_minutes: 30,
                project_id: None,
                message_limit: 2,
            },
        )
        .await
        .unwrap();
        assert_eq!(unified.agents.len(), 2);

        for entry in &unified.agents {
            let expected = repository::get_feature_agent_state(
                &pool,
                entry.feature.id,
                None,
                None,
                Some(2),
                None,
            )
            .await
            .unwrap();
            let expected_session = expected
                .sessions
                .into_iter()
                .find(|s| s.session_db_id == entry.session.session_db_id)
                .unwrap();
            assert_eq!(
                serde_json::to_value(&entry.session).unwrap(),
                serde_json::to_value(&expected_session).unwrap(),
                "session {} diverged from get_feature_agent_state",
                entry.session.session_db_id
            );
        }

        let s10 = unified
            .agents
            .iter()
            .find(|a| a.session.session_db_id == 10)
            .unwrap();
        assert!(s10.session.has_more);
        assert!(s10.session.todos.as_ref().is_some_and(|t| t.len() == 1));
        assert_eq!(
            s10.session.blocks[0]
                .origin
                .as_ref()
                .map(|o| o.origin_kind.as_str()),
            Some("session_generated")
        );
    }
}
