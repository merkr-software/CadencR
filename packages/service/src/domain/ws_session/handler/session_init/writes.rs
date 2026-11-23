//! What `session.init` saves to the session row, applied only by the init
//! that installs its handle.
//!
//! The init resolves its controls (provider probes included) without holding
//! the session cell, so a prompt from another connection may spawn the
//! runtime meanwhile. The row is the source of truth the next prompt adopts
//! (`prompt_selection_sync`): a losing init that still saved its own provider,
//! model or mode would move the live conversation to them without a word. The
//! writes are therefore collected and applied under the cell lock, right
//! before the handle they describe is installed, and dropped when a live
//! runtime won.

use sqlx::SqlitePool;

use crate::domain::agents::adapter::RuntimeConfigOverrides;
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};

/// The row's runtime selection, as the init resolved it.
pub(super) enum SelectionWrite {
    /// A fresh row takes the controls of the project's last prompt.
    Inherited(Box<SessionRow>),
    Resolved {
        provider: String,
        model: Option<String>,
        initial_overrides: Option<RuntimeConfigOverrides>,
        clear_thinking_effort: bool,
    },
}

#[derive(Default)]
pub(super) struct InitWrites {
    /// Effort of a row that had none, anchored so later defaults do not move it.
    pub(super) effort_anchor: Option<String>,
    /// The provider's resolved mode, when it differs from the saved one.
    pub(super) permission_mode: Option<String>,
    /// The provider's default profile, for a row that had none.
    pub(super) default_profile: Option<String>,
    /// The restored fast mode is no longer supported by the model.
    pub(super) clear_fast_mode: bool,
    pub(super) selection: Option<SelectionWrite>,
}

/// A write that failed: the init reports it and installs nothing.
#[derive(Debug)]
pub(super) struct WriteFailure {
    pub(super) code: &'static str,
    pub(super) message: String,
}

impl WriteFailure {
    fn saving(what: &str, error: impl std::fmt::Display) -> Self {
        Self {
            code: "DB_ERROR",
            message: format!("Failed to save the conversation's {what}: {error}"),
        }
    }
}

impl InitWrites {
    /// Save everything, in the order the init used to resolve it.
    pub(super) async fn apply(
        &self,
        pool: &SqlitePool,
        session_id: i64,
    ) -> Result<(), WriteFailure> {
        if let Some(effort) = &self.effort_anchor {
            WsSessionPersistence::update_thinking_effort_static(pool, session_id, Some(effort))
                .await
                .map_err(|error| WriteFailure::saving("reasoning effort", error))?;
        }
        if let Some(mode) = &self.permission_mode {
            WsSessionPersistence::update_permission_mode_static(pool, session_id, mode)
                .await
                .map_err(|error| WriteFailure::saving("permission mode", error))?;
        }
        if let Some(profile) = &self.default_profile {
            WsSessionPersistence::update_profile_static(pool, session_id, profile)
                .await
                .map_err(|error| WriteFailure {
                    code: "PROFILE_ERROR",
                    message: format!("failed to save the conversation's profile: {error}"),
                })?;
        }
        if self.clear_fast_mode {
            WsSessionPersistence::update_fast_mode_static(pool, session_id, false)
                .await
                .map_err(|error| {
                    tracing::warn!(session_id, %error, "failed to normalize restored fast mode");
                    WriteFailure {
                        code: "DB_ERROR",
                        message: "Failed to restore fast mode".into(),
                    }
                })?;
        }
        if let Some(selection) = &self.selection {
            selection.apply(pool, session_id).await?;
        }
        Ok(())
    }
}

impl SelectionWrite {
    async fn apply(&self, pool: &SqlitePool, session_id: i64) -> Result<(), WriteFailure> {
        let persisted = match self {
            Self::Inherited(row) => row.persist_inherited_controls(pool).await,
            Self::Resolved {
                provider,
                model,
                initial_overrides,
                clear_thinking_effort,
            } => WsSessionPersistence::update_runtime_selection_static()
                .pool(pool)
                .session_id(session_id)
                .runtime_provider(provider)
                .maybe_model(model.as_deref())
                .maybe_initial_overrides(initial_overrides.as_ref())
                .clear_thinking_effort(*clear_thinking_effort)
                .call()
                .await
                .map_err(crate::error::AppError::from),
        };
        persisted.map_err(|error| {
            tracing::warn!(session_id, %error, "failed to persist session runtime selection");
            WriteFailure {
                code: "DB_ERROR",
                message: "Failed to persist session runtime selection".into(),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::handler::tests::support::make_test_app_state;

    #[tokio::test]
    async fn writes_land_together_on_the_row() {
        let state = make_test_app_state().await;
        let id = WsSessionPersistence::new(state.write_pool.clone(), 1)
            .find_or_create_session_for_binding(None, None, None)
            .await
            .unwrap();
        InitWrites {
            effort_anchor: Some("high".into()),
            permission_mode: Some("plan".into()),
            selection: Some(SelectionWrite::Resolved {
                provider: "claude_code".into(),
                model: Some("haiku".into()),
                initial_overrides: None,
                clear_thinking_effort: false,
            }),
            ..Default::default()
        }
        .apply(&state.write_pool, id)
        .await
        .unwrap();

        let row = WsSessionPersistence::get_session_row(&state.read_pool, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.runtime_provider.as_deref(), Some("claude_code"));
        assert_eq!(row.model.as_deref(), Some("haiku"));
        assert_eq!(row.thinking_effort.as_deref(), Some("high"));
        assert_eq!(row.permission_mode.as_deref(), Some("plan"));
    }
}
