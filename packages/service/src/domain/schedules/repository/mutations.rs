use chrono::Utc;
use sqlx::{Row, SqlitePool};

use super::reads::get;
use crate::domain::features::worktree_validation::{validate_reuse_branch, validate_worktree_mode};
use crate::domain::schedules::models::{SaveScheduleRequest, Schedule, ScheduleTarget, TargetKind};
use crate::domain::schedules::pins::trimmed;
use crate::domain::schedules::planner;
use crate::domain::schedules::recurrence::Recurrence;
use crate::error::AppError;

/// Validated write payload: the request with its rule parsed and its first
/// firing instant resolved.
struct ScheduleWrite {
    name: Option<String>,
    prompt: String,
    target: ScheduleTarget,
    recurrence: Recurrence,
    next_run_at: Option<String>,
}

impl ScheduleWrite {
    fn from_request(body: SaveScheduleRequest) -> Result<Self, AppError> {
        let prompt = body.prompt.trim().to_string();
        if prompt.is_empty() {
            return Err(AppError::BadRequest("a prompt is required".into()));
        }
        let target = normalize_target(body.target)?;
        let (recurrence, run_at) = body.recurrence.into_recurrence()?;
        let next_run_at = planner::initial_next_run(&recurrence, run_at.as_deref(), Utc::now())?;
        Ok(Self {
            name: body
                .name
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty()),
            prompt,
            target,
            recurrence,
            next_run_at,
        })
    }
}

/// Reject a target that can't be delivered to before it is stored, rather than
/// letting the poll loop discover it and mark the schedule failed forever.
fn normalize_target(mut target: ScheduleTarget) -> Result<ScheduleTarget, AppError> {
    match target.kind {
        TargetKind::Conversation => {
            if target.feature_id.is_none() {
                return Err(AppError::BadRequest(
                    "a conversation schedule needs feature_id".into(),
                ));
            }
            // An existing conversation owns its agent and its working copy, so
            // those can't be overridden. Everything else can: a nightly recap
            // may run a cheap model, in plan mode, under a different profile,
            // in a thread the user drives another way — `deliver_to_conversation`
            // applies those to the session before the prompt goes out.
            target.project_id = None;
            target.provider = None;
            target.worktree_mode = None;
            target.reuse_branch = None;
            target.base_branch = None;
        }
        TargetKind::NewConversation => {
            if target.project_id.is_none() {
                return Err(AppError::BadRequest(
                    "a new-conversation schedule needs project_id".into(),
                ));
            }
            target.feature_id = None;
            // The same validation `/api/features` applies, so a branch that
            // would be refused there can't reach `git worktree add` by way of a
            // schedule instead. Unset means "no worktree".
            let requested = trimmed(target.worktree_mode.as_deref())
                .unwrap_or_else(|| WORKTREE_MODE_SKIP.to_string());
            let is_new = requested == "new";
            let (mode, reuse_branch) =
                validate_worktree_mode(&Some(requested), &target.reuse_branch)?;
            target.worktree_mode = mode;
            target.reuse_branch = reuse_branch;
            if !is_new {
                target.base_branch = None;
            } else if let Some(base) = trimmed(target.base_branch.as_deref()) {
                // Same rules, but the message has to name the field the user
                // actually set.
                target.base_branch = Some(validate_reuse_branch(&base).map_err(|_| {
                    AppError::BadRequest(format!(
                        "base_branch is not a valid branch name: {base:?}"
                    ))
                })?);
            }
        }
    }
    Ok(target)
}

const WORKTREE_MODE_SKIP: &str = "skip";

type Sql<'q> = sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments>;

/// The 20 values `insert` and `update` both write, in one place and one order.
/// Their SQL stays written out — static strings are what sqlx wants and what
/// greps find — but a pin bound in one statement and forgotten in the other
/// would be a silently half-saved schedule, so the binding itself is shared.
fn bind_write<'q>(query: Sql<'q>, write: &'q ScheduleWrite) -> Sql<'q> {
    query
        .bind(&write.name)
        .bind(&write.prompt)
        .bind(write.target.kind.as_str())
        .bind(write.target.feature_id)
        .bind(write.target.project_id)
        .bind(&write.target.provider)
        .bind(&write.target.model)
        .bind(&write.target.thinking_level)
        .bind(&write.target.permission_mode)
        .bind(&write.target.access_mode)
        .bind(&write.target.profile)
        .bind(&write.target.worktree_mode)
        .bind(&write.target.reuse_branch)
        .bind(&write.target.base_branch)
        .bind(write.recurrence.kind.as_str())
        .bind(write.recurrence.interval_seconds)
        .bind(&write.recurrence.time_of_day)
        .bind(write.recurrence.weekdays_csv())
        .bind(write.recurrence.day_of_month)
        .bind(&write.recurrence.timezone)
}

pub async fn insert(pool: &SqlitePool, body: SaveScheduleRequest) -> Result<Schedule, AppError> {
    let enabled = body.enabled.unwrap_or(true);
    let write = ScheduleWrite::from_request(body)?;
    let id: i64 = bind_write(
        sqlx::query(
            "INSERT INTO schedules (
                name, prompt, target_kind, feature_id, project_id,
                provider, model, thinking_level, permission_mode, access_mode, profile,
                worktree_mode, reuse_branch, base_branch,
                recurrence_kind, interval_seconds, time_of_day, weekdays, day_of_month, timezone,
                enabled, next_run_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id",
        ),
        &write,
    )
    .bind(enabled)
    .bind(&write.next_run_at)
    .fetch_one(pool)
    .await?
    .get(0);
    require_row(get(pool, id).await?, id)
}

/// Replace a schedule's rule. Run history (`run_count`, `last_*`) survives —
/// editing the time of a daily message shouldn't erase that it has been
/// running for a month.
pub async fn update(
    pool: &SqlitePool,
    id: i64,
    body: SaveScheduleRequest,
) -> Result<Schedule, AppError> {
    let enabled = body.enabled;
    let write = ScheduleWrite::from_request(body)?;
    let rows = bind_write(
        sqlx::query(
            "UPDATE schedules SET
                name = ?, prompt = ?, target_kind = ?, feature_id = ?, project_id = ?,
                provider = ?, model = ?, thinking_level = ?,
                permission_mode = ?, access_mode = ?, profile = ?,
                worktree_mode = ?, reuse_branch = ?, base_branch = ?,
                recurrence_kind = ?, interval_seconds = ?, time_of_day = ?, weekdays = ?,
                day_of_month = ?, timezone = ?,
                enabled = COALESCE(?, enabled), next_run_at = ?,
                updated_at = datetime('now')
             WHERE id = ?",
        ),
        &write,
    )
    .bind(enabled)
    .bind(&write.next_run_at)
    .bind(id)
    .execute(pool)
    .await?
    .rows_affected();
    if rows == 0 {
        return Err(AppError::NotFound(format!("schedule {id} not found")));
    }
    require_row(get(pool, id).await?, id)
}

/// Pause or resume. Pausing keeps `next_run_at` so the rule reads the same when
/// it comes back; resuming re-derives it (see [`planner::next_run_on_resume`]).
pub async fn set_enabled(pool: &SqlitePool, id: i64, enabled: bool) -> Result<Schedule, AppError> {
    let current = require_row(get(pool, id).await?, id)?;
    let next_run_at = if enabled {
        planner::next_run_on_resume(
            &current.recurrence,
            current.next_run_at.as_deref(),
            Utc::now(),
        )
    } else {
        current.next_run_at.clone()
    };
    sqlx::query(
        "UPDATE schedules SET enabled = ?, next_run_at = datetime(?), updated_at = datetime('now')
         WHERE id = ?",
    )
    .bind(enabled)
    .bind(&next_run_at)
    .bind(id)
    .execute(pool)
    .await?;
    require_row(get(pool, id).await?, id)
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let rows = sqlx::query("DELETE FROM schedules WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(rows > 0)
}

fn require_row(schedule: Option<Schedule>, id: i64) -> Result<Schedule, AppError> {
    schedule.ok_or_else(|| AppError::NotFound(format!("schedule {id} not found")))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{daily_new_conversation, fixture, once_into_conversation};
    use super::*;
    use crate::domain::schedules::models::RecurrenceInput;
    use crate::domain::schedules::recurrence::RecurrenceKind;

    #[tokio::test]
    async fn insert_resolves_the_first_run_from_the_rule() {
        let (pool, project_id, _) = fixture().await;
        let schedule = insert(&pool, daily_new_conversation(project_id, "09:00"))
            .await
            .unwrap();

        assert!(schedule.enabled);
        assert_eq!(schedule.run_count, 0);
        assert!(schedule.next_run_at.is_some());
        assert_eq!(schedule.recurrence.kind, RecurrenceKind::Daily);
        assert_eq!(schedule.name.as_deref(), Some("Standup"));
    }

    // A conversation already has an agent and a working directory; those knobs
    // would be silently ignored, so we refuse to store them rather than show the
    // user settings that do nothing. Every other pin survives — dispatch writes
    // them onto the session before sending.
    #[tokio::test]
    async fn conversation_targets_keep_every_pin_but_the_agent() {
        let (pool, project_id, feature_id) = fixture().await;
        let mut body = once_into_conversation(feature_id, "2099-01-01T09:00:00Z");
        body.target.project_id = Some(project_id);
        body.target.provider = Some("claude_code".into());
        body.target.worktree_mode = Some("new".into());
        body.target.model = Some("haiku".into());
        body.target.thinking_level = Some("low".into());
        body.target.permission_mode = Some("plan".into());
        body.target.access_mode = Some("readOnly".into());
        body.target.profile = Some("bedrock".into());

        let schedule = insert(&pool, body).await.unwrap();
        assert_eq!(schedule.target.project_id, None);
        assert_eq!(schedule.target.provider, None);
        assert_eq!(schedule.target.worktree_mode, None);
        assert_eq!(schedule.target.model.as_deref(), Some("haiku"));
        assert_eq!(schedule.target.thinking_level.as_deref(), Some("low"));
        assert_eq!(schedule.target.permission_mode.as_deref(), Some("plan"));
        assert_eq!(schedule.target.access_mode.as_deref(), Some("readOnly"));
        assert_eq!(schedule.target.profile.as_deref(), Some("bedrock"));
        // The project is still resolved for display, via the conversation.
        assert_eq!(schedule.context.project_id, Some(project_id));
    }

    #[tokio::test]
    async fn invalid_targets_are_rejected_at_save_time() {
        let (pool, _, feature_id) = fixture().await;

        let mut orphan = once_into_conversation(feature_id, "2099-01-01T09:00:00Z");
        orphan.target.feature_id = None;
        assert!(insert(&pool, orphan).await.is_err());

        let mut unknown_feature = once_into_conversation(4_040, "2099-01-01T09:00:00Z");
        unknown_feature.target.feature_id = Some(4_040);
        // The FK rejects a conversation that doesn't exist.
        assert!(insert(&pool, unknown_feature).await.is_err());
    }

    #[tokio::test]
    async fn reusing_a_branch_requires_naming_it() {
        let (pool, project_id, _) = fixture().await;
        let mut body = daily_new_conversation(project_id, "09:00");
        body.target.worktree_mode = Some("reuse".into());
        assert!(insert(&pool, body).await.is_err());

        let mut valid = daily_new_conversation(project_id, "09:00");
        valid.target.worktree_mode = Some("reuse".into());
        valid.target.reuse_branch = Some("feature/x".into());
        let schedule = insert(&pool, valid).await.unwrap();
        assert_eq!(schedule.target.reuse_branch.as_deref(), Some("feature/x"));
    }

    /// A schedule is a second door onto worktree creation, so it applies the
    /// same branch-name validation `/api/features` does — a name git would
    /// refuse (or read as a flag) must never reach `git worktree add` months
    /// later, when nobody is watching.
    #[tokio::test]
    async fn a_branch_name_git_would_refuse_is_rejected_at_save_time() {
        let (pool, project_id, _) = fixture().await;
        for branch in ["--upload-pack=evil", "feat bad", "feat..bad", "feat.lock"] {
            let mut body = daily_new_conversation(project_id, "09:00");
            body.target.worktree_mode = Some("reuse".into());
            body.target.reuse_branch = Some(branch.into());
            let error = insert(&pool, body).await.unwrap_err();
            assert!(matches!(error, AppError::BadRequest(_)), "{branch}");
        }

        let mut base = daily_new_conversation(project_id, "09:00");
        base.target.worktree_mode = Some("new".into());
        base.target.base_branch = Some("--exec=evil".into());
        assert!(insert(&pool, base).await.is_err());
    }

    #[tokio::test]
    async fn update_replaces_the_rule_and_keeps_history() {
        let (pool, project_id, _) = fixture().await;
        let created = insert(&pool, daily_new_conversation(project_id, "09:00"))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE schedules SET run_count = 4, last_run_at = datetime('now'),
             last_status = 'sent' WHERE id = ?",
        )
        .bind(created.id)
        .execute(&pool)
        .await
        .unwrap();

        let mut body = daily_new_conversation(project_id, "09:00");
        body.recurrence = RecurrenceInput {
            kind: RecurrenceKind::Interval,
            run_at: None,
            interval_seconds: Some(1_800),
            time_of_day: None,
            weekdays: None,
            day_of_month: None,
            timezone: Some("UTC".into()),
        };
        let updated = update(&pool, created.id, body).await.unwrap();

        assert_eq!(updated.recurrence.kind, RecurrenceKind::Interval);
        assert_eq!(updated.recurrence.interval_seconds, Some(1_800));
        assert_eq!(updated.recurrence.time_of_day, None);
        assert_eq!(updated.run_count, 4);
        assert!(updated.last_run.is_some());
    }

    // Pausing must not lose a one-off's instant — that instant is the whole
    // schedule, and resuming has nothing to re-derive it from.
    #[tokio::test]
    async fn pausing_keeps_a_one_off_instant_and_resuming_restores_it() {
        let (pool, _, feature_id) = fixture().await;
        let created = insert(
            &pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();

        let paused = set_enabled(&pool, created.id, false).await.unwrap();
        assert!(!paused.enabled);
        assert_eq!(paused.next_run_at.as_deref(), Some("2099-01-01T09:00:00Z"));

        let resumed = set_enabled(&pool, created.id, true).await.unwrap();
        assert!(resumed.enabled);
        assert_eq!(resumed.next_run_at.as_deref(), Some("2099-01-01T09:00:00Z"));
    }

    #[tokio::test]
    async fn resuming_a_repeating_rule_re_derives_from_now() {
        let (pool, project_id, _) = fixture().await;
        let created = insert(&pool, daily_new_conversation(project_id, "09:00"))
            .await
            .unwrap();
        // Simulate a long pause with a stale pending run.
        sqlx::query(
            "UPDATE schedules SET next_run_at = '2000-01-01 09:00:00', enabled = 0 WHERE id = ?",
        )
        .bind(created.id)
        .execute(&pool)
        .await
        .unwrap();

        let resumed = set_enabled(&pool, created.id, true).await.unwrap();
        let next = resumed.next_run_at.unwrap();
        assert!(
            next > Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "{next}"
        );
    }

    #[tokio::test]
    async fn delete_reports_whether_a_row_went_away() {
        let (pool, _, feature_id) = fixture().await;
        let created = insert(
            &pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        assert!(delete(&pool, created.id).await.unwrap());
        assert!(!delete(&pool, created.id).await.unwrap());
    }

    #[tokio::test]
    async fn updating_an_unknown_schedule_is_a_not_found() {
        let (pool, project_id, _) = fixture().await;
        let error = update(&pool, 404, daily_new_conversation(project_id, "09:00"))
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)));
    }
}
