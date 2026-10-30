//! SQL for `agent_subagent_runs`. Each change is a read-merge-write. A
//! session's runs are written by its current stream reader; the only overlap
//! is a new reader stopping orphans while the superseded one stops its live
//! runs, and both write the same Stopped patch, so either order lands the same.

use sqlx::{Row, SqlitePool};

use super::model::{now_timestamp, SubagentRun, SubagentRunStatus};
use crate::domain::agents::adapter::{stop_reason, RuntimeSubagentPatch};

macro_rules! columns {
    () => {
        "session_id, tool_use_id, parent_tool_use_id, status, status_reason, agent_type, \
         agent_name, description, prompt, model, model_resolved, reasoning_effort, background, \
         child_session_id, duration_ms, total_tokens, tool_use_count, result_summary, started_at, \
         ended_at"
    };
}

/// One fact about one sub-agent, as the tracker hands it to the repository.
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentChange {
    pub tool_use_id: String,
    /// Carrier of the launching sub-agent, known when the carrier is first seen.
    pub parent_tool_use_id: Option<String>,
    pub patch: RuntimeSubagentPatch,
}

pub async fn load(
    pool: &SqlitePool,
    session_id: i64,
    tool_use_id: &str,
) -> Result<Option<SubagentRun>, sqlx::Error> {
    let row = sqlx::query(concat!(
        "SELECT ",
        columns!(),
        " FROM agent_subagent_runs WHERE session_id = ? AND tool_use_id = ?"
    ))
    .bind(session_id)
    .bind(tool_use_id)
    .fetch_optional(pool)
    .await?;
    row.map(|row| run_from_row(&row)).transpose()
}

/// Merge `change` into the session's run, creating it on first sight.
/// Returns the run when something the desktop shows changed.
pub async fn apply_change(
    pool: &SqlitePool,
    session_id: i64,
    change: &SubagentChange,
) -> Result<Option<SubagentRun>, sqlx::Error> {
    let now = now_timestamp();
    let existing = load(pool, session_id, &change.tool_use_id).await?;
    let is_new = existing.is_none();
    let mut run = existing.unwrap_or_else(|| {
        SubagentRun::launched()
            .session_id(session_id)
            .tool_use_id(&change.tool_use_id)
            .maybe_parent_tool_use_id(change.parent_tool_use_id.as_deref())
            .now(&now)
            .call()
    });
    if run.parent_tool_use_id.is_none() && change.parent_tool_use_id.is_some() {
        run.parent_tool_use_id = change.parent_tool_use_id.clone();
    }
    let changed = run.apply(&change.patch, &now);
    if !(changed || is_new) {
        return Ok(None);
    }
    save(pool, &run, &now).await?;
    Ok(Some(run))
}

async fn save(pool: &SqlitePool, run: &SubagentRun, now: &str) -> Result<(), sqlx::Error> {
    sqlx::query(concat!(
        "INSERT INTO agent_subagent_runs (",
        columns!(),
        ", updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, tool_use_id) DO UPDATE SET
            parent_tool_use_id = excluded.parent_tool_use_id,
            status = excluded.status,
            status_reason = excluded.status_reason,
            agent_type = excluded.agent_type,
            agent_name = excluded.agent_name,
            description = excluded.description,
            prompt = excluded.prompt,
            model = excluded.model,
            model_resolved = excluded.model_resolved,
            reasoning_effort = excluded.reasoning_effort,
            background = excluded.background,
            child_session_id = excluded.child_session_id,
            duration_ms = excluded.duration_ms,
            total_tokens = excluded.total_tokens,
            tool_use_count = excluded.tool_use_count,
            result_summary = excluded.result_summary,
            ended_at = excluded.ended_at,
            updated_at = excluded.updated_at"
    ))
    .bind(run.session_id)
    .bind(&run.tool_use_id)
    .bind(&run.parent_tool_use_id)
    .bind(run.status.as_str())
    .bind(&run.status_reason)
    .bind(&run.agent_type)
    .bind(&run.agent_name)
    .bind(&run.description)
    .bind(&run.prompt)
    .bind(&run.model)
    .bind(run.model_resolved)
    .bind(&run.reasoning_effort)
    .bind(run.background)
    .bind(&run.child_session_id)
    .bind(run.duration_ms)
    .bind(run.total_tokens)
    .bind(run.tool_use_count)
    .bind(&run.result_summary)
    .bind(&run.started_at)
    .bind(&run.ended_at)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Carriers of the session's sub-agents still marked running. With
/// `include_background` false, only those bound to the launching turn: not a
/// background agent, nor anything a background agent launched.
pub async fn running_tool_use_ids(
    pool: &SqlitePool,
    session_id: i64,
    include_background: bool,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "WITH RECURSIVE detached(tool_use_id) AS (
            SELECT tool_use_id FROM agent_subagent_runs
             WHERE session_id = ? AND background = 1
            UNION
            SELECT r.tool_use_id FROM agent_subagent_runs r
              JOIN detached d ON r.parent_tool_use_id = d.tool_use_id
             WHERE r.session_id = ?
         )
         SELECT tool_use_id FROM agent_subagent_runs
         WHERE session_id = ? AND status = 'running'
           AND (? OR tool_use_id NOT IN (SELECT tool_use_id FROM detached))
         ORDER BY id",
    )
    .bind(session_id)
    .bind(session_id)
    .bind(session_id)
    .bind(include_background)
    .fetch_all(pool)
    .await
}

/// No sub-agent outlives the service that ran it: a run still marked running
/// at startup lost its runtime when the previous service stopped.
pub async fn stop_runs_orphaned_by_restart(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    let now = now_timestamp();
    let result = sqlx::query(
        "UPDATE agent_subagent_runs
         SET status = 'stopped', status_reason = ?,
             ended_at = COALESCE(ended_at, ?), updated_at = ?
         WHERE status = 'running'",
    )
    .bind(stop_reason::SERVICE_RESTARTED)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub(super) fn run_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<SubagentRun, sqlx::Error> {
    let status: String = row.try_get("status")?;
    Ok(SubagentRun {
        session_id: row.try_get("session_id")?,
        tool_use_id: row.try_get("tool_use_id")?,
        parent_tool_use_id: row.try_get("parent_tool_use_id")?,
        status: SubagentRunStatus::parse(&status).unwrap_or(SubagentRunStatus::Stopped),
        status_reason: row.try_get("status_reason")?,
        agent_type: row.try_get("agent_type")?,
        agent_name: row.try_get("agent_name")?,
        description: row.try_get("description")?,
        prompt: row.try_get("prompt")?,
        model: row.try_get("model")?,
        model_resolved: row.try_get("model_resolved")?,
        reasoning_effort: row.try_get("reasoning_effort")?,
        background: row.try_get("background")?,
        child_session_id: row.try_get("child_session_id")?,
        duration_ms: row.try_get("duration_ms")?,
        total_tokens: row.try_get("total_tokens")?,
        tool_use_count: row.try_get("tool_use_count")?,
        result_summary: row.try_get("result_summary")?,
        started_at: row.try_get("started_at")?,
        ended_at: row.try_get("ended_at")?,
        action_count: None,
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    use crate::shared::migrate::{run_migrations, MigrationContext};

    /// In-memory database with the real migrations applied.
    pub async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        pool
    }

    /// A project, feature and session to hang runs and messages on.
    pub async fn seeded_session(pool: &SqlitePool) -> (i64, i64) {
        let project_id: i64 = sqlx::query_scalar(
            "INSERT INTO projects (name, path) VALUES ('p', '/tmp/p') RETURNING id",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        let feature_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, 'f') RETURNING id",
        )
        .bind(project_id)
        .fetch_one(pool)
        .await
        .unwrap();
        let session_id: i64 =
            sqlx::query_scalar("INSERT INTO agent_sessions (feature_id, agent_type) VALUES (?, 'session') RETURNING id")
                .bind(feature_id)
                .fetch_one(pool)
                .await
                .unwrap();
        (feature_id, session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::RuntimeSubagentStatus;

    async fn seeded_session(pool: &SqlitePool) -> i64 {
        test_support::seeded_session(pool).await.1
    }

    fn change(patch: RuntimeSubagentPatch) -> SubagentChange {
        SubagentChange {
            tool_use_id: "toolu_1".into(),
            parent_tool_use_id: None,
            patch,
        }
    }

    #[tokio::test]
    async fn creates_merges_and_skips_noops() {
        let pool = test_support::migrated_pool().await;
        let session_id = seeded_session(&pool).await;
        let launch = RuntimeSubagentPatch {
            status: Some(RuntimeSubagentStatus::Running),
            description: Some("Audit".into()),
            ..RuntimeSubagentPatch::default()
        };
        let created = apply_change(&pool, session_id, &change(launch.clone()))
            .await
            .unwrap()
            .expect("first sight is a change");
        assert_eq!(created.description.as_deref(), Some("Audit"));
        assert!(apply_change(&pool, session_id, &change(launch))
            .await
            .unwrap()
            .is_none());

        let done = apply_change(
            &pool,
            session_id,
            &change(RuntimeSubagentPatch::status(
                RuntimeSubagentStatus::Completed,
            )),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(done.status, SubagentRunStatus::Completed);
        assert!(done.ended_at.is_some());
        assert_eq!(done.description.as_deref(), Some("Audit"));
        assert_eq!(
            load(&pool, session_id, "toolu_1").await.unwrap(),
            Some(done)
        );
    }

    #[tokio::test]
    async fn startup_stops_running_runs_and_running_ids_filter_background() {
        let pool = test_support::migrated_pool().await;
        let session_id = seeded_session(&pool).await;
        apply_change(&pool, session_id, &change(RuntimeSubagentPatch::default()))
            .await
            .unwrap();
        let background = SubagentChange {
            tool_use_id: "toolu_bg".into(),
            parent_tool_use_id: None,
            patch: RuntimeSubagentPatch {
                background: Some(true),
                ..RuntimeSubagentPatch::default()
            },
        };
        apply_change(&pool, session_id, &background).await.unwrap();
        // Launched by the background agent: its turn's end is not this one's.
        let nested = SubagentChange {
            tool_use_id: "toolu_nested".into(),
            parent_tool_use_id: Some("toolu_bg".into()),
            patch: RuntimeSubagentPatch::default(),
        };
        apply_change(&pool, session_id, &nested).await.unwrap();
        assert_eq!(
            running_tool_use_ids(&pool, session_id, false)
                .await
                .unwrap(),
            vec!["toolu_1".to_string()]
        );
        assert_eq!(
            running_tool_use_ids(&pool, session_id, true)
                .await
                .unwrap()
                .len(),
            3
        );
        assert_eq!(stop_runs_orphaned_by_restart(&pool).await.unwrap(), 3);
        let stopped = load(&pool, session_id, "toolu_bg").await.unwrap().unwrap();
        assert_eq!(stopped.status, SubagentRunStatus::Stopped);
        assert_eq!(stopped.status_reason.as_deref(), Some("service_restarted"));
    }
}
