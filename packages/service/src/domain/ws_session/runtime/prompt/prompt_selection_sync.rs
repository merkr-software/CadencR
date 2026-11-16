//! Keeps a session handle on the model the conversation is persisted with.
//!
//! A conversation has one in-memory handle per connection that opened it, plus
//! the control map schedules, queued prompts and MCP dispatch through. A model
//! switch persists to the session row but only updates the handle it went
//! through (or the one owning the live turn), so the others keep the selection
//! they captured at `session.init`. Spawning or respawning from such a snapshot
//! silently moved the conversation back to an older model. The row is the
//! source of truth: re-read it before dispatching a prompt and adopt it when the
//! handle disagrees.

use sqlx::SqlitePool;
use tracing::info;

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeConfigOverrides;
use crate::domain::agents::runtime_adapter;
use crate::domain::agents::runtime_overrides::{self, RestoreOptions};
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};

use super::super::control_policy::adopt_runtime_overrides;
use super::super::{QueryState, SdkHandle};

/// The persisted selection a handle is compared against.
pub(in crate::domain::ws_session) struct StoredSelection {
    provider: Option<String>,
    model: Option<String>,
    thinking_effort: Option<String>,
    /// Built the way every handle builds its own, so the two compare equal
    /// when nothing changed.
    overrides: RuntimeConfigOverrides,
}

/// Read the selection persisted for `db_session_id`. Errors carry a stable code
/// for the prompt's error reply.
pub(in crate::domain::ws_session) async fn load(
    pool: &SqlitePool,
    db_session_id: i64,
) -> Result<StoredSelection, (&'static str, String)> {
    let row = WsSessionPersistence::try_get_session_row(pool, db_session_id)
        .await
        .map_err(|error| ("DB_ERROR", format!("failed to read the session: {error}")))?
        .ok_or_else(|| {
            (
                "SESSION_NOT_FOUND",
                format!("Session {db_session_id} not found"),
            )
        })?;
    from_row(row)
}

fn from_row(row: SessionRow) -> Result<StoredSelection, (&'static str, String)> {
    let overrides = runtime_overrides::restore(
        RestoreOptions::builder()
            .provider(row.runtime_provider.as_deref().unwrap_or_default())
            .maybe_runtime_session_id(row.runtime_session_id.as_deref())
            .maybe_stored_json(row.runtime_overrides.as_deref())
            .maybe_model(row.model.as_deref())
            .maybe_thinking_effort(row.thinking_effort.as_deref())
            .fast_mode(row.fast_mode)
            .build(),
    )
    .map_err(|error| ("INVALID_RUNTIME_OVERRIDES", error))?;
    Ok(StoredSelection {
        provider: row.runtime_provider,
        model: row.model,
        thinking_effort: row.thinking_effort,
        overrides,
    })
}

/// [`adopt`] for a handle of `db_session_id`, reading whether a turn is live.
pub(in crate::domain::ws_session) fn sync_handle(
    handle: &mut SdkHandle,
    stored: &StoredSelection,
    app_state: &AppState,
    db_session_id: i64,
) -> bool {
    let busy = app_state.session_status_tx.is_busy(db_session_id);
    adopt(handle, stored, db_session_id, busy)
}

/// Point `handle` at the stored selection when it holds another one, and
/// return whether it changed: a live runtime must then be respawned, like after
/// any model switch. A runtime in the middle of a turn (`busy`) is left alone
/// so the turn is never cut off; the next prompt after it adopts the selection.
pub(in crate::domain::ws_session) fn adopt(
    handle: &mut SdkHandle,
    stored: &StoredSelection,
    db_session_id: i64,
    busy: bool,
) -> bool {
    if busy && matches!(handle.state, QueryState::Active { .. }) {
        return false;
    }
    // A model only means something for the provider it was picked for. A
    // provider switch made elsewhere is not adopted here.
    if stored.provider.as_deref() != Some(handle.runtime_provider.as_str()) {
        return false;
    }
    let inherits_profile_config = runtime_adapter(&handle.runtime_provider)
        .is_some_and(|adapter| adapter.supports_profile_config_inheritance());
    let changed = if inherits_profile_config {
        adopt_overrides(handle, &stored.overrides)
    } else {
        adopt_model(handle, stored)
    };
    if changed {
        info!(
            db_session_id,
            model = ?handle.desired_model,
            "session handle held a stale model; adopted the persisted selection"
        );
    }
    changed
}

/// Providers that inherit their profile config spawn from the override
/// document, which carries the model and its effort together.
fn adopt_overrides(handle: &mut SdkHandle, stored: &RuntimeConfigOverrides) -> bool {
    if *stored == handle.config.overrides {
        return false;
    }
    adopt_runtime_overrides(handle, stored);
    true
}

/// Other providers spawn from the model column; a model switch persists its
/// effort alongside it, so the two move together.
fn adopt_model(handle: &mut SdkHandle, stored: &StoredSelection) -> bool {
    let Some(model) = stored.model.as_deref() else {
        return false;
    };
    if handle.desired_model.as_deref() == Some(model) {
        return false;
    }
    handle.desired_model = Some(model.to_string());
    handle.desired_thinking_effort = stored.thinking_effort.clone();
    handle.config.thinking_effort = stored.thinking_effort.clone();
    if let QueryState::Pending(options) = &mut handle.state {
        options.model = handle.desired_model.clone();
        options.thinking_effort = stored.thinking_effort.clone();
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::handler::tests::support::make_active_handle;

    fn stored(provider: &str, model: &str) -> StoredSelection {
        StoredSelection {
            provider: Some(provider.to_string()),
            model: Some(model.to_string()),
            thinking_effort: Some("high".to_string()),
            overrides: RuntimeConfigOverrides::default(),
        }
    }

    #[test]
    fn live_turn_keeps_its_model_until_it_is_idle() {
        let mut handle = make_active_handle(1, None);
        let provider = handle.runtime_provider.clone();
        let selection = stored(&provider, "opus");

        assert!(!adopt(&mut handle, &selection, 1, true));
        assert_eq!(handle.desired_model.as_deref(), Some("sonnet"));

        assert!(adopt(&mut handle, &selection, 1, false));
        assert_eq!(handle.desired_model.as_deref(), Some("opus"));
        assert_eq!(handle.desired_thinking_effort.as_deref(), Some("high"));
        assert!(!adopt(&mut handle, &selection, 1, false));
    }

    #[test]
    fn another_providers_model_is_ignored() {
        let mut handle = make_active_handle(1, None);
        assert!(!adopt(
            &mut handle,
            &stored("other_provider", "opus"),
            1,
            false
        ));
        assert_eq!(handle.desired_model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn profile_inheriting_providers_follow_the_override_document() {
        let mut handle = make_active_handle(1, None);
        handle.runtime_provider = crate::domain::agents::codex::PROVIDER_ID.to_string();
        let overrides = RuntimeConfigOverrides {
            model: Some("gpt-picked-later".to_string()),
            thinking_effort: Some("xhigh".to_string()),
            fast_mode: None,
        };
        let selection = StoredSelection {
            provider: Some(handle.runtime_provider.clone()),
            // The model column lags behind the document for these providers.
            model: Some("gpt-stale-column".to_string()),
            thinking_effort: None,
            overrides: overrides.clone(),
        };

        assert!(adopt(&mut handle, &selection, 1, false));
        assert_eq!(handle.config.overrides, overrides);
        assert!(handle.config.runtime_overrides_dirty);
        assert_eq!(handle.desired_model.as_deref(), Some("gpt-picked-later"));
        assert!(!adopt(&mut handle, &selection, 1, false));
    }

    #[test]
    fn pending_handle_adopts_even_while_a_turn_is_live_elsewhere() {
        let mut handle = make_active_handle(1, None);
        handle.state = QueryState::Pending(Default::default());
        let provider = handle.runtime_provider.clone();

        assert!(adopt(&mut handle, &stored(&provider, "opus"), 1, true));
        let QueryState::Pending(options) = &handle.state else {
            panic!("expected a pending handle");
        };
        assert_eq!(options.model.as_deref(), Some("opus"));
        assert_eq!(options.thinking_effort.as_deref(), Some("high"));
    }
}
