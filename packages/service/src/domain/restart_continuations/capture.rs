//! Recording which turns a restart is about to cut off (or already did).

use crate::shared::discard::KeepFirst;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use sqlx::SqlitePool;

use super::store::{self, Cause, Intent, Intents};
use crate::domain::ws_session::persistence::WsSessionPersistence;

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
/// Whether the turns this shutdown cuts off are resumed on the next start.
/// The desktop turns it off right before it stops the service when the user
/// quits and chooses to stop their agents; every other stop resumes them.
static RESUME_ON_SHUTDOWN: AtomicBool = AtomicBool::new(true);
/// The same for background work between turns. The desktop also turns it off
/// when the user quits with no agent working: nothing asked them, so nothing
/// comes back on its own.
static RESUME_BACKGROUND_ON_SHUTDOWN: AtomicBool = AtomicBool::new(true);
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

pub(super) fn set_resume_on_shutdown(turns: bool, background_work: bool) {
    RESUME_ON_SHUTDOWN.store(turns, Ordering::SeqCst);
    RESUME_BACKGROUND_ON_SHUTDOWN.store(background_work, Ordering::SeqCst);
}

fn shutdown_intent() -> Intents {
    let intent = |resume: &AtomicBool| {
        if resume.load(Ordering::SeqCst) {
            Intent::Resume
        } else {
            Intent::Stop
        }
    };
    Intents {
        turn: intent(&RESUME_ON_SHUTDOWN),
        background: intent(&RESUME_BACKGROUND_ON_SHUTDOWN),
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

/// Capture one turn (or background work) shutdown just cut off, unless
/// [`begin_shutdown`] already did. Called by its stream reader before it
/// pauses the session or forgets the work. There is no
/// client left to tell about a failure: that turn is then left paused, not
/// resumed. Returns whether the capture was written, so a reader keeps its
/// background-work record for the next start when it was not.
pub async fn capture_cut_off_turn(pool: &SqlitePool, session_id: i64) -> bool {
    match store::capture_session(pool, session_id, shutdown_intent(), Some(app_version())).await {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(session_id, %error, "failed to capture an agent turn cut off by shutdown");
            false
        }
    }
}

/// Stop the agents a killed process left running, capture the turns it left
/// `running` and the background work it was running between turns, then
/// reset both.
///
/// Must run before anything else touches session status at startup. The reset
/// happens even when the capture fails — a session stuck `running` would block
/// the user — and the failure reaches the user through the startup report.
pub async fn recover_at_startup(pool: &SqlitePool, app_version: Option<&str>) {
    APP_VERSION.keep_first(app_version.unwrap_or(env!("CARGO_PKG_VERSION")).to_string());
    super::orphans::init(pool);
    let mut failures = Vec::new();
    match super::orphans::reap(pool).await {
        Ok(0) => {}
        Ok(count) => tracing::warn!(
            count,
            "stopped agent processes a killed service left running"
        ),
        Err(error) => {
            tracing::error!(%error, "failed to stop agent processes left by the last exit");
            failures.push(format!(
                "Cadencr could not stop agents the last exit left running: {error}"
            ));
        }
    }
    capture_left_behind(pool, &mut failures).await;
    // Like the status reset below, this happens even when the capture failed:
    // the runtimes those records describe are gone.
    if let Err(error) = super::background_work::clear(pool).await {
        tracing::error!(%error, "failed to forget background work the last exit stopped");
        failures.push(format!(
            "Cadencr could not reset which agents had background work running: {error}"
        ));
    }
    if let Err(error) = WsSessionPersistence::cleanup_stale_sessions(pool).await {
        tracing::error!(%error, "failed to reset sessions left running");
        failures.push(format!(
            "Cadencr could not reset conversations the last exit left running, so they may look busy: {error}"
        ));
    }
    if let Some(report) = startup_failure_report(&failures) {
        STARTUP_CAPTURE_ERROR.keep_first(report);
    }
}

/// Capture what the last process left `running` or owed a resume for. A quit
/// whose own capture failed left its intent behind: those turns follow it.
/// Anything else (a crash, a kill, an update) resumes.
async fn capture_left_behind(pool: &SqlitePool, failures: &mut Vec<String>) {
    let intents = match super::quit_intent::take(pool).await {
        Ok(intents) => intents.unwrap_or(Intent::Resume.into()),
        Err(error) => {
            tracing::error!(%error, "failed to read what the last quit asked for");
            failures.push(format!(
                "Cadencr could not read whether your last quit stopped its agents, so it resumes them: {error}"
            ));
            Intent::Resume.into()
        }
    };
    match store::capture_running(pool, Cause::Crash, intents, None).await {
        Ok(0) => {}
        Ok(count) => tracing::info!(count, "captured agent turns interrupted by a crash"),
        Err(error) => {
            tracing::error!(%error, "failed to capture agent turns interrupted by a crash");
            failures.push(format!(
                "Cadencr could not check which agents the last exit interrupted: {error}"
            ));
        }
    }
}

/// Every startup recovery failure, one per line: each names agents the user
/// has to check, so none may hide another.
fn startup_failure_report(failures: &[String]) -> Option<String> {
    (!failures.is_empty()).then(|| failures.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::{capture_left_behind, startup_failure_report};
    use crate::domain::restart_continuations::store::{list_pending, tests::session};
    use crate::domain::schedules::repository::test_support::fixture;

    /// Both captures of a quit that stopped its agents failed; the start
    /// after it finds the work its reader kept, and still keeps it stopped.
    #[tokio::test]
    async fn a_quit_whose_capture_failed_keeps_its_intent() {
        let (pool, _, feature_id) = fixture().await;
        let waiting = session(&pool, feature_id, "completed").await;
        super::super::record_background_work(&pool, waiting, Some(chrono::Utc::now()))
            .await
            .unwrap();
        super::super::quit_intent::record(&pool, true, false)
            .await
            .unwrap();
        let mut failures = Vec::new();

        capture_left_behind(&pool, &mut failures).await;

        assert!(failures.is_empty(), "{failures:?}");
        let pending = list_pending(&pool).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].stop_requested());
    }

    /// A real crash records no intent: it resumes.
    #[tokio::test]
    async fn a_crash_resumes_what_it_cut_off() {
        let (pool, _, feature_id) = fixture().await;
        session(&pool, feature_id, "running").await;
        let mut failures = Vec::new();

        capture_left_behind(&pool, &mut failures).await;

        assert!(!list_pending(&pool).await.unwrap()[0].stop_requested());
    }

    #[test]
    fn every_startup_failure_reaches_the_report() {
        assert_eq!(startup_failure_report(&[]), None);
        let report = startup_failure_report(&["first".into(), "second".into()]).unwrap();
        assert!(
            report.contains("first") && report.contains("second"),
            "{report}"
        );
    }
}
