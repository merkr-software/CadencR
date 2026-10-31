//! A feature's sub-agents, newest first.
//!
//! The transcript's carriers are the anchor: a run whose carrier a rewind
//! removed disappears with it, and a carrier persisted before the registry
//! existed still lists, its status derived from the carrier's result.

use serde_json::Value;
use sqlx::{Row, SqlitePool};

use super::model::{SubagentRun, SubagentRunStatus};
use super::repository::run_from_row;
use crate::domain::agents::adapter::{summarize_subagent_result, RuntimeSubagentPatch};

/// Plenty for a conversation; older runs stay in its transcript.
const MAX_RUNS: i64 = 500;

/// Carriers first (the `+` keeps the planner on the partial carriers index
/// instead of scanning every tool row), then each one's registry row and
/// transcript counts. Content and last activity are only read for untracked,
/// pre-registry runs; the observed model only while none is resolved.
const LIST_SQL: &str = "WITH carriers AS (
            SELECT m.session_id, m.tool_use_id, MIN(m.id) AS first_id, MAX(m.id) AS last_id
            FROM agent_messages m
            JOIN agent_sessions s ON s.id = m.session_id
            WHERE s.feature_id = ? AND m.message_type = 'tool_call'
              AND m.tool_name IN ('Task', 'Agent') AND +m.tool_use_id IS NOT NULL
            GROUP BY m.session_id, m.tool_use_id
            ORDER BY first_id DESC
            LIMIT ?
         )
         SELECT c.session_id, c.tool_use_id,
            first.parent_tool_use_id AS carrier_parent,
            first.created_at AS carrier_created_at,
            CASE WHEN r.tool_use_id IS NULL THEN last.content END AS carrier_input,
            r.tool_use_id AS run_tool_use_id, r.parent_tool_use_id, r.status, r.status_reason,
            r.agent_type, r.agent_name, r.description, r.prompt, r.model, r.model_resolved,
            r.reasoning_effort, r.background, r.child_session_id, r.duration_ms,
            r.total_tokens, r.tool_use_count, r.result_summary, r.started_at, r.ended_at,
            CASE WHEN r.tool_use_id IS NULL THEN
              (SELECT res.message_type || char(31) || res.created_at || char(31) || res.content
                 FROM agent_messages res
                WHERE res.session_id = c.session_id AND res.tool_use_id = c.tool_use_id
                  AND res.message_type IN ('tool_result', 'tool_error')
                ORDER BY res.id DESC LIMIT 1)
            END AS carrier_result,
            CASE WHEN r.tool_use_id IS NULL THEN
              (SELECT MAX(k.created_at) FROM agent_messages k
                WHERE k.session_id = c.session_id AND k.parent_tool_use_id = c.tool_use_id)
            END AS carrier_last_activity,
            (SELECT COUNT(*) FROM agent_messages k
              WHERE k.session_id = c.session_id AND k.parent_tool_use_id = c.tool_use_id
                AND k.message_type = 'tool_call') AS action_count,
            CASE WHEN r.model_resolved IS NOT 1 THEN
              (SELECT k.model FROM agent_messages k
                WHERE k.session_id = c.session_id AND k.parent_tool_use_id = c.tool_use_id
                  AND k.model IS NOT NULL
                ORDER BY k.id LIMIT 1)
            END AS observed_model
         FROM carriers c
         JOIN agent_messages first ON first.id = c.first_id
         JOIN agent_messages last ON last.id = c.last_id
         LEFT JOIN agent_subagent_runs r
           ON r.session_id = c.session_id AND r.tool_use_id = c.tool_use_id
         ORDER BY c.first_id DESC";

pub async fn list_for_feature(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Vec<SubagentRun>, sqlx::Error> {
    let rows = sqlx::query(LIST_SQL)
        .bind(feature_id)
        .bind(MAX_RUNS)
        .fetch_all(pool)
        .await?;
    rows.iter().map(listed_run).collect()
}

fn listed_run(row: &sqlx::sqlite::SqliteRow) -> Result<SubagentRun, sqlx::Error> {
    let tracked: Option<String> = row.try_get("run_tool_use_id")?;
    let mut run = match tracked {
        Some(_) => run_from_row(row)?,
        None => untracked_run(row)?,
    };
    run.action_count = row.try_get("action_count")?;
    let observed_model: Option<String> = row.try_get("observed_model")?;
    if !run.model_resolved {
        if let Some(model) = observed_model {
            run.model = Some(model);
            run.model_resolved = true;
        }
    }
    Ok(run)
}

/// A carrier from before the registry: launch facts from its input, status
/// from its result row.
fn untracked_run(row: &sqlx::sqlite::SqliteRow) -> Result<SubagentRun, sqlx::Error> {
    let tool_use_id: String = row.try_get("tool_use_id")?;
    let parent: Option<String> = row.try_get("carrier_parent")?;
    let started_at: String = row.try_get("carrier_created_at")?;
    let input: Option<String> = row.try_get("carrier_input")?;
    let result: Option<String> = row.try_get("carrier_result")?;
    let last_activity: Option<String> = row.try_get("carrier_last_activity")?;
    let mut run = SubagentRun::launched()
        .session_id(row.try_get("session_id")?)
        .tool_use_id(&tool_use_id)
        .maybe_parent_tool_use_id(parent.as_deref())
        .now(&started_at)
        .call();
    let input = input
        .and_then(|input| serde_json::from_str::<Value>(&input).ok())
        .unwrap_or(Value::Null);
    let mut patch = RuntimeSubagentPatch::from_tool_input(&input);
    // Status is only known from the result; the transcript keeps no other trace.
    patch.background = None;
    run.apply(&patch, &started_at);
    let (status, ended_at, summary) = derived_outcome(result.as_deref());
    run.status = status;
    run.ended_at = ended_at.or(last_activity).or(Some(started_at));
    run.result_summary = summary;
    Ok(run)
}

/// Status from the carrier's result row. Without one the run still counts as
/// completed: Codex never persists a result for its spawn carrier and OpenCode
/// suppresses the Task output, so a missing result is no sign of a failure.
fn derived_outcome(result: Option<&str>) -> (SubagentRunStatus, Option<String>, Option<String>) {
    let Some(result) = result else {
        return (SubagentRunStatus::Completed, None, None);
    };
    let mut parts = result.splitn(3, '\u{1f}');
    let kind = parts.next().unwrap_or_default();
    let ended_at = parts.next().map(str::to_string);
    let summary = parts.next().and_then(summarize_subagent_result);
    let status = if kind == "tool_error" {
        SubagentRunStatus::Failed
    } else {
        SubagentRunStatus::Completed
    };
    (status, ended_at, summary)
}

#[cfg(test)]
mod tests {
    use super::super::repository::{apply_change, test_support, SubagentChange};
    use super::*;
    use crate::domain::agents::adapter::RuntimeSubagentStatus;

    async fn insert_message(
        pool: &SqlitePool,
        session_id: i64,
        message_type: &str,
        tool_name: Option<&str>,
        tool_use_id: Option<&str>,
        parent: Option<&str>,
        content: &str,
        model: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO agent_messages
             (session_id, role, content, message_type, tool_name, tool_use_id, parent_tool_use_id, model)
             VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(content)
        .bind(message_type)
        .bind(tool_name)
        .bind(tool_use_id)
        .bind(parent)
        .bind(model)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn lists_tracked_and_legacy_carriers_newest_first() {
        let pool = test_support::migrated_pool().await;
        let (feature_id, session_id) = test_support::seeded_session(&pool).await;
        let legacy_input = r#"{"description":"Old audit","subagent_type":"Explore"}"#;
        insert_message(
            &pool,
            session_id,
            "tool_call",
            Some("Task"),
            Some("old"),
            None,
            legacy_input,
            None,
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "tool_call",
            Some("Read"),
            Some("r1"),
            Some("old"),
            "{}",
            Some("claude-haiku-5-5"),
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "tool_result",
            None,
            Some("old"),
            None,
            "All good",
            None,
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "tool_call",
            Some("Agent"),
            Some("new"),
            None,
            "{}",
            None,
        )
        .await;
        apply_change(
            &pool,
            session_id,
            &SubagentChange {
                tool_use_id: "new".into(),
                parent_tool_use_id: None,
                patch: RuntimeSubagentPatch {
                    status: Some(RuntimeSubagentStatus::Running),
                    description: Some("Live audit".into()),
                    model: Some("sonnet".into()),
                    ..RuntimeSubagentPatch::default()
                },
            },
        )
        .await
        .unwrap();

        let runs = list_for_feature(&pool, feature_id).await.unwrap();
        assert_eq!(runs.len(), 2);
        let (live, old) = (&runs[0], &runs[1]);
        assert_eq!(live.tool_use_id, "new");
        assert_eq!(live.status, SubagentRunStatus::Running);
        assert_eq!(live.description.as_deref(), Some("Live audit"));
        assert_eq!(live.model.as_deref(), Some("sonnet"));
        assert_eq!(live.action_count, Some(0));

        assert_eq!(old.status, SubagentRunStatus::Completed);
        assert_eq!(old.agent_type.as_deref(), Some("Explore"));
        assert_eq!(old.description.as_deref(), Some("Old audit"));
        assert_eq!(old.result_summary.as_deref(), Some("All good"));
        assert_eq!(old.model.as_deref(), Some("claude-haiku-5-5"));
        assert!(old.model_resolved);
        assert_eq!(old.action_count, Some(1));
    }

    #[tokio::test]
    async fn legacy_carrier_without_result_completes_at_its_last_activity() {
        let pool = test_support::migrated_pool().await;
        let (feature_id, session_id) = test_support::seeded_session(&pool).await;
        insert_message(
            &pool,
            session_id,
            "tool_call",
            Some("Agent"),
            Some("spawn"),
            None,
            r#"{"message":"Audit"}"#,
            None,
        )
        .await;
        insert_message(
            &pool,
            session_id,
            "text",
            None,
            None,
            Some("spawn"),
            "Done",
            None,
        )
        .await;
        sqlx::query(
            "UPDATE agent_messages SET created_at = CASE WHEN tool_use_id = 'spawn'
               THEN '2026-10-30 10:00:00' ELSE '2026-10-30 10:05:00' END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let runs = list_for_feature(&pool, feature_id).await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, SubagentRunStatus::Completed);
        assert_eq!(runs[0].status_reason, None);
        assert_eq!(runs[0].started_at, "2026-10-30 10:00:00");
        assert_eq!(runs[0].ended_at.as_deref(), Some("2026-10-30 10:05:00"));
        assert_eq!(runs[0].result_summary, None);
    }

    #[test]
    fn legacy_outcome_reads_error_and_missing_results() {
        assert_eq!(derived_outcome(None).0, SubagentRunStatus::Completed);
        let (status, ended, summary) =
            derived_outcome(Some("tool_error\u{1f}2026-10-30 10:00:00\u{1f}boom"));
        assert_eq!(status, SubagentRunStatus::Failed);
        assert_eq!(ended.as_deref(), Some("2026-10-30 10:00:00"));
        assert_eq!(summary.as_deref(), Some("boom"));
    }

    #[tokio::test]
    async fn carriers_come_from_the_partial_carriers_index() {
        let pool = test_support::migrated_pool().await;
        let details: Vec<String> = sqlx::query(sqlx::AssertSqlSafe(format!(
            "EXPLAIN QUERY PLAN {LIST_SQL}"
        )))
        .bind(1_i64)
        .bind(MAX_RUNS)
        .fetch_all(&pool)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("detail"))
        .collect();
        assert!(
            details
                .iter()
                .any(|detail| detail.contains("idx_agent_messages_subagent_carriers")),
            "{details:?}"
        );
        assert!(
            !details.iter().any(
                |detail| detail.contains("idx_agent_messages_session_tool_use")
                    && detail.starts_with("SCAN")
            ),
            "{details:?}"
        );
    }
}
