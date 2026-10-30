use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::recurrence::{Recurrence, RecurrenceKind};
use crate::error::AppError;

/// What a schedule delivers into when it fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    /// Deliver into an existing conversation.
    Conversation,
    /// Create a fresh conversation for every run.
    NewConversation,
    /// Run a custom action in an existing conversation's working copy instead
    /// of sending a prompt. Stored as a `conversation` row with
    /// `custom_action_id` set (see the 20261029100000 migration).
    CustomAction,
}

impl TargetKind {
    /// The `target_kind` column value. A custom-action schedule is stored as a
    /// `conversation` row (the column's CHECK predates it); `custom_action_id`
    /// is what tells the two apart — see [`TargetKind::from_storage`].
    pub fn storage_str(self) -> &'static str {
        match self {
            Self::Conversation | Self::CustomAction => "conversation",
            Self::NewConversation => "new_conversation",
        }
    }

    /// Inverse of [`TargetKind::storage_str`].
    pub fn from_storage(raw: &str, custom_action_id: Option<i64>) -> Result<Self, AppError> {
        match (raw, custom_action_id) {
            ("conversation", Some(_)) => Ok(Self::CustomAction),
            ("conversation", None) => Ok(Self::Conversation),
            ("new_conversation", None) => Ok(Self::NewConversation),
            (other, _) => Err(AppError::Internal(format!(
                "schedule row has an unreadable target '{other}' (custom action {custom_action_id:?})"
            ))),
        }
    }
}

/// Where a schedule delivers, plus the runtime options used when it has to
/// create the conversation itself. Every option is nullable: omitting them all
/// reproduces exactly what the "New session" button does.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ScheduleTarget {
    pub kind: TargetKind,
    /// Required when `kind = conversation` or `custom_action` (the conversation
    /// whose working copy the action runs in).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<i64>,
    /// Required when `kind = custom_action`: the action to run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<i64>,
    /// Required when `kind = new_conversation`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<i64>,
    /// Agent to run with. Only meaningful for `new_conversation`: an existing
    /// conversation is already bound to its provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Model to run with. Unlike the provider this applies to both kinds — a
    /// schedule may run a cheap model in a conversation the user drives with an
    /// expensive one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    /// Collaboration mode (`default` | `acceptEdits` | `plan` | …), the chip the
    /// composer cycles with Shift+Tab. Applies to both kinds: a nightly sweep
    /// may run in plan mode inside a conversation the user drives normally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    /// Provider access mode (Codex/Cursor sandboxing). Ignored by providers that
    /// don't offer one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_mode: Option<String>,
    /// Claude Code profile to run under. Lets a schedule bill against a
    /// different account or endpoint than the one the user is working in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// `new` | `reuse` | `skip`. Defaults to `skip` (work in the project root).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reuse_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
}

impl ScheduleTarget {
    /// Run `action_id` in `feature_id`'s working copy. No agent runs, so every
    /// agent option stays unset.
    pub fn custom_action(feature_id: i64, action_id: i64) -> Self {
        Self {
            kind: TargetKind::CustomAction,
            feature_id: Some(feature_id),
            action_id: Some(action_id),
            project_id: None,
            provider: None,
            model: None,
            thinking_level: None,
            permission_mode: None,
            access_mode: None,
            profile: None,
            worktree_mode: None,
            reuse_branch: None,
            base_branch: None,
        }
    }
}

/// Read-only context resolved by join so the schedules list can render a target
/// without one lookup per row.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScheduleContext {
    /// Owning project, whichever target kind the schedule uses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    /// Title of the targeted conversation (`kind = conversation` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_title: Option<String>,
    /// Title of the conversation the most recent run landed in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_feature_title: Option<String>,
    /// Name of the action a `custom_action` schedule runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_name: Option<String>,
}

/// Outcome of the most recent run.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScheduleLastRun {
    /// ISO-8601 UTC.
    pub at: String,
    /// `sent` | `failed` | `skipped`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Conversation it delivered into, when that conversation still exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<i64>,
}

/// Gates a run on a shell command: at each firing the command runs in the
/// target's working copy, and the prompt is only delivered when it exits
/// non-zero — "every 15 minutes, if `cargo test` fails, fix it". The command's
/// output rides along with the prompt so the agent sees what broke.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ScheduleCondition {
    /// Run through the user's login shell, like a custom action.
    pub command: String,
    /// Seconds before the evaluation is abandoned. Defaults to 300, at most 600.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<i64>,
}

/// What the latest condition evaluation concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum ScheduleCheckStatus {
    /// Exit 0 — nothing was sent.
    Passed,
    /// Non-zero exit — the prompt was handed to dispatch.
    Triggered,
    /// The target conversation's agent was still working, so the command
    /// wasn't run: it is most likely still on the previous failure.
    Busy,
    /// The command could not be evaluated (timeout, spawn failure, …).
    Error,
}

/// Outcome of the most recent condition evaluation. Separate from
/// [`ScheduleLastRun`]: a passing check delivers nothing, so it must not
/// overwrite the record of the last message actually sent.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScheduleLastCheck {
    /// ISO-8601 UTC.
    pub at: String,
    pub status: ScheduleCheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
}

/// A configured schedule. Timestamps are ISO-8601 UTC (trailing `Z`) so the
/// frontend parses them unambiguously and renders in the viewer's timezone.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Schedule {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub prompt: String,
    pub target: ScheduleTarget,
    pub recurrence: Recurrence,
    /// Set when the schedule only delivers after a failing command.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<ScheduleCondition>,
    pub enabled: bool,
    /// A one-shot schedule that has already fired. It is neither upcoming nor
    /// paused — a third state the UI has to name, so it ships on the wire
    /// rather than being re-derived from two other fields on every render.
    pub completed: bool,
    /// Next firing time, ISO-8601 UTC. `None` once a one-shot schedule has run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run: Option<ScheduleLastRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_check: Option<ScheduleLastCheck>,
    pub run_count: i64,
    pub context: ScheduleContext,
    pub created_at: String,
    pub updated_at: String,
}

/// Create/replace payload. `PUT` replaces the whole rule (history and run
/// counters are preserved), so the editor can send one shape for both.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SaveScheduleRequest {
    #[serde(default)]
    pub name: Option<String>,
    pub prompt: String,
    pub target: ScheduleTarget,
    pub recurrence: RecurrenceInput,
    /// Omit (or send `null`) for a schedule that always delivers.
    #[serde(default)]
    pub condition: Option<ScheduleCondition>,
    /// Defaults to `true` on create; on update, omitting it leaves the current
    /// paused/active state alone.
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// The recurrence half of a save. Mirrors [`Recurrence`] plus `run_at`, the
/// absolute instant a one-shot schedule fires at.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RecurrenceInput {
    pub kind: RecurrenceKind,
    /// Required for `once`: ISO-8601 target instant.
    #[serde(default)]
    pub run_at: Option<String>,
    #[serde(default)]
    pub interval_seconds: Option<i64>,
    #[serde(default)]
    pub time_of_day: Option<String>,
    #[serde(default)]
    pub weekdays: Option<Vec<i64>>,
    #[serde(default)]
    pub day_of_month: Option<i64>,
    /// IANA zone; defaults to UTC when the client doesn't send one.
    #[serde(default)]
    pub timezone: Option<String>,
}

impl RecurrenceInput {
    pub fn into_recurrence(self) -> Result<(Recurrence, Option<String>), AppError> {
        let run_at = self.run_at.clone();
        let recurrence = Recurrence::parse(
            self.kind,
            self.interval_seconds,
            self.time_of_day,
            self.weekdays,
            self.day_of_month,
            self.timezone,
        )?;
        Ok((recurrence, run_at))
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetScheduleEnabledRequest {
    pub enabled: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScheduleDeleted {
    pub deleted: bool,
}

/// A completed run, broadcast to every connected client.
///
/// The frontend used to infer this from the canonical `user_message` a run
/// produces: after every message it checked whether any cached schedule was
/// armed and already past its instant. That guessed twice over — it fired on
/// ordinary messages that merely arrived while a schedule was overdue, and it
/// missed every run whose conversation the client didn't have open, which is
/// the normal case for a schedule that creates its own.
///
/// Like [`crate::domain::feature_events`], it carries no `seq` and has no
/// snapshot: it's a cue to refetch, not state to merge.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct ScheduleRanEvent {
    pub schedule_id: i64,
}

/// Result of a manual "run now".
#[derive(Debug, Serialize, ToSchema)]
pub struct ScheduleRunResult {
    pub ran: bool,
    /// The schedule's command exited 0, so there was nothing to send. `ran` is
    /// false without that being a failure.
    pub condition_passed: bool,
    /// Conversation the run delivered into.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
