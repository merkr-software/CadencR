use crate::shared::discard::IgnoreClosed;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::ws::Message;
use axum::http::StatusCode;
use serde_json::Value;
use sqlx::SqlitePool;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::domain::agents::adapter::{
    AgentRuntimeAdapter, AgentRuntimeSession, RuntimeError, RuntimePermissionMode, RuntimePurpose,
    RuntimeSpawnConfig,
};
use crate::domain::agents::providers::runtime_adapter;
use crate::domain::agents::{resolve_selection, SelectionError};
use crate::domain::features::run_registry::FeatureRunPermit;
use crate::domain::features::title::{lock_title_updates, GeneratedTitlePolicy};
use crate::domain::settings_store::file::{SETTINGS_INVALID, SETTINGS_READ_FAILED};
use crate::domain::workflow::ws_sender::{
    send_feature_renamed_envelope, send_feature_updated_envelope,
};
use crate::error::AppError;

use super::protocol::{
    FeatureAutoNamingPayload, SessionWarningPayload, WsEnvelope, WsSessionEvent,
};

mod drain;
use drain::drain_title;
mod prompt;
use prompt::{build_prompt, resolve_system_prompt};
pub use prompt::{AUTO_NAME_USER_PROMPT_PREFIX, DEFAULT_AUTO_NAME_SYSTEM_PROMPT};
mod title_state;
use title_state::{has_default_title, persist_title, TitleOutcome};

const AUTO_NAME_PREPARATION_TIMEOUT: Duration = Duration::from_secs(120);

fn send_session_event(senders: &[mpsc::UnboundedSender<Message>], event: WsSessionEvent) {
    let envelope =
        WsEnvelope::session_event(&event).expect("session event payload should serialize");
    let frame = Message::Text(String::from(envelope).into());
    for sender in senders {
        sender.send(frame.clone()).ignore_closed();
    }
}

/// Leaves the header usable when an attempt returns early or is cancelled.
struct NamingProgress<'a> {
    feature_id: i64,
    senders: &'a [mpsc::UnboundedSender<Message>],
}

impl NamingProgress<'_> {
    fn send(&self, in_progress: bool) {
        send_session_event(
            self.senders,
            WsSessionEvent::FeatureAutonaming(FeatureAutoNamingPayload {
                feature_id: self.feature_id,
                in_progress,
            }),
        );
    }
}

impl Drop for NamingProgress<'_> {
    fn drop(&mut self) {
        self.send(false);
    }
}

/// Fetch the most recent user message content for the given feature.
/// Returns `None` if no user message exists.
pub async fn get_last_user_message(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT m.content FROM agent_messages m
         JOIN agent_sessions s ON s.id = m.session_id
         WHERE s.feature_id = ? AND m.message_type = 'user_message'
         ORDER BY m.id DESC LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(content,)| content))
}

/// Name an eligible feature and tell its viewers about any failure. Returns
/// whether the title changed, so the caller can refresh the global sidebar.
pub(in crate::domain::ws_session) async fn auto_name_feature(
    pool: &SqlitePool,
    feature_id: i64,
    user_input: &str,
    cwd: &str,
    ws_sender: &mpsc::UnboundedSender<Message>,
    _permit: FeatureRunPermit,
) -> bool {
    auto_name_eligible_feature(
        pool,
        feature_id,
        ws_sender,
        generate_title(pool, feature_id, user_input, cwd),
    )
    .await
}

async fn auto_name_eligible_feature(
    pool: &SqlitePool,
    feature_id: i64,
    ws_sender: &mpsc::UnboundedSender<Message>,
    title: impl Future<Output = Result<String, AppError>>,
) -> bool {
    let senders = std::slice::from_ref(ws_sender);
    let (result, database_message) = match has_default_title(pool, feature_id).await {
        Ok(false) => return false,
        Ok(true) => (
            rename_with_progress(
                pool,
                feature_id,
                senders,
                GeneratedTitlePolicy::PreserveManualTitle,
                title,
            )
            .await,
            "Cadencr could not save the conversation title. Try again.",
        ),
        Err(error) => (
            Err(error),
            "Cadencr could not read the conversation title. Try again.",
        ),
    };
    match result {
        Ok(outcome) => outcome == TitleOutcome::Renamed,
        Err(error) => {
            report_automatic_failure(senders, feature_id, &error, database_message);
            false
        }
    }
}

pub(crate) async fn auto_name_on_request(
    pool: &SqlitePool,
    feature_id: i64,
    user_input: &str,
    cwd: &str,
    ws_senders: &[mpsc::UnboundedSender<Message>],
    revision: Option<&str>,
) -> Result<(), AppError> {
    rename_with_progress(
        pool,
        feature_id,
        ws_senders,
        GeneratedTitlePolicy::ReplaceIfManualTitleUnchanged { revision },
        generate_title(pool, feature_id, user_input, cwd),
    )
    .await
    .map(drop)
}

async fn rename_with_progress(
    pool: &SqlitePool,
    feature_id: i64,
    senders: &[mpsc::UnboundedSender<Message>],
    title_policy: GeneratedTitlePolicy<'_>,
    title: impl Future<Output = Result<String, AppError>>,
) -> Result<TitleOutcome, AppError> {
    let progress = NamingProgress {
        feature_id,
        senders,
    };
    progress.send(true);
    let title = title.await?;
    let _title_update = lock_title_updates(feature_id).await;
    let outcome = persist_title(pool, feature_id, &title, title_policy).await?;
    if outcome == TitleOutcome::Renamed {
        for sender in senders {
            send_feature_renamed_envelope(sender, feature_id, &title);
            send_feature_updated_envelope(sender, feature_id, &["title"]);
        }
        info!(feature_id, "auto-named feature");
    }
    Ok(outcome)
}

fn report_automatic_failure(
    senders: &[mpsc::UnboundedSender<Message>],
    feature_id: i64,
    error: &AppError,
    database_message: &str,
) {
    let code = error.code();
    warn!(feature_id, code, "auto-name: attempt failed");
    let detail = match error {
        AppError::Coded { message, .. } => message,
        AppError::DatabaseBusy(_) => "The database is busy. Try again in a moment.",
        AppError::DatabaseError(_) | AppError::ConstraintViolation(_) => database_message,
        AppError::NotFound(_) => "The conversation no longer exists.",
        _ => "Try again from the conversation title menu.",
    };
    // Naming runs alongside the agent's turn. The existing warning channel
    // surfaces the problem without failing the turn or its pending prompts.
    send_session_event(
        senders,
        WsSessionEvent::Warning(SessionWarningPayload {
            code: code.into(),
            message: format!("Could not auto-name this conversation. {detail}"),
        }),
    );
}

async fn generate_title(
    pool: &SqlitePool,
    feature_id: i64,
    user_input: &str,
    cwd: &str,
) -> Result<String, AppError> {
    let (provider_id, session) = with_preparation_timeout(async {
        // Use the same provider and model resolution as the settings UI.
        let selection = resolve_selection(pool, Some(Path::new(cwd)), "auto_name", None, None)
            .await
            .map_err(selection_failure)?;
        let adapter = runtime_adapter(&selection.provider_id).ok_or_else(|| {
            AppError::coded(
                StatusCode::SERVICE_UNAVAILABLE,
                "AUTO_NAME_PROVIDER_UNAVAILABLE",
                "The auto-naming provider is unavailable. Check the provider in workspace settings.",
            )
        })?;
        let session = launch_naming_session(adapter.as_adapter(), &selection.model_id, cwd, user_input).await?;
        Ok((selection.provider_id, session))
    }).await?;
    drain_title(feature_id, &provider_id, session).await
}

async fn with_preparation_timeout<T>(
    prepare: impl Future<Output = Result<T, AppError>>,
) -> Result<T, AppError> {
    tokio::time::timeout(AUTO_NAME_PREPARATION_TIMEOUT, prepare)
        .await
        .map_err(|_| AppError::coded(
            StatusCode::GATEWAY_TIMEOUT,
            "AUTO_NAME_START_TIMEOUT",
            "The auto-naming provider did not start in time. Check its installation and active profile, then try again.",
        ))?
}

async fn launch_naming_session(
    adapter: &dyn AgentRuntimeAdapter,
    model_id: &str,
    cwd: &str,
    user_input: &str,
) -> Result<Box<dyn AgentRuntimeSession>, AppError> {
    let system_prompt = resolve_system_prompt()?;
    let prompt = build_prompt(user_input, &system_prompt);
    let config = build_spawn_config(adapter, model_id, cwd, system_prompt)
        .await
        .map_err(|error| {
            runtime_failure(
                error,
                "AUTO_NAME_PROFILE_FAILED",
                "Could not load the auto-naming provider profile. Check its configuration and try again.",
            )
        })?;
    adapter.spawn(Value::String(prompt), config).await.map_err(|error| {
        runtime_failure(
            error,
            "AUTO_NAME_SPAWN_FAILED",
            "Could not start the auto-naming provider. Check its installation and active profile, then try again.",
        )
    })
}

fn selection_failure(error: SelectionError) -> AppError {
    match error {
        SelectionError::NoModelAvailable { .. } => AppError::coded(
            StatusCode::BAD_REQUEST,
            error.code(),
            "The auto-naming provider exposes no usable models. Check that its CLI is installed and authenticated, or select another provider.",
        ),
        SelectionError::Settings(error) => {
            settings_failure(error, "the auto-naming provider, model or active profile")
        }
    }
}

fn settings_failure(error: AppError, setting: &str) -> AppError {
    match error {
        // Profile validation can name stored values. Keep the status and code,
        // and describe the setting to repair without quoting its contents.
        AppError::Coded { status, code, .. } => {
            let reason = match code {
                SETTINGS_READ_FAILED => "could not be read",
                SETTINGS_INVALID => "are invalid",
                _ => "could not be loaded",
            };
            AppError::coded(
                status,
                code,
                format!("The settings for {setting} {reason}. Check them in workspace settings via Edit JSON."),
            )
        }
        AppError::BadRequest(_) | AppError::NotFound(_) => AppError::coded(
            StatusCode::BAD_REQUEST,
            "AUTO_NAME_PROFILE_FAILED",
            "The auto-naming provider profile is invalid. Check its configuration and try again.",
        ),
        other => other,
    }
}

fn runtime_failure(error: RuntimeError, code: &'static str, message: &'static str) -> AppError {
    // Provider stderr and RPC errors can echo configuration or credentials.
    match error {
        RuntimeError::Profile(error) => settings_failure(error, "the active auto-naming profile"),
        RuntimeError::CliNotFound { .. } => AppError::coded(
            StatusCode::SERVICE_UNAVAILABLE,
            "AUTO_NAME_CLI_NOT_FOUND",
            "The auto-naming provider's CLI could not be found. Check its installation and try again.",
        ),
        _ => AppError::coded(StatusCode::BAD_GATEWAY, code, message),
    }
}

async fn build_spawn_config(
    adapter: &dyn AgentRuntimeAdapter,
    model_id: &str,
    cwd: &str,
    system_prompt: String,
) -> Result<RuntimeSpawnConfig, RuntimeError> {
    let resolved_profile = adapter.resolve_profile(None, Path::new(cwd)).await?;
    let env = resolved_profile
        .as_ref()
        .map(|profile| profile.env.clone())
        .filter(|env| !env.is_empty())
        .or_else(|| adapter.environment_for_new_session());
    // Extended thinking can exhaust the title deadline before producing text.
    // Disable it for the short naming run regardless of the model preference.
    Ok(RuntimeSpawnConfig {
        cwd: PathBuf::from(cwd),
        permission_mode: Some(RuntimePermissionMode::Plan),
        validate_restored_permission_mode: false,
        access_mode: None,
        model: Some(model_id.to_string()),
        thinking_effort: None,
        fast_mode: false,
        system_prompt: Some(system_prompt),
        purpose: Some(RuntimePurpose::AutoName),
        resume_session_id: None,
        allow_bypass_permissions: false,
        mcp_servers: None,
        permission_handler: None,
        env,
        profile: resolved_profile
            .as_ref()
            .map(|profile| profile.identity.clone())
            .or_else(|| adapter.profile_name_for_new_session()),
        env_unset: resolved_profile
            .as_ref()
            .map(|profile| profile.env_unset.clone())
            .unwrap_or_default(),
        overrides: crate::domain::agents::adapter::RuntimeConfigOverrides {
            model: Some(model_id.to_string()),
            thinking_effort: None,
            fast_mode: Some(false),
        },
        profile_revision: resolved_profile
            .as_ref()
            .map(|profile| profile.revision.clone()),
        profile_state_identity: resolved_profile.and_then(|profile| profile.state_identity),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::{adapter::ResolvedRuntimeProfile, runtime::ProviderCatalogEntry};
    use crate::domain::features::repository::{manual_title_revision, update_title_manually};
    use crate::domain::features::run_registry::FeatureRunRegistry;
    use crate::domain::settings_store;
    use axum::response::IntoResponse;
    use title_state::title_pool;

    enum RejectingAdapter {
        Profile,
        Spawn,
    }

    #[async_trait::async_trait]
    impl AgentRuntimeAdapter for RejectingAdapter {
        fn catalog_entry(&self) -> ProviderCatalogEntry {
            unreachable!("the provider has already been selected")
        }

        async fn resolve_profile(
            &self,
            _selection: Option<&str>,
            _cwd: &Path,
        ) -> Result<Option<ResolvedRuntimeProfile>, RuntimeError> {
            match self {
                Self::Profile => Err(RuntimeError::Profile(AppError::coded(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    SETTINGS_READ_FAILED,
                    "profile read failed: synthetic-private-value",
                ))),
                Self::Spawn => Ok(None),
            }
        }

        async fn spawn(
            &self,
            _prompt: Value,
            _config: RuntimeSpawnConfig,
        ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
            assert!(
                matches!(self, Self::Spawn),
                "profile failure must stop launch"
            );
            Err(RuntimeError::new("provider said synthetic-private-value"))
        }
    }

    fn collect_frames(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<WsEnvelope> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| WsEnvelope::try_from(message.into_text().unwrap().to_string()).unwrap())
            .collect()
    }

    fn assert_progress(frames: &[WsEnvelope]) {
        for (frame, in_progress) in [
            (frames.first().unwrap(), true),
            (frames.last().unwrap(), false),
        ] {
            assert_eq!(
                (frame.domain.as_str(), frame.action.as_str()),
                ("session", "feature.autonaming")
            );
            assert_eq!(
                frame.payload,
                serde_json::json!({"feature_id": 1, "in_progress": in_progress})
            );
        }
    }

    fn assert_single_warning(
        rx: &mut mpsc::UnboundedReceiver<Message>,
        expected_code: &str,
        expected_message: &str,
        progress: bool,
    ) {
        let frames = collect_frames(rx);
        assert_eq!(frames.len(), if progress { 3 } else { 1 });
        if progress {
            assert_progress(&frames[..2]);
        }
        let warning = frames.last().unwrap();
        assert_eq!(
            (warning.domain.as_str(), warning.action.as_str()),
            ("session", "warning")
        );
        assert!(warning.r#ref.is_none());
        assert_eq!(warning.payload["code"], expected_code);
        let message = warning.payload["message"].as_str().unwrap();
        assert!(message.starts_with("Could not auto-name this conversation."));
        assert!(message.contains(expected_message), "{message}");
        assert!(!message.contains("synthetic-private-value"));
    }

    async fn read_stored_title(pool: &SqlitePool) -> String {
        sqlx::query_scalar("SELECT title FROM features WHERE id = 1")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn refuse_title_writes(pool: &SqlitePool) {
        sqlx::query("CREATE TRIGGER refuse_title BEFORE UPDATE OF title ON features BEGIN SELECT RAISE(ABORT, 'synthetic-private-value'); END")
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn automatic_selection_failure_clears_progress_and_warns_once() {
        let pool = title_pool("Session 1").await;
        let path = settings_store::paths::global_file(&settings_store::global_dir());
        settings_store::file::write_atomic(
            &path,
            r#"{"agent_runtime_auto_name":["synthetic-private-value"]}"#,
        )
        .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let runs = FeatureRunRegistry::new();

        let permit = runs.try_acquire(1).unwrap();
        assert!(!auto_name_feature(&pool, 1, "Fix login", "/tmp", &tx, permit).await);
        assert!(
            runs.try_acquire(1).is_some(),
            "a failure allows the explicit retry"
        );

        assert_single_warning(
            &mut rx,
            SETTINGS_INVALID,
            "provider, model or active profile",
            true,
        );
        assert_eq!(read_stored_title(&pool).await, "Session 1");
    }

    #[test]
    fn selection_without_models_keeps_its_code() {
        let error = selection_failure(SelectionError::NoModelAvailable {
            provider_id: "test-provider".into(),
        });
        assert!(matches!(
            error,
            AppError::Coded {
                status: StatusCode::BAD_REQUEST,
                code: "NO_MODEL_AVAILABLE",
                ..
            }
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_provider_preparation_has_its_own_timeout() {
        let error = with_preparation_timeout::<()>(std::future::pending())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            AppError::Coded {
                status: StatusCode::GATEWAY_TIMEOUT,
                code: "AUTO_NAME_START_TIMEOUT",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn profile_and_spawn_failures_are_safe_and_each_warn_once() {
        let pool = title_pool("Session 1").await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        for (adapter, expected_code, expected_message) in [
            (
                RejectingAdapter::Profile,
                SETTINGS_READ_FAILED,
                "active auto-naming profile",
            ),
            (
                RejectingAdapter::Spawn,
                "AUTO_NAME_SPAWN_FAILED",
                "Could not start",
            ),
        ] {
            let title = async {
                match launch_naming_session(&adapter, "model", "/tmp", "Fix login").await {
                    Err(error) => Err(error),
                    Ok(_) => panic!("the naming provider should fail before returning a session"),
                }
            };
            assert!(!auto_name_eligible_feature(&pool, 1, &tx, title).await);
            assert_single_warning(&mut rx, expected_code, expected_message, true);
        }
        assert_eq!(read_stored_title(&pool).await, "Session 1");
    }

    #[tokio::test]
    async fn automatic_database_failures_warn_at_the_read_and_write_boundaries() {
        let pool = title_pool("Session 1").await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        refuse_title_writes(&pool).await;
        assert!(!auto_name_eligible_feature(&pool, 1, &tx, async { Ok("Fix Login".into()) }).await);
        assert_single_warning(
            &mut rx,
            "DATABASE_ERROR",
            "could not save the conversation title",
            true,
        );
        assert_eq!(read_stored_title(&pool).await, "Session 1");

        sqlx::query("DROP TABLE feature_settings")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            !auto_name_eligible_feature(&pool, 1, &tx, async { panic!("eligibility failed") })
                .await
        );
        assert_single_warning(
            &mut rx,
            "DATABASE_ERROR",
            "could not read the conversation title",
            false,
        );
    }

    #[tokio::test]
    async fn a_manual_rename_during_generation_is_preserved_without_a_warning() {
        let pool = title_pool("Session 1").await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let title = async {
            let started = collect_frames(&mut rx);
            assert_eq!(started.len(), 1);
            assert_eq!(started[0].payload["in_progress"], true);
            update_title_manually(&pool, 1, "Session 42").await.unwrap();
            Ok("Generated Title".into())
        };

        assert!(!auto_name_eligible_feature(&pool, 1, &tx, title).await);
        assert_eq!(read_stored_title(&pool).await, "Session 42");
        let frames = collect_frames(&mut rx);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].action, "feature.autonaming");
        assert_eq!(frames[0].payload["in_progress"], false);
    }

    #[tokio::test]
    async fn successful_automatic_naming_emits_the_persisted_title() {
        let pool = title_pool("Session 1").await;
        let (tx, mut rx) = mpsc::unbounded_channel();

        assert!(auto_name_eligible_feature(&pool, 1, &tx, async { Ok("Fix Login".into()) }).await);

        assert_eq!(read_stored_title(&pool).await, "Fix Login");
        let frames = collect_frames(&mut rx);
        assert_eq!(frames.len(), 4);
        assert_progress(&frames);
        assert_eq!(frames[1].action, "feature.renamed");
        assert_eq!(frames[1].payload["title"], "Fix Login");
        assert_eq!(
            (frames[2].domain.as_str(), frames[2].action.as_str()),
            ("feature", "updated")
        );
    }

    #[tokio::test]
    async fn explicit_naming_can_retry_a_failed_write_without_viewers() {
        let pool = title_pool("Session 1").await;
        update_title_manually(&pool, 1, "Manual Title")
            .await
            .unwrap();
        let revision = manual_title_revision(&pool, 1).await.unwrap();
        refuse_title_writes(&pool).await;
        let attempt = || {
            rename_with_progress(
                &pool,
                1,
                &[],
                GeneratedTitlePolicy::ReplaceIfManualTitleUnchanged {
                    revision: revision.as_deref(),
                },
                async { Ok("Generated Title".into()) },
            )
        };

        let response = attempt().await.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            serde_json::json!({
                "code": "DATABASE_ERROR",
                "error": "Internal server error",
            })
        );
        assert_eq!(read_stored_title(&pool).await, "Manual Title");

        sqlx::query("DROP TRIGGER refuse_title")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(attempt().await.unwrap(), TitleOutcome::Renamed);
        assert_eq!(read_stored_title(&pool).await, "Generated Title");
    }

    #[tokio::test]
    async fn explicit_auto_name_preserves_a_manual_title_reentered_during_generation() {
        let pool = title_pool("Session 1").await;
        update_title_manually(&pool, 1, "Session 42").await.unwrap();
        let revision = manual_title_revision(&pool, 1).await.unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        let outcome = rename_with_progress(
            &pool,
            1,
            &[tx],
            GeneratedTitlePolicy::ReplaceIfManualTitleUnchanged {
                revision: revision.as_deref(),
            },
            async {
                assert_eq!(collect_frames(&mut rx)[0].payload["in_progress"], true);
                update_title_manually(&pool, 1, "Session 43").await.unwrap();
                update_title_manually(&pool, 1, "Session 42").await.unwrap();
                Ok("Generated Title".into())
            },
        )
        .await
        .unwrap();

        assert_eq!(outcome, TitleOutcome::ManualTitlePreserved);
        assert_eq!(read_stored_title(&pool).await, "Session 42");
        let frames = collect_frames(&mut rx);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].action, "feature.autonaming");
        assert_eq!(frames[0].payload["in_progress"], false);
    }

    #[tokio::test]
    async fn cancelling_an_attempt_clears_the_skeleton() {
        let pool = title_pool("Session 1").await;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let senders = [tx];
        let mut attempt = Box::pin(rename_with_progress(
            &pool,
            1,
            &senders,
            GeneratedTitlePolicy::ReplaceIfManualTitleUnchanged { revision: None },
            std::future::pending(),
        ));
        assert!(futures::poll!(attempt.as_mut()).is_pending());
        drop(attempt);

        let frames = collect_frames(&mut rx);
        assert_eq!(frames.len(), 2);
        assert_progress(&frames);
    }
}
