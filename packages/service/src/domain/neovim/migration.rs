//! Progressive migration from the built-in full Neovim editor to the
//! standalone `neovim` plugin (plan: `docs/plans/2026-11-04-generic-plugin-backends-neovim.md`,
//! commit 6).
//!
//! The built-in editor stays available during the coexistence period. The
//! migration only writes `editor_backend = "plugin:neovim"` once the plugin is
//! installed, consented, enabled and able to run here, and refuses while any
//! built-in Neovim session is still alive — the user is asked to save and
//! quit those sessions first. The route is deliberately temporary and
//! narrowly scoped: no tokens, no generic plugin operations.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::app_state::AppState;
use crate::domain::plugin_tabs::models::{PluginTabBackendAvailability, PluginTabStatus};
use crate::domain::plugin_tabs::summary;
use crate::domain::settings_allowlist;
use crate::domain::settings_store;
use crate::error::AppError;

/// The standalone plugin this migration targets.
pub const NEOVIM_PLUGIN_ID: &str = "neovim";
/// The workspace setting the migration writes.
pub const EDITOR_BACKEND_KEY: &str = "editor_backend";
/// The `editor_backend` value selecting the plugin editor.
pub const NEOVIM_PLUGIN_EDITOR_ID: &str = "plugin:neovim";

/// Why the plugin cannot take over the editor right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum NeovimMigrationPluginState {
    /// No `neovim` tab is installed.
    NotInstalled,
    /// A marketplace revision the revocation policy blocks.
    Blocked,
    /// Installed and valid but contributes no editor backend here.
    NotAnEditor,
    /// The plugin ships no built UI (`entry` missing).
    NotBuilt,
    /// No binary for the platform Cadencr runs on.
    BackendUnavailable,
    /// Consent for the current permissions hash is missing.
    ConsentRequired,
    /// Consent given but the plugin is not switched on.
    Disabled,
    /// Installed, consented, enabled and runnable: migration may proceed.
    Ready,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NeovimMigrationStatus {
    pub plugin: NeovimMigrationPluginState,
    /// Feature ids with a built-in Neovim process alive right now.
    pub sessions_running: Vec<i64>,
    /// Current `editor_backend` value (`null` when unset: the legacy
    /// `editor_vim_mode_level` interpretation applies).
    pub current_backend: Option<String>,
    /// The value a successful migration writes.
    pub target: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct NeovimMigrationResponse {
    /// `false` when the setting already held the target value (idempotent).
    pub migrated: bool,
    pub editor_backend: String,
}

/// The plugin summary distilled to the fields the gate needs, so [`decide`]
/// stays a pure, unit-testable function.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PluginGate {
    pub installed: bool,
    pub blocked: bool,
    pub valid: bool,
    pub has_editor: bool,
    pub has_backend: bool,
    pub entry_present: bool,
    pub backend_available_here: bool,
    pub consent_required: bool,
    pub effective: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    AlreadyMigrated,
    Migrate,
}

/// The UI-facing state derived from the gate.
pub(crate) fn plugin_state(gate: &PluginGate) -> NeovimMigrationPluginState {
    if !gate.installed {
        return NeovimMigrationPluginState::NotInstalled;
    }
    if gate.blocked {
        return NeovimMigrationPluginState::Blocked;
    }
    if !(gate.valid && gate.has_editor && gate.has_backend) {
        return NeovimMigrationPluginState::NotAnEditor;
    }
    if !gate.entry_present {
        return NeovimMigrationPluginState::NotBuilt;
    }
    if !gate.backend_available_here {
        return NeovimMigrationPluginState::BackendUnavailable;
    }
    if gate.consent_required {
        return NeovimMigrationPluginState::ConsentRequired;
    }
    if !gate.effective {
        return NeovimMigrationPluginState::Disabled;
    }
    NeovimMigrationPluginState::Ready
}

/// The migration gate. Checked in this order so the most actionable refusal
/// wins: the plugin must be usable before the running-session guard applies,
/// and an already-migrated workspace short-circuits as idempotent.
pub(crate) fn decide(
    gate: &PluginGate,
    sessions_running: &[i64],
    current_backend: Option<&str>,
) -> Result<Decision, AppError> {
    match plugin_state(gate) {
        NeovimMigrationPluginState::NotInstalled => Err(AppError::coded(
            StatusCode::NOT_FOUND,
            "NEOVIM_PLUGIN_NOT_INSTALLED",
            format!("no `{NEOVIM_PLUGIN_ID}` plugin is installed"),
        )),
        NeovimMigrationPluginState::Blocked => Err(AppError::coded(
            StatusCode::CONFLICT,
            "NEOVIM_PLUGIN_BLOCKED",
            format!("the `{NEOVIM_PLUGIN_ID}` plugin is blocked by policy"),
        )),
        NeovimMigrationPluginState::NotAnEditor => Err(AppError::coded(
            StatusCode::CONFLICT,
            "NEOVIM_PLUGIN_NOT_AN_EDITOR",
            format!("the `{NEOVIM_PLUGIN_ID}` plugin does not contribute a runnable editor here"),
        )),
        NeovimMigrationPluginState::NotBuilt => Err(AppError::coded(
            StatusCode::CONFLICT,
            "NEOVIM_PLUGIN_NOT_BUILT",
            format!("the `{NEOVIM_PLUGIN_ID}` plugin has no built UI"),
        )),
        NeovimMigrationPluginState::BackendUnavailable => Err(AppError::coded(
            StatusCode::CONFLICT,
            "NEOVIM_PLUGIN_BACKEND_UNAVAILABLE",
            format!("the `{NEOVIM_PLUGIN_ID}` plugin ships no backend for this platform"),
        )),
        NeovimMigrationPluginState::ConsentRequired => Err(AppError::coded(
            StatusCode::CONFLICT,
            "NEOVIM_PLUGIN_CONSENT_REQUIRED",
            format!("review and accept the permissions of the `{NEOVIM_PLUGIN_ID}` plugin first"),
        )),
        NeovimMigrationPluginState::Disabled => Err(AppError::coded(
            StatusCode::CONFLICT,
            "NEOVIM_PLUGIN_NOT_ENABLED",
            format!("enable the `{NEOVIM_PLUGIN_ID}` plugin first"),
        )),
        NeovimMigrationPluginState::Ready => {
            if current_backend == Some(NEOVIM_PLUGIN_EDITOR_ID) {
                return Ok(Decision::AlreadyMigrated);
            }
            if !sessions_running.is_empty() {
                return Err(AppError::coded(
                    StatusCode::CONFLICT,
                    "NEOVIM_SESSIONS_RUNNING",
                    format!(
                        "built-in Neovim sessions are still running (features: {}); \
                         save and quit them before migrating",
                        sessions_running
                            .iter()
                            .map(i64::to_string)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                ));
            }
            Ok(Decision::Migrate)
        }
    }
}

async fn load_gate(state: &AppState) -> Result<PluginGate, AppError> {
    match summary::get(&state.read_pool, NEOVIM_PLUGIN_ID, None).await {
        Ok(tab) => Ok(PluginGate {
            installed: true,
            blocked: tab.status == PluginTabStatus::Blocked,
            valid: tab.status == PluginTabStatus::Valid,
            has_editor: tab.editor.is_some(),
            has_backend: tab.backend.is_some(),
            entry_present: tab.entry_present,
            backend_available_here: tab.backend_availability
                == Some(PluginTabBackendAvailability::Available),
            consent_required: tab.enablement.consent_required,
            effective: tab.enablement.effective,
        }),
        Err(error) if matches!(&error, AppError::Coded { code, .. } if *code == "PLUGIN_TAB_NOT_FOUND") => {
            Ok(PluginGate::default())
        }
        Err(error) => Err(error),
    }
}

async fn current_backend() -> Option<String> {
    settings_store::global_get(EDITOR_BACKEND_KEY)
}

#[utoipa::path(
    get,
    path = "/api/neovim/migration",
    responses((status = 200, body = NeovimMigrationStatus))
)]
pub async fn migration_status_route(
    State(state): State<AppState>,
) -> Result<Json<NeovimMigrationStatus>, AppError> {
    let gate = load_gate(&state).await?;
    let sessions_running = state.neovim_manager.running_features().await;
    Ok(Json(NeovimMigrationStatus {
        plugin: plugin_state(&gate),
        sessions_running,
        current_backend: current_backend().await,
        target: NEOVIM_PLUGIN_EDITOR_ID.to_string(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/neovim/migration",
    responses(
        (status = 200, body = NeovimMigrationResponse),
        (status = 404, description = "Plugin not installed"),
        (status = 409, description = "Plugin not ready or a built-in session is running")
    )
)]
pub async fn migrate_to_plugin_route(
    State(state): State<AppState>,
) -> Result<Json<NeovimMigrationResponse>, AppError> {
    let gate = load_gate(&state).await?;
    let sessions_running = state.neovim_manager.running_features().await;
    let current = current_backend().await;
    match decide(&gate, &sessions_running, current.as_deref())? {
        Decision::AlreadyMigrated => Ok(Json(NeovimMigrationResponse {
            migrated: false,
            editor_backend: current.unwrap_or_else(|| NEOVIM_PLUGIN_EDITOR_ID.to_string()),
        })),
        Decision::Migrate => {
            debug_assert!(settings_allowlist::is_workspace_key_allowed(
                EDITOR_BACKEND_KEY
            ));
            settings_store::global_set(EDITOR_BACKEND_KEY, NEOVIM_PLUGIN_EDITOR_ID).await?;
            tracing::info!(
                plugin = NEOVIM_PLUGIN_ID,
                key = EDITOR_BACKEND_KEY,
                value = NEOVIM_PLUGIN_EDITOR_ID,
                "audit: migrated the built-in full Neovim editor to the neovim plugin"
            );
            Ok(Json(NeovimMigrationResponse {
                migrated: true,
                editor_backend: NEOVIM_PLUGIN_EDITOR_ID.to_string(),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> PluginGate {
        PluginGate {
            installed: true,
            blocked: false,
            valid: true,
            has_editor: true,
            has_backend: true,
            entry_present: true,
            backend_available_here: true,
            consent_required: false,
            effective: true,
        }
    }

    fn code(error: &AppError) -> &'static str {
        match error {
            AppError::Coded { code, .. } => code,
            other => panic!("expected a coded error, got {other:?}"),
        }
    }

    #[test]
    fn not_installed_is_a_404() {
        let error = decide(&PluginGate::default(), &[], None).unwrap_err();
        assert_eq!(code(&error), "NEOVIM_PLUGIN_NOT_INSTALLED");
    }

    #[test]
    fn blocked_beats_everything_else() {
        let mut gate = ready();
        gate.blocked = true;
        gate.consent_required = true;
        let error = decide(&gate, &[7], None).unwrap_err();
        assert_eq!(code(&error), "NEOVIM_PLUGIN_BLOCKED");
    }

    #[test]
    fn a_tab_without_editor_contribution_is_refused() {
        let mut gate = ready();
        gate.has_editor = false;
        let error = decide(&gate, &[], None).unwrap_err();
        assert_eq!(code(&error), "NEOVIM_PLUGIN_NOT_AN_EDITOR");
    }

    #[test]
    fn missing_built_ui_is_refused_before_consent() {
        let mut gate = ready();
        gate.entry_present = false;
        let error = decide(&gate, &[], None).unwrap_err();
        assert_eq!(code(&error), "NEOVIM_PLUGIN_NOT_BUILT");
    }

    #[test]
    fn backend_for_another_platform_is_refused() {
        let mut gate = ready();
        gate.backend_available_here = false;
        let error = decide(&gate, &[], None).unwrap_err();
        assert_eq!(code(&error), "NEOVIM_PLUGIN_BACKEND_UNAVAILABLE");
    }

    #[test]
    fn consent_is_required_before_enablement() {
        let mut gate = ready();
        gate.consent_required = true;
        gate.effective = false;
        let error = decide(&gate, &[], None).unwrap_err();
        assert_eq!(code(&error), "NEOVIM_PLUGIN_CONSENT_REQUIRED");
    }

    #[test]
    fn consented_but_disabled_is_refused() {
        let mut gate = ready();
        gate.effective = false;
        let error = decide(&gate, &[], None).unwrap_err();
        assert_eq!(code(&error), "NEOVIM_PLUGIN_NOT_ENABLED");
    }

    #[test]
    fn running_builtin_sessions_block_the_migration() {
        let error = decide(&ready(), &[3, 9], None).unwrap_err();
        assert_eq!(code(&error), "NEOVIM_SESSIONS_RUNNING");
    }

    #[test]
    fn already_migrated_is_idempotent_even_with_sessions_running() {
        let decision = decide(&ready(), &[3], Some(NEOVIM_PLUGIN_EDITOR_ID)).unwrap();
        assert!(matches!(decision, Decision::AlreadyMigrated));
    }

    #[test]
    fn ready_without_sessions_migrates() {
        let decision = decide(&ready(), &[], Some("neovim")).unwrap();
        assert!(matches!(decision, Decision::Migrate));
        let decision = decide(&ready(), &[], None).unwrap();
        assert!(matches!(decision, Decision::Migrate));
    }

    #[test]
    fn plugin_state_maps_every_gate() {
        assert_eq!(
            plugin_state(&PluginGate::default()),
            NeovimMigrationPluginState::NotInstalled
        );
        assert_eq!(plugin_state(&ready()), NeovimMigrationPluginState::Ready);
    }
}
