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
}

impl TargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::NewConversation => "new_conversation",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw {
            "conversation" => Ok(Self::Conversation),
            "new_conversation" => Ok(Self::NewConversation),
            other => Err(AppError::BadRequest(format!(
                "unknown schedule target '{other}'"
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
    /// Required when `kind = conversation`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<i64>,
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

/// Result of a manual "run now".
#[derive(Debug, Serialize, ToSchema)]
pub struct ScheduleRunResult {
    pub ran: bool,
    /// Conversation the run delivered into.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
