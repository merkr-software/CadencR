use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Where a custom action is offered to the user. `Global` makes it visible on
/// every project; `Project` scopes it to a single project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum Scope {
    Global,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum TriggeredBy {
    Manual,
    Schedule,
}

/// The most recent run for an `(action, feature)` pair, embedded in
/// [`CustomAction`] so the header bar can paint status dots from a single
/// list-actions request rather than one HTTP call per button.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LastRunSummary {
    /// The run's id, so the header can stop it without fetching the history.
    pub run_id: i64,
    pub started_at: String,
    /// `None` while the run is still in flight.
    pub exit_code: Option<i64>,
    pub ended_at: Option<String>,
}

/// A user-defined header action.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CustomAction {
    pub id: i64,
    pub name: String,
    pub command: String,
    /// Data URI: `data:image/<png|jpeg|svg+xml>;base64,...`. May be empty.
    pub icon_data: Option<String>,
    pub scope: Scope,
    /// `Some(project_id)` when `scope = Project`, `None` for global.
    pub project_id: Option<i64>,
    pub position: i64,
    /// When `true`, the action runs in a dedicated terminal split (a client-side
    /// PTY) instead of a backgrounded server process — useful for long-running,
    /// interactive commands such as dev servers.
    pub run_in_terminal: bool,
    pub created_at: String,
    pub updated_at: String,
    /// Variable names referenced by `command` (`${VAR}` style), in declaration order.
    pub variable_names: Vec<String>,
    /// Most recent run for the `(action, feature)` pair the listing was scoped
    /// to. `None` when no feature scope was provided or no runs exist yet.
    pub last_run: Option<LastRunSummary>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateCustomActionRequest {
    pub name: String,
    pub command: String,
    pub icon_data: Option<String>,
    pub scope: Scope,
    pub project_id: Option<i64>,
    /// Defaults to `false` (backgrounded server process) when omitted.
    pub run_in_terminal: Option<bool>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateCustomActionRequest {
    pub name: Option<String>,
    pub command: Option<String>,
    /// `Some("")` clears the icon.
    pub icon_data: Option<String>,
    pub scope: Option<Scope>,
    pub project_id: Option<i64>,
    pub position: Option<i64>,
    pub run_in_terminal: Option<bool>,
}

/// New order for one list of actions (the globals, or one project's).
#[derive(Debug, Deserialize, ToSchema)]
pub struct ReorderCustomActionsRequest {
    pub ids: Vec<i64>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct CustomActionVariable {
    pub var_name: String,
    pub value: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetCustomActionVariableRequest {
    pub var_name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct CustomActionRun {
    pub id: i64,
    pub action_id: i64,
    pub feature_id: i64,
    pub exit_code: Option<i64>,
    pub stdout: String,
    pub stderr: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub triggered_by: TriggeredBy,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct CustomActionSchedule {
    pub id: i64,
    pub action_id: i64,
    pub feature_id: i64,
    pub interval_seconds: i64,
    pub enabled: bool,
    pub last_run_at: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetCustomActionScheduleRequest {
    /// `None` = clear the schedule.
    pub interval_seconds: Option<i64>,
    pub enabled: Option<bool>,
}

/// Response for starting an asynchronous run. Output and exit code are streamed
/// into `custom_action_runs` and read back via `GET /runs`, so the start call
/// only returns the new run's id.
#[derive(Debug, Serialize, ToSchema)]
pub struct RunResponse {
    pub run_id: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SuccessResponse {
    pub success: bool,
}

/// An action's `${VAR}`-interpolated command and resolved working directory,
/// returned without running it. The frontend uses this to spawn the command in
/// a dedicated terminal split when `run_in_terminal` is set.
#[derive(Debug, Serialize, ToSchema)]
pub struct ResolvedCommand {
    pub command: String,
    pub cwd: String,
}
