//! Recording which turns a restart is about to cut off (or already did).

use crate::shared::discard::KeepFirst;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use sqlx::SqlitePool;

use super::store::{self, CaptureScope, Cause, Intent};
use crate::domain::ws_session::persistence::WsSessionPersistence;

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
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

/// Capture every turn still running, before shutdown closes their runtimes.
///
/// Runs first in the shutdown teardown: once the runtimes close, their readers
/// pause the sessions and `running` no longer says which turns were cut off.
/// A turn this misses (one that started during the drain, or all of them when
/// the write fails) is captured by its reader when shutdown ends it
/// ([`capture_cut_off_turn`]).
pub async fn begin_shutdown(pool: &SqlitePool) {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    match capture_shutdown(pool, CaptureScope::All).await {
        Ok(0) => {}
        Ok(count) => tracing::info!(count, "captured agent turns interrupted by shutdown"),
        Err(error) => {
            tracing::error!(%error, "failed to capture agent turns interrupted by shutdown")
        }
    }
}

/// Capture one turn (or background work) shutdown just cut off, unless
/// [`begin_shutdown`] already did. Called by its stream reader before it
/// pauses the session. A failed capture leaves the session running in
/// storage so that the next start can retry.
pub async fn capture_cut_off_turn(pool: &SqlitePool, session_id: i64) -> bool {
    match capture_shutdown(pool, CaptureScope::Session(session_id)).await {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(session_id, %error, "failed to capture an agent turn cut off by shutdown");
            false
        }
    }
}

pub(crate) async fn end_background_work(
    pool: &SqlitePool,
    session_id: i64,
    reader_id: &str,
    shutting_down: bool,
) -> Result<(), sqlx::Error> {
    if shutting_down {
        capture_shutdown(
            pool,
            CaptureScope::Background {
                session_id,
                reader_id,
            },
        )
        .await?;
    }
    super::background_work::write_background_work(pool, session_id, reader_id, None).await?;
    Ok(())
}

async fn capture_shutdown(pool: &SqlitePool, scope: CaptureScope<'_>) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let intents = super::quit_intent::read(&mut tx).await?;
    let count = store::capture_with_intent(
        &mut tx,
        Cause::Shutdown,
        intents,
        Some(app_version()),
        scope,
    )
    .await?;
    tx.commit().await?;
    Ok(count)
}

/// Stop the agents a killed process left running, capture the turns it left
/// `running` and the background work it was running between turns, then
/// reset them.
///
/// Must run before anything else touches session status at startup. The
/// status reset is part of the capture: when that fails, the sessions stay
/// `running` (they may look busy, which the startup report explains) so the
/// next start still captures their turns.
pub async fn recover_at_startup(
    pool: &SqlitePool,
    app_version: Option<&str>,
    stop_after_crash: bool,
) -> anyhow::Result<()> {
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
    capture_left_behind(pool, &mut failures, stop_after_crash).await?;
    if let Some(report) = startup_failure_report(&failures) {
        STARTUP_CAPTURE_ERROR.keep_first(report);
    }
    Ok(())
}

async fn capture_left_behind(
    pool: &SqlitePool,
    failures: &mut Vec<String>,
    stop_after_crash: bool,
) -> anyhow::Result<()> {
    match capture_left_behind_once_with_quit(pool, stop_after_crash).await {
        Ok(0) => {}
        Ok(count) => tracing::info!(count, "captured agent turns interrupted by a crash"),
        Err(error) if stop_after_crash => {
            // Leave the epoch claimed by the quit. Serving new work now
            // would let the next boot mistake it for work from that epoch.
            anyhow::bail!(
                "Cadencr could not save the interrupted work you asked it to stop: {error}"
            );
        }
        Err(error) => {
            tracing::error!(%error, "failed to capture agent turns interrupted by a crash");
            failures.push(format!(
                "Cadencr could not check which agents the last exit interrupted, and will try \
                 again on its next start; until then they may look busy: {error}"
            ));
        }
    }
    Ok(())
}

/// Capture what the last process left `running` or owed a resume for. A quit
/// whose own capture failed left its intent behind: those turns follow it.
/// Anything else (a crash, a kill, an update) resumes.
///
/// The intent and the background-work records are consumed, and the sessions
/// left `running` paused, in the capture's transaction: when it fails, all of
/// it stays for the next start to retry, and no turn or work is lost.
#[cfg(test)]
async fn capture_left_behind_once(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
    capture_left_behind_once_with_quit(pool, false).await
}

pub(super) async fn capture_left_behind_once_with_quit(
    pool: &SqlitePool,
    stop_after_crash: bool,
) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let previous_intent = super::quit_intent::take(&mut tx).await?;
    let intents = if stop_after_crash {
        Intent::Stop.into()
    } else {
        previous_intent.unwrap_or(Intent::Resume.into())
    };
    super::user_stop::reconcile(&mut tx).await?;
    let count =
        store::capture_with_intent(&mut tx, Cause::Crash, intents, None, CaptureScope::All).await?;
    super::background_work::clear(&mut tx).await?;
    WsSessionPersistence::cleanup_stale_sessions(&mut *tx).await?;
    tx.commit().await?;
    Ok(count)
}

/// Every startup recovery failure, one per line: each names agents the user
/// has to check, so none may hide another.
fn startup_failure_report(failures: &[String]) -> Option<String> {
    (!failures.is_empty()).then(|| failures.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::CaptureScope;
    use super::{
        capture_left_behind, capture_left_behind_once, capture_shutdown, startup_failure_report,
    };
    use crate::domain::restart_continuations::store::{list_pending, tests::session};
    use crate::domain::schedules::repository::test_support::fixture;

    #[tokio::test]
    async fn crash_between_a_durable_stop_and_its_marker_settles_it_once() {
        let (pool, _, feature_id) = fixture().await;
        let stopped = session(&pool, feature_id, "running").await;
        super::super::record_background_work(&pool, stopped, Some(chrono::Utc::now()))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_messages (session_id, role, content, message_type, tool_use_id)
             VALUES (?, 'assistant', '{}', 'tool_call', 'open-tool')",
        )
        .bind(stopped)
        .execute(&pool)
        .await
        .unwrap();

        // Crash checkpoint: Stop was committed, but its reader neither
        // ended the turn nor appended the marker.
        super::super::record_user_stop(&pool, stopped, chrono::Utc::now())
            .await
            .unwrap();
        assert_eq!(
            messages(&pool, stopped).await,
            [("tool_call".into(), "{}".into())]
        );
        for _ in 0..2 {
            assert_eq!(capture_left_behind_once(&pool).await.unwrap(), 0);
        }
        assert!(list_pending(&pool).await.unwrap().is_empty());
        assert_eq!(
            messages(&pool, stopped).await,
            [
                ("tool_call".into(), "{}".into()),
                ("tool_error".into(), "Stopped by the user.".into()),
                ("turn_interrupted".into(), "".into()),
            ]
        );
        assert_eq!(
            super::store::session_status(&pool, stopped).await.unwrap(),
            "paused"
        );
    }

    #[tokio::test]
    async fn a_live_stop_marker_is_not_repeated_by_startup() {
        let (pool, _, feature_id) = fixture().await;
        let stopped = session(&pool, feature_id, "running").await;
        super::super::record_user_stop(&pool, stopped, chrono::Utc::now())
            .await
            .unwrap();
        super::super::write_stop_marker(&pool, stopped)
            .await
            .unwrap();
        capture_left_behind_once(&pool).await.unwrap();

        assert_eq!(
            messages(&pool, stopped).await,
            [("turn_interrupted".into(), "".into())]
        );
        assert!(list_pending(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn legacy_stop_recovery_repairs_only_the_missing_marker() {
        let (pool, _, feature) = fixture().await;
        let missing = session(&pool, feature, "running").await;
        let marked = session(&pool, feature, "running").await;
        sqlx::query(
            "INSERT INTO agent_user_stops (session_id, stopped_at) VALUES (?, '2026-11-25'), (?, '2026-11-25')",
        ).bind(missing).bind(marked).execute(&pool).await.unwrap();
        super::super::transcript::insert_marker(&mut pool.acquire().await.unwrap(), marked, "")
            .await
            .unwrap();

        for _ in 0..2 {
            capture_left_behind_once(&pool).await.unwrap();
        }
        for session_id in [missing, marked] {
            assert_eq!(
                messages(&pool, session_id).await,
                [("turn_interrupted".into(), "".into())]
            );
        }
    }

    #[tokio::test]
    async fn a_confirmed_quit_vetoes_pending_resumes_and_captures_both_kinds_as_stopped() {
        let (pool, _, feature_id) = fixture().await;
        let earlier = session(&pool, feature_id, "running").await;
        super::store::capture_running(&pool, super::Cause::Crash, super::Intent::Resume, None)
            .await
            .unwrap();
        let active = session(&pool, feature_id, "running").await;
        let background = session(&pool, feature_id, "completed").await;
        super::super::record_background_work(&pool, background, Some(chrono::Utc::now()))
            .await
            .unwrap();

        // Crash-safe checkpoint: Electron waits for this write before it can
        // close the sidecar. Every later capture must run with this intent.
        super::super::quit_intent::record(&pool, false, false)
            .await
            .unwrap();
        assert_eq!(capture_shutdown(&pool, CaptureScope::All).await.unwrap(), 2);
        assert_eq!(capture_left_behind_once(&pool).await.unwrap(), 0);

        let pending = list_pending(&pool).await.unwrap();
        assert_eq!(
            pending.iter().map(|row| row.session_id).collect::<Vec<_>>(),
            [earlier, active, background]
        );
        assert!(pending.iter().all(|row| row.stop_requested()));
        assert!(pending[2].background_work());
    }

    async fn messages(pool: &sqlx::SqlitePool, session_id: i64) -> Vec<(String, String)> {
        sqlx::query_as(
            "SELECT message_type, content FROM agent_messages WHERE session_id = ? ORDER BY id",
        )
        .bind(session_id)
        .fetch_all(pool)
        .await
        .unwrap()
    }

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

        capture_left_behind(&pool, &mut failures, false)
            .await
            .unwrap();

        assert!(failures.is_empty(), "{failures:?}");
        let pending = list_pending(&pool).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].stop_requested());
    }

    /// A capture that fails at startup consumes nothing: the next start
    /// still finds the quit's intent and the work it was owed.
    #[tokio::test]
    async fn a_failed_startup_capture_leaves_everything_for_the_next_start() {
        let (pool, _, feature_id) = fixture().await;
        let waiting = session(&pool, feature_id, "completed").await;
        let mid_turn = session(&pool, feature_id, "running").await;
        super::super::record_background_work(&pool, waiting, Some(chrono::Utc::now()))
            .await
            .unwrap();
        super::super::quit_intent::record(&pool, true, false)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE restart_continuations RENAME TO unavailable")
            .execute(&pool)
            .await
            .unwrap();
        let mut failures = Vec::new();

        capture_left_behind(&pool, &mut failures, false)
            .await
            .unwrap();

        assert_eq!(failures.len(), 1, "the failure is reported");
        let left: (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM restart_quit_intent),
                    (SELECT COUNT(*) FROM agent_background_work)",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(left, (1, 1));
        let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(mid_turn)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "running", "the next start still captures its turn");
    }

    /// A capture that goes through pauses what it captured.
    #[tokio::test]
    async fn a_startup_capture_pauses_the_turns_it_captured() {
        let (pool, _, feature_id) = fixture().await;
        let mid_turn = session(&pool, feature_id, "running").await;
        let mut failures = Vec::new();

        capture_left_behind(&pool, &mut failures, false)
            .await
            .unwrap();

        assert!(failures.is_empty(), "{failures:?}");
        let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = ?")
            .bind(mid_turn)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "paused");
        assert_eq!(list_pending(&pool).await.unwrap().len(), 1);
    }

    /// A real crash records no intent: it resumes.
    #[tokio::test]
    async fn a_crash_resumes_what_it_cut_off() {
        let (pool, _, feature_id) = fixture().await;
        session(&pool, feature_id, "running").await;
        let mut failures = Vec::new();

        capture_left_behind(&pool, &mut failures, false)
            .await
            .unwrap();

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
