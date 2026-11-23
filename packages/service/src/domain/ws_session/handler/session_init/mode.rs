use std::path::Path;

use crate::app_state::AppState;
use crate::domain::agents::adapter::{AgentRuntimeAdapter, RuntimeError, RuntimePermissionMode};
use crate::domain::agents::permission_modes::{parse_permission_mode, permission_mode_wire};
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};
use crate::domain::ws_session::runtime::helpers::send_warning;

use super::super::helpers::saved_or_report;
use super::{send_error, WsSender};

const DISCOVERY_FAILED: &str = "PROVIDER_MODE_DISCOVERY_FAILED";

pub(super) struct Prepared {
    pub mode: Option<RuntimePermissionMode>,
    pub wire: Option<String>,
    pub warning: Option<RuntimeError>,
}

#[bon::builder]
pub(super) async fn prepare(
    app_state: &AppState,
    sender: &WsSender,
    ref_id: &str,
    session_id: i64,
    adapter: &dyn AgentRuntimeAdapter,
    cwd: &Path,
    requested: Option<&str>,
    row: Option<&SessionRow>,
) -> Option<Prepared> {
    let saved = row.and_then(|row| row.permission_mode.as_deref());
    let mode = match adapter
        .resolve_initial_permission_mode(cwd, requested.or(saved))
        .await
    {
        Ok(mode) => mode,
        Err(error) => {
            let restoring = is_restoring(&app_state.read_pool, row)
                .await
                .map_err(|error| {
                    send_error(
                        sender,
                        ref_id,
                        "DB_ERROR",
                        &format!("Failed to read conversation history: {error}"),
                    );
                })
                .ok()?;
            if !restoring {
                send_error(sender, ref_id, DISCOVERY_FAILED, &error.to_string());
                return None;
            }
            let mode = saved
                .map(parse_permission_mode)
                .filter(|mode| Some(permission_mode_wire(mode).as_str()) == saved);
            return Some(Prepared {
                mode,
                wire: saved.map(str::to_owned),
                warning: Some(error),
            });
        }
    };
    let persisted_mode = persist(app_state, session_id, saved, mode.as_ref()).await;
    let wire = saved_or_report(sender, ref_id, "permission mode", persisted_mode)?;
    Some(Prepared {
        mode,
        wire,
        warning: None,
    })
}

pub(super) fn report_warning(sender: &WsSender, ref_id: &str, warning: Option<RuntimeError>) {
    if let Some(warning) = warning {
        send_warning(
            sender,
            ref_id,
            DISCOVERY_FAILED,
            &format!("Could not verify permission modes: {warning}"),
        );
    }
}

async fn is_restoring(
    pool: &sqlx::SqlitePool,
    row: Option<&SessionRow>,
) -> Result<bool, sqlx::Error> {
    let Some(row) = row else {
        return Ok(false);
    };
    if row
        .runtime_session_id
        .as_deref()
        .is_some_and(|id| !id.is_empty())
    {
        return Ok(true);
    }
    super::super::session_control::session_has_messages(pool, row.id).await
}

/// Persist the provider's resolved initial mode for the initialized reply.
pub(super) async fn persist(
    app_state: &AppState,
    db_session_id: i64,
    saved: Option<&str>,
    mode: Option<&RuntimePermissionMode>,
) -> Result<Option<String>, sqlx::Error> {
    let wire = mode.map(permission_mode_wire);
    if let Some(wire) = wire.as_deref().filter(|wire| Some(*wire) != saved) {
        WsSessionPersistence::update_permission_mode_static(
            &app_state.write_pool,
            db_session_id,
            wire,
        )
        .await?;
    }
    Ok(wire)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeSpawnConfig};
    use crate::domain::agents::runtime::ProviderCatalogEntry;
    use crate::domain::agents::runtime_adapter;
    use crate::domain::ws_session::handler::tests::support::make_test_app_state;

    struct OfflineProvider;

    #[async_trait::async_trait]
    impl AgentRuntimeAdapter for OfflineProvider {
        fn catalog_entry(&self) -> ProviderCatalogEntry {
            panic!("session mode initialization should use the provider's workspace methods")
        }

        async fn spawn(
            &self,
            _: serde_json::Value,
            _: RuntimeSpawnConfig,
        ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
            panic!("opening history should not spawn a runtime")
        }

        async fn resolve_initial_permission_mode(
            &self,
            _: &Path,
            _: Option<&str>,
        ) -> Result<Option<RuntimePermissionMode>, RuntimeError> {
            Err(RuntimeError::new("fixture model discovery unavailable"))
        }
    }

    #[tokio::test]
    async fn saved_history_keeps_its_mode_when_cold_or_when_a_change_cannot_be_verified() {
        let state = make_test_app_state().await;
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        for (id, provider, resume_id) in [
            (1, Some("offline"), Some("saved-native-session")),
            (2, Some("offline"), None),
            (3, None, None),
        ] {
            sqlx::query(
                "INSERT INTO agent_sessions
                 (id, feature_id, agent_type, runtime_provider, runtime_session_id, model, permission_mode)
                 VALUES (?, ?, 'session', ?, ?, 'stored-model', 'plan')",
            )
            .bind(id)
            .bind(id)
            .bind(provider)
            .bind(resume_id)
            .execute(&state.write_pool)
            .await
            .unwrap();
            if resume_id.is_none() {
                sqlx::query(
                    "INSERT INTO agent_messages (session_id, role, content) VALUES (?, 'user', 'saved prompt')",
                )
                .bind(id)
                .execute(&state.write_pool)
                .await
                .unwrap();
            }
            let row = WsSessionPersistence::get_session_row(&state.read_pool, id)
                .await
                .unwrap()
                .unwrap();
            for requested in [None, Some("plan"), Some("bypassPermissions")] {
                let prepared = prepare()
                    .app_state(&state)
                    .sender(&sender)
                    .ref_id("open-history")
                    .session_id(id)
                    .adapter(&OfflineProvider)
                    .cwd(Path::new("/tmp"))
                    .maybe_requested(requested)
                    .row(&row)
                    .call()
                    .await
                    .expect("saved history should initialize");
                assert_eq!(prepared.mode, Some(RuntimePermissionMode::Plan));
                assert_eq!(prepared.wire.as_deref(), Some("plan"));
                assert!(prepared.warning.is_some());
            }
            let stored = WsSessionPersistence::get_session_row(&state.read_pool, id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(stored.permission_mode.as_deref(), Some("plan"));
        }
        assert!(
            receiver.try_recv().is_err(),
            "opening history should not emit init errors"
        );
        let fresh_mode = prepare()
            .app_state(&state)
            .sender(&sender)
            .ref_id("new-session")
            .session_id(4)
            .adapter(&OfflineProvider)
            .cwd(Path::new("/tmp"))
            .requested("plan")
            .call()
            .await;
        assert!(
            fresh_mode.is_none(),
            "fresh sessions still require discovery"
        );
        let error = receiver.try_recv().expect("fresh init discovery error");
        assert!(error.to_text().unwrap().contains(DISCOVERY_FAILED));
    }

    #[tokio::test]
    async fn a_fresh_row_uses_the_provider_mode_even_with_the_legacy_sql_default() {
        let state = make_test_app_state().await;
        sqlx::raw_sql(
            "ALTER TABLE agent_sessions RENAME COLUMN permission_mode TO test_old_permission_mode;
             ALTER TABLE agent_sessions ADD COLUMN permission_mode TEXT DEFAULT 'bypassPermissions';",
        )
        .execute(&state.write_pool)
        .await
        .unwrap();
        for (feature_id, provider, expected_mode) in [
            (1, "claude_code", "auto"),
            (2, "codex_cli", "default"),
            (3, "opencode", "acceptEdits"),
        ] {
            let session_id = WsSessionPersistence::new(state.write_pool.clone(), feature_id)
                .find_or_create_session_for_binding(None, None, None)
                .await
                .unwrap();
            let row = WsSessionPersistence::get_session_row(&state.read_pool, session_id)
                .await
                .unwrap()
                .unwrap();
            assert!(row.permission_mode.is_none(), "{provider}");
            let requested_mode = row.permission_mode.as_deref();
            let adapter = runtime_adapter(provider).unwrap();
            let mode = adapter
                .resolve_initial_permission_mode(&std::env::temp_dir(), requested_mode)
                .await
                .unwrap();
            let wire = persist(&state, session_id, requested_mode, mode.as_ref())
                .await
                .unwrap();
            assert_eq!(wire.as_deref(), Some(expected_mode), "{provider}");
            let stored = WsSessionPersistence::get_session_row(&state.read_pool, session_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(stored.permission_mode.as_deref(), Some(expected_mode));
        }
    }
}
