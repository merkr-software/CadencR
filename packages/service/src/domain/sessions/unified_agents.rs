use std::collections::{HashMap, HashSet};

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

    let feature_ids: HashSet<i64> = candidates.iter().map(|c| c.feature_id).collect();
    let candidate_session_ids: HashSet<i64> = candidates.iter().map(|c| c.session_id).collect();
    let mut states_by_session = HashMap::new();
    let limit = query.message_limit.clamp(1, MAX_AGENT_MESSAGE_LIMIT);

    for feature_id in feature_ids {
        let state =
            repository::get_feature_agent_state(pool, feature_id, None, Some(limit), None).await?;
        for session in state.sessions {
            if candidate_session_ids.contains(&session.session_db_id) {
                states_by_session.insert(session.session_db_id, session);
            }
        }
    }

    let mut agents = Vec::new();
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

async fn load_candidates(
    pool: &SqlitePool,
    query: &UnifiedAgentsQuery,
) -> Result<Vec<UnifiedAgentCandidate>, AppError> {
    let mut sql = String::from(
        r#"SELECT
               p.id AS project_id,
               p.name AS project_name,
               p.path AS project_path,
               f.id AS feature_id,
               f.title AS feature_title,
               f.type AS feature_type,
               f.label AS feature_label,
               f.created_at AS feature_created_at,
               s.id AS session_id,
               strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(s.started_at, f.created_at)) AS agent_created_at,
               strftime(
                   '%Y-%m-%dT%H:%M:%SZ',
                   COALESCE(MAX(am.created_at), s.started_at, f.created_at)
               ) AS last_activity_at,
               f.is_pinned != 0 AS is_pinned
           FROM agent_sessions s
           INNER JOIN features f ON f.id = s.feature_id
           INNER JOIN projects p ON p.id = f.project_id
           LEFT JOIN agent_messages am ON am.session_id = s.id
           WHERE f.status = 'active'"#,
    );

    sql.push_str(" AND (f.is_pinned != 0 OR (1 = 1");
    if query.project_id.is_some() {
        sql.push_str(" AND p.id = ?");
    }

    sql.push_str(")) GROUP BY s.id");
    if matches!(query.mode, UnifiedAgentsMode::Recent) {
        sql.push_str(
            r#" HAVING f.is_pinned != 0
                OR s.status = 'running'
                OR s.pending_questions IS NOT NULL
                OR s.pending_permission IS NOT NULL
                OR datetime(COALESCE(MAX(am.created_at), s.started_at, f.created_at)) >= datetime('now', ?)"#,
        );
    }
    sql.push_str(" ORDER BY agent_created_at DESC, s.id DESC");

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

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE features (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                label TEXT,
                created_at TEXT NOT NULL,
                type TEXT NOT NULL,
                is_pinned INTEGER NOT NULL DEFAULT 0
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY,
                feature_id INTEGER NOT NULL,
                agent_type TEXT NOT NULL,
                runtime_provider TEXT,
                runtime_session_id TEXT,
                status TEXT NOT NULL,
                started_at TEXT,
                ended_at TEXT,
                subprocess_id TEXT,
                model TEXT,
                profile TEXT,
                pending_questions TEXT,
                has_file_changes INTEGER DEFAULT 0,
                permission_mode TEXT,
                codex_permission_mode TEXT DEFAULT 'default',
                pending_permission TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                context_window INTEGER,
                was_compacted INTEGER DEFAULT 0,
                draft_prompt TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY,
                session_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                message_type TEXT NOT NULL,
                tool_name TEXT,
                tool_use_id TEXT,
                parent_tool_use_id TEXT,
                created_at TEXT,
                model TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
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
}
