use crate::domain::schedules::models::{
    Schedule, ScheduleContext, ScheduleLastRun, ScheduleTarget, TargetKind,
};
use crate::domain::schedules::recurrence::Recurrence;
use crate::error::AppError;

/// Shared projection. Timestamps are re-formatted to ISO-8601 UTC (trailing
/// `Z`) on the way out; the display context (project, conversation titles) is
/// joined here so a list of N schedules is still one query.
pub const SELECT: &str = "SELECT
        s.id, s.name, s.prompt, s.target_kind, s.feature_id, s.project_id,
        s.provider, s.model, s.thinking_level,
        s.permission_mode, s.access_mode, s.profile,
        s.worktree_mode, s.reuse_branch, s.base_branch,
        s.recurrence_kind, s.interval_seconds, s.time_of_day, s.weekdays,
        s.day_of_month, s.timezone, s.enabled,
        strftime('%Y-%m-%dT%H:%M:%SZ', s.next_run_at) AS next_run_at,
        strftime('%Y-%m-%dT%H:%M:%SZ', s.last_run_at) AS last_run_at,
        s.last_status, s.last_error, s.last_feature_id, s.run_count,
        COALESCE(s.project_id, f.project_id) AS context_project_id,
        p.name AS project_name,
        f.title AS feature_title,
        lf.title AS last_feature_title,
        strftime('%Y-%m-%dT%H:%M:%SZ', s.created_at) AS created_at,
        strftime('%Y-%m-%dT%H:%M:%SZ', s.updated_at) AS updated_at
     FROM schedules s
     LEFT JOIN features f ON f.id = s.feature_id
     LEFT JOIN features lf ON lf.id = s.last_feature_id
     LEFT JOIN projects p ON p.id = COALESCE(s.project_id, f.project_id)";

#[derive(Debug, sqlx::FromRow)]
pub struct ScheduleRow {
    pub id: i64,
    pub name: Option<String>,
    pub prompt: String,
    pub target_kind: String,
    pub feature_id: Option<i64>,
    pub project_id: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub permission_mode: Option<String>,
    pub access_mode: Option<String>,
    pub profile: Option<String>,
    pub worktree_mode: Option<String>,
    pub reuse_branch: Option<String>,
    pub base_branch: Option<String>,
    pub recurrence_kind: String,
    pub interval_seconds: Option<i64>,
    pub time_of_day: Option<String>,
    pub weekdays: Option<String>,
    pub day_of_month: Option<i64>,
    pub timezone: String,
    pub enabled: i64,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_feature_id: Option<i64>,
    pub run_count: i64,
    pub context_project_id: Option<i64>,
    pub project_name: Option<String>,
    pub feature_title: Option<String>,
    pub last_feature_title: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl ScheduleRow {
    pub fn into_schedule(self) -> Result<Schedule, AppError> {
        let recurrence = Recurrence::from_row(
            &self.recurrence_kind,
            self.interval_seconds,
            self.time_of_day,
            self.weekdays,
            self.day_of_month,
            self.timezone,
        )?;
        // `last_run_at` is written together with `last_status`, so a row with
        // one and not the other is corrupt rather than merely unfinished —
        // treat it as "never run" instead of inventing a status.
        let last_run = match (self.last_run_at, self.last_status) {
            (Some(at), Some(status)) => Some(ScheduleLastRun {
                at,
                status,
                error: self.last_error,
                feature_id: self.last_feature_id,
            }),
            _ => None,
        };
        Ok(Schedule {
            id: self.id,
            name: self.name,
            prompt: self.prompt,
            target: ScheduleTarget {
                kind: TargetKind::parse(&self.target_kind)?,
                feature_id: self.feature_id,
                project_id: self.project_id,
                provider: self.provider,
                model: self.model,
                thinking_level: self.thinking_level,
                permission_mode: self.permission_mode,
                access_mode: self.access_mode,
                profile: self.profile,
                worktree_mode: self.worktree_mode,
                reuse_branch: self.reuse_branch,
                base_branch: self.base_branch,
            },
            completed: !recurrence.kind.repeats() && self.next_run_at.is_none(),
            recurrence,
            enabled: self.enabled != 0,
            next_run_at: self.next_run_at,
            last_run,
            run_count: self.run_count,
            context: ScheduleContext {
                project_id: self.context_project_id,
                project_name: self.project_name,
                feature_title: self.feature_title,
                last_feature_title: self.last_feature_title,
            },
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}
