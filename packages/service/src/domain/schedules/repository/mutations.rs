use chrono::Utc;
use sqlx::{Row, SqlitePool};

use super::reads::get;
use crate::domain::features::worktree_validation::{validate_reuse_branch, validate_worktree_mode};
use crate::domain::schedules::condition;
use crate::domain::schedules::models::{
    SaveScheduleRequest, Schedule, ScheduleCondition, ScheduleTarget, TargetKind,
};
use crate::domain::schedules::pins::trimmed;
use crate::domain::schedules::planner;
use crate::domain::schedules::recurrence::{to_storage, Recurrence};
use crate::error::AppError;

/// Validated write payload: the request with its rule parsed and its first
/// firing instant resolved.
struct ScheduleWrite {
    name: Option<String>,
    prompt: String,
    target: ScheduleTarget,
    recurrence: Recurrence,
    condition: Option<ScheduleCondition>,
    next_run_at: Option<String>,
}

impl ScheduleWrite {
    fn from_request(body: SaveScheduleRequest) -> Result<Self, AppError> {
        Self::planned(body, |recurrence, run_at| {
            planner::initial_next_run(recurrence, run_at, Utc::now())
        })
    }

    /// `plan` resolves `next_run_at` from the parsed rule and the request's
    /// `run_at`.
    fn planned(
        body: SaveScheduleRequest,
        plan: impl FnOnce(&Recurrence, Option<&str>) -> Result<Option<String>, AppError>,
    ) -> Result<Self, AppError> {
        let target = normalize_target(body.target)?;
        let (prompt, condition) = if target.kind == TargetKind::CustomAction {
            // An action sends nothing, and its own exit status is the result —
            // a gating command in front of it would be a second action.
            if body.condition.is_some() {
                return Err(AppError::BadRequest(
                    "a custom action schedule can't have a condition".into(),
                ));
            }
            (String::new(), None)
        } else {
            let prompt = body.prompt.trim().to_string();
            if prompt.is_empty() {
                return Err(AppError::BadRequest("a prompt is required".into()));
            }
            (prompt, condition::normalize(body.condition)?)
        };
        let (recurrence, run_at) = body.recurrence.into_recurrence()?;
        let next_run_at = plan(&recurrence, run_at.as_deref())?;
        Ok(Self {
            name: body
                .name
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty()),
            prompt,
            target,
            recurrence,
            condition,
            next_run_at,
        })
    }
}

/// Reject a target that can't be delivered to before it is stored, rather than
/// letting the poll loop discover it and mark the schedule failed forever.
fn normalize_target(mut target: ScheduleTarget) -> Result<ScheduleTarget, AppError> {
    // A blank pin means "the conversation's own setting", the same as no pin.
    for pin in [
        &mut target.model,
        &mut target.thinking_level,
        &mut target.permission_mode,
    ] {
        *pin = trimmed(pin.as_deref());
    }
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
            target.action_id = None;
            target.provider = None;
            target.worktree_mode = None;
            target.reuse_branch = None;
            target.base_branch = None;
        }
        TargetKind::CustomAction => {
            let (Some(feature_id), Some(action_id)) = (target.feature_id, target.action_id) else {
                return Err(AppError::BadRequest(
                    "a custom action schedule needs feature_id and action_id".into(),
                ));
            };
            // The action runs as a plain shell command in the conversation's
            // working copy: no agent, so none of the agent options apply.
            return Ok(ScheduleTarget::custom_action(feature_id, action_id));
        }
        TargetKind::NewConversation => {
            if target.project_id.is_none() {
                return Err(AppError::BadRequest(
                    "a new-conversation schedule needs project_id".into(),
                ));
            }
            target.feature_id = None;
            target.action_id = None;
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

/// A custom-action target must name an action the conversation's project can
/// run — a global one, or one of that project's own. Checked here rather than
/// left to the FK so a stale or foreign id is a readable 400, not a 500.
async fn require_available_action(
    pool: &SqlitePool,
    target: &ScheduleTarget,
) -> Result<(), AppError> {
    let (TargetKind::CustomAction, Some(action_id), Some(feature_id)) =
        (target.kind, target.action_id, target.feature_id)
    else {
        return Ok(());
    };
    let available: Option<i64> = sqlx::query_scalar(
        "SELECT a.id FROM custom_actions a
         JOIN features f ON f.id = ?
         WHERE a.id = ? AND (a.scope = 'global' OR a.project_id = f.project_id)",
    )
    .bind(feature_id)
    .bind(action_id)
    .fetch_optional(pool)
    .await?;
    if available.is_none() {
        return Err(AppError::BadRequest(format!(
            "custom action {action_id} is not available in this conversation's project"
        )));
    }
    Ok(())
}

type Sql<'q> = sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments>;

/// The 23 values `insert` and `update` both write, in one place and one order.
/// Their SQL stays written out — static strings are what sqlx wants and what
/// greps find — but a pin bound in one statement and forgotten in the other
/// would be a silently half-saved schedule, so the binding itself is shared.
fn bind_write<'q>(query: Sql<'q>, write: &'q ScheduleWrite) -> Sql<'q> {
    query
        .bind(&write.name)
        .bind(&write.prompt)
        .bind(write.target.kind.storage_str())
        .bind(write.target.feature_id)
        .bind(write.target.project_id)
        .bind(write.target.action_id)
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
        .bind(write.condition.as_ref().map(|condition| &condition.command))
        .bind(
            write
                .condition
                .as_ref()
                .and_then(|condition| condition.timeout_seconds),
        )
}

pub async fn insert(pool: &SqlitePool, body: SaveScheduleRequest) -> Result<Schedule, AppError> {
    let enabled = body.enabled.unwrap_or(true);
    let write = ScheduleWrite::from_request(body)?;
    require_available_action(pool, &write.target).await?;
    let id: i64 = bind_write(
        sqlx::query(
            "INSERT INTO schedules (
                name, prompt, target_kind, feature_id, project_id, custom_action_id,
                provider, model, thinking_level, permission_mode, access_mode, profile,
                worktree_mode, reuse_branch, base_branch,
                recurrence_kind, interval_seconds, time_of_day, weekdays, day_of_month, timezone,
                condition_command, condition_timeout_seconds,
                enabled, next_run_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    write_update(pool, id, enabled, &ScheduleWrite::from_request(body)?).await
}

/// Rewrite a schedule without re-planning it: `body` carries the stored rule,
/// and `next_run_at` stays where it was, so tweaking an hourly check's prompt
/// doesn't push its next run back an hour and a paused one-off whose instant
/// has passed can still be edited. Resuming re-derives it as [`set_enabled`]
/// does.
pub async fn update_in_place(
    pool: &SqlitePool,
    current: &Schedule,
    body: SaveScheduleRequest,
) -> Result<Schedule, AppError> {
    let enabled = body.enabled;
    let next_run_at = if enabled == Some(true) && !current.enabled {
        planner::next_run_on_resume(
            &current.recurrence,
            current.next_run_at.as_deref(),
            Utc::now(),
        )
    } else {
        current.next_run_at.clone()
    };
    // The projection reads it back as ISO-8601; the poll loop compares the
    // storage form.
    let next_run_at = next_run_at
        .as_deref()
        .and_then(planner::parse_instant)
        .map(to_storage);
    let write = ScheduleWrite::planned(body, |_, _| Ok(next_run_at))?;
    write_update(pool, current.id, enabled, &write).await
}

async fn write_update(
    pool: &SqlitePool,
    id: i64,
    enabled: Option<bool>,
    write: &ScheduleWrite,
) -> Result<Schedule, AppError> {
    require_available_action(pool, &write.target).await?;
    let rows = bind_write(
        sqlx::query(
            "UPDATE schedules SET
                name = ?, prompt = ?, target_kind = ?, feature_id = ?, project_id = ?,
                custom_action_id = ?, provider = ?, model = ?, thinking_level = ?,
                permission_mode = ?, access_mode = ?, profile = ?,
                worktree_mode = ?, reuse_branch = ?, base_branch = ?,
                recurrence_kind = ?, interval_seconds = ?, time_of_day = ?, weekdays = ?,
                day_of_month = ?, timezone = ?,
                condition_command = ?, condition_timeout_seconds = ?,
                enabled = COALESCE(?, enabled), next_run_at = ?,
                updated_at = datetime('now')
             WHERE id = ?",
        ),
        write,
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
    async fn an_in_place_resume_re_derives_but_an_edit_keeps_the_next_run() {
        let (pool, project_id, _) = fixture().await;
        let created = insert(&pool, daily_new_conversation(project_id, "09:00"))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE schedules SET next_run_at = '2000-01-01 09:00:00', enabled = 0 WHERE id = ?",
        )
        .bind(created.id)
        .execute(&pool)
        .await
        .unwrap();
        let paused = get(&pool, created.id).await.unwrap().unwrap();
        let mut body = daily_new_conversation(project_id, "09:00");
        body.enabled = None;

        let edited = update_in_place(&pool, &paused, body).await.unwrap();
        assert_eq!(edited.next_run_at.as_deref(), Some("2000-01-01T09:00:00Z"));

        let mut body = daily_new_conversation(project_id, "09:00");
        body.enabled = Some(true);
        let resumed = update_in_place(&pool, &edited, body).await.unwrap();
        assert!(resumed.enabled);
        let next = resumed.next_run_at.unwrap();
        assert!(
            next > Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "{next}"
        );
    }

    #[tokio::test]
    async fn a_blank_pin_is_no_pin() {
        let (pool, _, feature_id) = fixture().await;
        let mut body = once_into_conversation(feature_id, "2099-01-01T09:00:00Z");
        body.target.model = Some("  ".into());
        body.target.permission_mode = Some(" plan ".into());
        let created = insert(&pool, body).await.unwrap();
        assert_eq!(created.target.model, None);
        assert_eq!(created.target.permission_mode.as_deref(), Some("plan"));
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

    async fn action(pool: &SqlitePool, scope: &str, project_id: Option<i64>) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO custom_actions (name, command, scope, project_id)
             VALUES ('Tests', 'cargo test', ?, ?) RETURNING id",
        )
        .bind(scope)
        .bind(project_id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    fn run_action(feature_id: i64, action_id: i64) -> SaveScheduleRequest {
        let mut body = once_into_conversation(feature_id, "2099-01-01T09:00:00Z");
        body.prompt = "ignored".into();
        body.target = ScheduleTarget {
            model: Some("haiku".into()),
            project_id: Some(1),
            ..ScheduleTarget::custom_action(feature_id, action_id)
        };
        body
    }

    // Stored as a conversation row with `custom_action_id`, read back as its
    // own kind, with no prompt and none of the agent options.
    #[tokio::test]
    async fn custom_action_targets_round_trip_as_their_own_kind() {
        let (pool, project_id, feature_id) = fixture().await;
        let action_id = action(&pool, "project", Some(project_id)).await;

        let schedule = insert(&pool, run_action(feature_id, action_id))
            .await
            .unwrap();
        assert_eq!(schedule.target.kind, TargetKind::CustomAction);
        assert_eq!(schedule.target.action_id, Some(action_id));
        assert_eq!(schedule.target.feature_id, Some(feature_id));
        assert_eq!(schedule.target.model, None);
        assert_eq!(schedule.target.project_id, None);
        assert_eq!(schedule.prompt, "");
        assert_eq!(schedule.context.action_name.as_deref(), Some("Tests"));
        assert_eq!(
            schedule.context.feature_title.as_deref(),
            Some("Conversation")
        );
        assert_eq!(schedule.context.project_id, Some(project_id));
        let stored: (String, Option<i64>) =
            sqlx::query_as("SELECT target_kind, custom_action_id FROM schedules WHERE id = ?")
                .bind(schedule.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, ("conversation".into(), Some(action_id)));

        // Switching it back to a prompt clears the action.
        let updated = update(
            &pool,
            schedule.id,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        assert_eq!(updated.target.kind, TargetKind::Conversation);
        assert_eq!(updated.target.action_id, None);
    }

    #[tokio::test]
    async fn custom_action_targets_are_validated_at_save_time() {
        let (pool, _, feature_id) = fixture().await;
        let global = action(&pool, "global", None).await;
        let other_project: i64 =
            sqlx::query_scalar("INSERT INTO projects (name, path) VALUES ('o', '/o') RETURNING id")
                .fetch_one(&pool)
                .await
                .unwrap();
        let foreign = action(&pool, "project", Some(other_project)).await;

        assert!(insert(&pool, run_action(feature_id, global)).await.is_ok());

        let error = insert(&pool, run_action(feature_id, foreign))
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error}");

        let mut no_action = run_action(feature_id, global);
        no_action.target.action_id = None;
        assert!(matches!(
            insert(&pool, no_action).await.unwrap_err(),
            AppError::BadRequest(_)
        ));

        let mut gated = run_action(feature_id, global);
        gated.condition = Some(ScheduleCondition {
            command: "exit 1".into(),
            timeout_seconds: None,
        });
        assert!(matches!(
            insert(&pool, gated).await.unwrap_err(),
            AppError::BadRequest(_)
        ));
    }
}
