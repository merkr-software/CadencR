//! Recording which turns a restart is about to cut off (or already did).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use sqlx::SqlitePool;

use super::store::{self, Cause, Intent};
use crate::domain::ws_session::persistence::WsSessionPersistence;

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
/// Whether the turns this shutdown cuts off are resumed on the next start.
/// The desktop turns it off right before it stops the service when the user
/// quits and chooses to stop their agents; every other stop resumes them.
static RESUME_ON_SHUTDOWN: AtomicBool = AtomicBool::new(true);
static APP_VERSION: OnceLock<String> = OnceLock::new();
static STARTUP_CAPTURE_ERROR: OnceLock<String> = OnceLock::new();

/// Version of this service process (the desktop passes `--app-version`; dev
/// builds fall back to the crate version, like the migration backups do).
pub(super) fn app_version() -> &'static str {
    APP_VERSION
        .get()
        .map(String::as_str)
        .unwrap_or(env!("CARGO_PKG_VERSION"))
}

/// Why the crash capture failed this start, for the startup report.
pub(super) fn startup_capture_error() -> Option<String> {
    STARTUP_CAPTURE_ERROR.get().cloned()
}

/// True once the service has started shutting down. Stream readers use it to
/// end a turn that is closing because of the shutdown quietly, instead of
/// reporting "the agent stopped unexpectedly".
pub fn is_shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

pub(super) fn set_resume_on_shutdown(resume: bool) {
    RESUME_ON_SHUTDOWN.store(resume, Ordering::SeqCst);
}

fn shutdown_intent() -> Intent {
    if RESUME_ON_SHUTDOWN.load(Ordering::SeqCst) {
        Intent::Resume
    } else {
        Intent::Stop
    }
}

/// Capture every turn still running, before shutdown closes their runtimes.
///
/// Runs first in the shutdown teardown: once the runtimes close, their readers
/// pause the sessions and `running` no longer says which turns were cut off.
/// A turn this misses (one that started during the drain, or all of them when
/// the write fails) is captured by its reader when shutdown ends it
/// ([`capture_cut_off_turn`]).
pub async fn begin_shutdown(pool: &SqlitePool) {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    match store::capture_running(
        pool,
        Cause::Shutdown,
        shutdown_intent(),
        Some(app_version()),
    )
    .await
    {
        Ok(0) => {}
        Ok(count) => tracing::info!(count, "captured agent turns interrupted by shutdown"),
        Err(error) => {
            tracing::error!(%error, "failed to capture agent turns interrupted by shutdown")
        }
    }
}

/// Capture one turn shutdown just cut off, unless [`begin_shutdown`] already
/// did. Called by its stream reader before it pauses the session. There is no
/// client left to tell about a failure: that turn is then left paused, not
/// resumed.
pub async fn capture_cut_off_turn(pool: &SqlitePool, session_id: i64) {
    if let Err(error) =
        store::capture_session(pool, session_id, shutdown_intent(), Some(app_version())).await
    {
        tracing::error!(session_id, %error, "failed to capture an agent turn cut off by shutdown");
    }
}

/// Stop the agents a killed process left running, capture the turns it left
/// `running`, then reset them.
///
/// Must run before anything else touches session status at startup. The reset
/// happens even when the capture fails — a session stuck `running` would block
/// the user — and the failure reaches the user through the startup report.
pub async fn recover_at_startup(pool: &SqlitePool, app_version: Option<&str>) {
    let _ = APP_VERSION.set(app_version.unwrap_or(env!("CARGO_PKG_VERSION")).to_string());
    super::orphans::init(pool);
    match super::orphans::reap(pool).await {
        Ok(0) => {}
        Ok(count) => tracing::warn!(
            count,
            "stopped agent processes a killed service left running"
        ),
        Err(error) => {
            tracing::error!(%error, "failed to stop agent processes left by the last exit");
            let _ = STARTUP_CAPTURE_ERROR.set(format!(
                "Cadencr could not stop agents the last exit left running: {error}"
            ));
        }
    }
    match store::capture_running(pool, Cause::Crash, Intent::Resume, None).await {
        Ok(0) => {}
        Ok(count) => tracing::info!(count, "captured agent turns interrupted by a crash"),
        Err(error) => {
            tracing::error!(%error, "failed to capture agent turns interrupted by a crash");
            let _ = STARTUP_CAPTURE_ERROR.set(format!(
                "Cadencr could not check which agents the last exit interrupted: {error}"
            ));
        }
    }
    WsSessionPersistence::cleanup_stale_sessions(pool).await;
}
