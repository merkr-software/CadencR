//! Runs an archive and its cleanup for whoever asked (the Archive dialog on
//! any device, an agent's `project_archive_session`).
//!
//! The steps run in a task of their own, not in the request: a client that
//! reloads, closes or loses its connection mid-cleanup drops only its wait
//! for the report, never the cleanup. One run per conversation at a time
//! (`AppState::archive_cleanup_runs`); unarchiving cancels it.

use std::time::Duration;

use super::journal::{self, PlannedStep};
use super::steps;
use super::{CleanupReport, StepName, StepOutcome, StepStatus};
use crate::app_state::AppState;
use crate::domain::feature_events::{ArchiveCleanupEvent, FeatureEventAction};
use crate::domain::features::archive::{archive_in, Archiver};
use crate::domain::features::models::ArchiveRequest;
use crate::domain::features::run_registry::FeatureRunPermit;
use crate::error::AppError;

const WAITING_FOR_WORKTREE: &str = "waiting for the worktree removal";
/// How long unarchiving waits for a step in progress to finish.
const CANCEL_TIMEOUT: Duration = Duration::from_millis(if cfg!(test) { 100 } else { 30_000 });
const BRIDGE_ATTEMPTS: u32 = 5;
const BRIDGE_RETRY_DELAY: Duration = Duration::from_millis(if cfg!(test) { 20 } else { 2_000 });

pub struct ArchiveOutcome {
    pub archived_ids: Vec<i64>,
    pub cleanup: CleanupReport,
}

/// Archive `feature_id` (and the relatives `request` asks for), then run the
/// cleanup it asks for on `feature_id`. The archive and the cleanup plan
/// commit together; each step's outcome is journaled as it settles.
pub async fn archive_with_cleanup(
    state: &AppState,
    feature_id: i64,
    request: &ArchiveRequest,
    archiver: Archiver,
) -> Result<ArchiveOutcome, AppError> {
    let permit = acquire(state, feature_id)?;
    let project_id = project_of(state, feature_id).await?;
    let planned = journal::steps_for(&request.cleanup());
    let mut tx = state.write_pool.begin().await?;
    let archived_ids = archive_in(&mut tx, feature_id, request, archiver).await?;
    journal::plan(&mut tx, feature_id, &planned).await?;
    tx.commit().await?;

    state.plugin_tab_presence.release_features(&archived_ids);
    // Archived conversations stop their worktree setup; removing the
    // worktree cancels it again, which is a no-op by then.
    crate::domain::workflow::worktree::cancel_setups(&state.worktree_setup_runs, &archived_ids)
        .await;
    for archived_id in &archived_ids {
        state
            .feature_events_tx
            .emit(*archived_id, None, FeatureEventAction::Updated);
    }
    emit(
        state,
        project_id,
        feature_id,
        archived_ids.clone(),
        journal::report(&planned),
    );
    let cleanup = spawn_run(state, project_id, feature_id, permit, None).await?;
    Ok(ArchiveOutcome {
        archived_ids,
        cleanup,
    })
}

/// What the user confirmed forcing when resuming.
#[derive(Debug, Default, Clone, Copy)]
pub struct ResumeForce {
    pub worktree: bool,
    pub branch: bool,
}

/// Run again every step that is not done or skipped — interrupted, failed,
/// blocked or still pending — forcing the ones the user confirmed.
pub async fn resume(
    state: &AppState,
    feature_id: i64,
    force: ResumeForce,
) -> Result<CleanupReport, AppError> {
    let permit = acquire(state, feature_id)?;
    let project_id = archived_project_of(state, feature_id).await?;
    if journal::load(&state.write_pool, feature_id)
        .await?
        .is_empty()
    {
        return Err(AppError::NotFound(
            "This session has no archive cleanup".into(),
        ));
    }
    for (forced, step) in [
        (force.worktree, StepName::Worktree),
        (force.branch, StepName::Branch),
    ] {
        if forced {
            journal::set_force(&state.write_pool, feature_id, step).await?;
        }
    }
    spawn_run(state, project_id, feature_id, permit, None).await
}

/// The cleanup as clients should see it: a pending or running step that no
/// run owns any more (its task died) is reported as interrupted.
pub async fn current_report(state: &AppState, feature_id: i64) -> Result<CleanupReport, AppError> {
    let mut planned = journal::load(&state.read_pool, feature_id).await?;
    if !state.archive_cleanup_runs.is_owned(feature_id) {
        for step in &mut planned {
            let orphaned = step.outcome.status == StepStatus::Running
                || (step.outcome.status == StepStatus::Pending && step.outcome.reason.is_none());
            if orphaned {
                step.outcome.status = StepStatus::Interrupted;
            }
        }
    }
    Ok(journal::report(&planned))
}

pub fn is_running(state: &AppState, feature_id: i64) -> bool {
    state.archive_cleanup_runs.is_owned(feature_id)
}

/// Unarchiving abandons the cleanup: stop the run between two steps, then
/// forget the plan so nothing removes the worktree of a conversation in use.
/// Keep the returned permit until the active status is saved: no cleanup may
/// acquire the conversation between cancellation and reactivation.
pub async fn abandon(state: &AppState, feature_id: i64) -> Result<FeatureRunPermit, AppError> {
    state
        .archive_cleanup_runs
        .cancel_and_wait(feature_id, CANCEL_TIMEOUT)
        .await;
    let permit = acquire(state, feature_id).map_err(|_| {
        AppError::Conflict(
            "Archive cleanup has not stopped yet; wait for it to finish before unarchiving".into(),
        )
    })?;
    journal::clear(&state.write_pool, feature_id).await?;
    if let Ok(project_id) = project_of(state, feature_id).await {
        emit(
            state,
            project_id,
            feature_id,
            Vec::new(),
            CleanupReport::default(),
        );
    }
    Ok(permit)
}

/// Before serving: no cleanup runs yet, so a step the last exit left pending
/// or running was cut short. A packaged desktop hands its Browser bridge over
/// in the environment, so no registration will announce it: close the tabs
/// that waited for it now.
pub async fn recover_at_startup(state: &AppState) -> Result<(), AppError> {
    let interrupted = journal::interrupt_unsettled(&state.write_pool).await?;
    if interrupted > 0 {
        tracing::info!(
            interrupted,
            "archive cleanup steps cut short by the last exit"
        );
    }
    if matches!(state.browser_bridge_config(), Ok(Some(_))) {
        resume_browser_steps(state);
    }
    Ok(())
}

/// Close the tabs of archived conversations whose browser step waited for a
/// desktop app (or was cut short): called when one registers its bridge, and
/// at startup when the bridge came with the environment. Closing tabs of an
/// archived conversation loses nothing, so it needs no one to confirm it;
/// git steps cut short wait for the user to resume them.
pub fn resume_browser_steps(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        let feature_ids = match journal::browser_steps_to_resume(&state.read_pool).await {
            Ok(ids) => ids,
            Err(error) => {
                tracing::warn!(%error, "could not list archived browser tabs to close");
                return;
            }
        };
        for feature_id in feature_ids {
            if let Err(error) = close_tabs_once_ready(&state, feature_id).await {
                tracing::warn!(%error, feature_id, "closing archived browser tabs failed");
            }
        }
    });
}

/// A desktop registers its bridge a moment before its browser can take calls
/// ("Browser manager is not ready"): retry a failed close a few times.
async fn close_tabs_once_ready(state: &AppState, feature_id: i64) -> Result<(), AppError> {
    let project_id = project_of(state, feature_id).await?;
    for attempt in 1..=BRIDGE_ATTEMPTS {
        // A run in progress reaches the browser step itself.
        let Some(permit) = state.archive_cleanup_runs.try_acquire(feature_id) else {
            return Ok(());
        };
        let only = Some(StepName::BrowserTabs);
        let report = run(state, project_id, feature_id, permit, only).await?;
        let failed = report
            .browser_tabs
            .is_some_and(|step| step.status == StepStatus::Failed);
        if !failed || attempt == BRIDGE_ATTEMPTS {
            return Ok(());
        }
        tokio::time::sleep(BRIDGE_RETRY_DELAY).await;
    }
    Ok(())
}

fn acquire(state: &AppState, feature_id: i64) -> Result<FeatureRunPermit, AppError> {
    state
        .archive_cleanup_runs
        .try_acquire(feature_id)
        .ok_or_else(|| {
            AppError::Conflict("This session's archive cleanup is already running".into())
        })
}

async fn spawn_run(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
    permit: FeatureRunPermit,
    only: Option<StepName>,
) -> Result<CleanupReport, AppError> {
    let state = state.clone();
    tokio::spawn(async move { run(&state, project_id, feature_id, permit, only).await })
        .await
        .map_err(|error| AppError::internal(format!("The archive cleanup stopped: {error}")))?
}

/// Run the unsettled steps in order, journaling and broadcasting each
/// transition. Stops between steps once the conversation is unarchived.
async fn run(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
    permit: FeatureRunPermit,
    only: Option<StepName>,
) -> Result<CleanupReport, AppError> {
    let cancelled = permit.cancellation();
    let mut planned = journal::load(&state.write_pool, feature_id).await?;
    for index in 0..planned.len() {
        let step = planned[index].step;
        if planned[index].outcome.status.is_settled() || only.is_some_and(|only| only != step) {
            continue;
        }
        if cancelled.is_cancelled() || !is_archived(state, feature_id).await? {
            break;
        }
        let outcome = if step == StepName::Branch && worktree_unsettled(&planned) {
            StepOutcome::pending(Some(WAITING_FOR_WORKTREE.into()))
        } else {
            settle(
                state,
                project_id,
                feature_id,
                &mut planned,
                index,
                StepOutcome::running(),
            )
            .await?;
            steps::run(state, project_id, feature_id, step, planned[index].force).await
        };
        settle(state, project_id, feature_id, &mut planned, index, outcome).await?;
    }
    drop(permit);
    Ok(journal::report(&planned))
}

async fn settle(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
    planned: &mut [PlannedStep],
    index: usize,
    outcome: StepOutcome,
) -> Result<(), AppError> {
    journal::record(&state.write_pool, feature_id, planned[index].step, &outcome).await?;
    planned[index].outcome = outcome;
    emit(
        state,
        project_id,
        feature_id,
        Vec::new(),
        journal::report(planned),
    );
    Ok(())
}

/// git refuses to delete a branch still checked out in its worktree.
fn worktree_unsettled(planned: &[PlannedStep]) -> bool {
    planned
        .iter()
        .any(|step| step.step == StepName::Worktree && !step.outcome.status.is_settled())
}

fn emit(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
    archived_feature_ids: Vec<i64>,
    cleanup: CleanupReport,
) {
    state
        .feature_events_tx
        .emit_archive_cleanup(ArchiveCleanupEvent {
            project_id,
            feature_id,
            archived_feature_ids,
            cleanup,
        });
}

async fn project_of(state: &AppState, feature_id: i64) -> Result<i64, AppError> {
    sqlx::query_scalar("SELECT project_id FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_optional(&state.write_pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Feature {feature_id} not found")))
}

async fn is_archived(state: &AppState, feature_id: i64) -> Result<bool, AppError> {
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_optional(&state.write_pool)
        .await?;
    Ok(status.as_deref() == Some("archived"))
}

async fn archived_project_of(state: &AppState, feature_id: i64) -> Result<i64, AppError> {
    let project_id = project_of(state, feature_id).await?;
    if !is_archived(state, feature_id).await? {
        return Err(AppError::Conflict(
            "This session is no longer archived; its cleanup was abandoned".into(),
        ));
    }
    Ok(project_id)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{json, Value};
    use sqlx::SqlitePool;

    use super::*;

    async fn git(dir: &Path, args: &[&str]) {
        let status = tokio::process::Command::new("git")
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .status()
            .await
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    /// A repo on `main` with a worktree on `feat` holding one unmerged commit
    /// and an untracked file, recorded as the conversation's worktree.
    struct Fixture {
        state: AppState,
        feature_id: i64,
        worktree: std::path::PathBuf,
        _dir: tempfile::TempDir,
    }

    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]).await;
        git(&repo, &["config", "user.email", "t@example.com"]).await;
        git(&repo, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        git(&repo, &["add", "."]).await;
        git(&repo, &["commit", "-qm", "init"]).await;
        let worktree = dir.path().join("wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat",
                worktree.to_str().unwrap(),
            ],
        )
        .await;
        std::fs::write(worktree.join("b.txt"), "b").unwrap();
        git(&worktree, &["add", "."]).await;
        git(&worktree, &["commit", "-qm", "feat"]).await;
        std::fs::write(worktree.join("scratch.txt"), "dirty").unwrap();

        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        let project_id: i64 =
            sqlx::query_scalar("INSERT INTO projects (name, path) VALUES ('p', ?) RETURNING id")
                .bind(repo.to_str().unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        let feature_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, 'Feat') RETURNING id",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        for (key, value) in [
            ("worktree_path", worktree.to_str().unwrap()),
            ("worktree_branch", "feat"),
        ] {
            sqlx::query("INSERT INTO feature_settings (feature_id, key, value) VALUES (?, ?, ?)")
                .bind(feature_id)
                .bind(key)
                .bind(value)
                .execute(&pool)
                .await
                .unwrap();
        }
        Fixture {
            state: AppState::with_pool(pool),
            feature_id,
            worktree,
            _dir: dir,
        }
    }

    fn status_of(report: &CleanupReport, step: StepName) -> Option<StepStatus> {
        report.get(step).map(|outcome| outcome.status)
    }

    fn remove_both() -> ArchiveRequest {
        ArchiveRequest {
            remove_worktree: true,
            remove_branch: true,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn blocked_steps_wait_for_explicit_force_and_the_branch_waits_for_its_worktree() {
        let fx = fixture().await;
        let mut events = fx.state.feature_events_tx.subscribe_archive_cleanup();

        let outcome =
            archive_with_cleanup(&fx.state, fx.feature_id, &remove_both(), Archiver::User)
                .await
                .unwrap();

        assert_eq!(outcome.archived_ids, [fx.feature_id]);
        let worktree = outcome.cleanup.worktree.clone().unwrap();
        assert_eq!(worktree.status, StepStatus::Blocked);
        assert_eq!(worktree.reason.as_deref(), Some("dirty_worktree"));
        let branch = outcome.cleanup.branch.clone().unwrap();
        assert_eq!(branch.status, StepStatus::Pending);
        assert_eq!(branch.reason.as_deref(), Some(WAITING_FOR_WORKTREE));
        assert!(fx.worktree.exists());
        let first = events.try_recv().unwrap();
        assert_eq!(first.archived_feature_ids, [fx.feature_id]);
        assert_eq!(
            status_of(&first.cleanup, StepName::Worktree),
            Some(StepStatus::Pending)
        );

        let force_worktree = ResumeForce {
            worktree: true,
            ..Default::default()
        };
        let report = resume(&fx.state, fx.feature_id, force_worktree)
            .await
            .unwrap();
        assert_eq!(
            status_of(&report, StepName::Worktree),
            Some(StepStatus::Done)
        );
        let branch = report.branch.clone().unwrap();
        assert_eq!(branch.status, StepStatus::Blocked);
        assert_eq!(branch.reason.as_deref(), Some("unmerged_branch"));
        assert!(!fx.worktree.exists());

        let force_branch = ResumeForce {
            branch: true,
            ..Default::default()
        };
        let report = resume(&fx.state, fx.feature_id, force_branch)
            .await
            .unwrap();
        assert!(report.is_settled(), "{report:?}");
        assert!(journal::unsettled_feature_ids(&fx.state.read_pool)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_cleanup_cut_short_reads_as_interrupted_and_resumes_where_it_stopped() {
        let fx = fixture().await;
        std::fs::remove_file(fx.worktree.join("scratch.txt")).unwrap();
        // What a crash right after the archive commit leaves behind.
        let request = ArchiveRequest {
            kill_terminals: true,
            remove_worktree: true,
            ..Default::default()
        };
        let mut tx = fx.state.write_pool.begin().await.unwrap();
        archive_in(&mut tx, fx.feature_id, &request, Archiver::User)
            .await
            .unwrap();
        journal::plan(
            &mut tx,
            fx.feature_id,
            &journal::steps_for(&request.cleanup()),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        journal::record(
            &fx.state.write_pool,
            fx.feature_id,
            StepName::Terminals,
            &StepOutcome::done(None),
        )
        .await
        .unwrap();
        journal::record(
            &fx.state.write_pool,
            fx.feature_id,
            StepName::Worktree,
            &StepOutcome::running(),
        )
        .await
        .unwrap();

        // Before the restart's pass, no run owns it: it already reads interrupted.
        let report = current_report(&fx.state, fx.feature_id).await.unwrap();
        assert_eq!(
            status_of(&report, StepName::Worktree),
            Some(StepStatus::Interrupted)
        );
        assert_eq!(
            journal::interrupt_unsettled(&fx.state.write_pool)
                .await
                .unwrap(),
            1
        );

        let report = resume(&fx.state, fx.feature_id, ResumeForce::default())
            .await
            .unwrap();
        assert_eq!(
            status_of(&report, StepName::Terminals),
            Some(StepStatus::Done)
        );
        assert_eq!(
            status_of(&report, StepName::Worktree),
            Some(StepStatus::Done)
        );
        assert!(!fx.worktree.exists());
        // Idempotent: resuming a settled cleanup changes nothing.
        let again = resume(&fx.state, fx.feature_id, ResumeForce::default())
            .await
            .unwrap();
        assert_eq!(again, report);
    }

    #[tokio::test]
    async fn unarchive_timeout_preserves_archived_status_and_cleanup_plan() {
        use crate::domain::features::models::{FeatureStatus, UpdateStatusRequest};
        use crate::domain::features::routes::update_feature_status_handler;
        use axum::extract::{Json, Path, State};

        let fx = fixture().await;
        archive_with_cleanup(&fx.state, fx.feature_id, &remove_both(), Archiver::User)
            .await
            .unwrap();
        let planned = journal::load(&fx.state.write_pool, fx.feature_id)
            .await
            .unwrap();
        assert!(!planned.is_empty());
        // Represents a destructive Git operation that has not released its slot.
        let stuck = fx
            .state
            .archive_cleanup_runs
            .try_acquire(fx.feature_id)
            .unwrap();
        let result = update_feature_status_handler(
            State(fx.state.clone()),
            Path(fx.feature_id),
            Json(UpdateStatusRequest {
                status: FeatureStatus::Active,
            }),
        )
        .await;
        assert!(matches!(result, Err(AppError::Conflict(_))));
        assert!(stuck.cancellation().is_cancelled());
        assert!(is_archived(&fx.state, fx.feature_id).await.unwrap());
        assert_eq!(
            journal::load(&fx.state.write_pool, fx.feature_id)
                .await
                .unwrap()
                .len(),
            planned.len()
        );
        assert!(fx.worktree.exists());
    }

    #[tokio::test]
    async fn unarchive_guard_excludes_cleanup_until_reactivation() {
        let fx = fixture().await;
        archive_with_cleanup(&fx.state, fx.feature_id, &remove_both(), Archiver::User)
            .await
            .unwrap();
        let guard = abandon(&fx.state, fx.feature_id).await.unwrap();
        assert!(fx
            .state
            .archive_cleanup_runs
            .try_acquire(fx.feature_id)
            .is_none());
        assert!(matches!(
            resume(&fx.state, fx.feature_id, ResumeForce::default()).await,
            Err(AppError::Conflict(_))
        ));
        sqlx::query("UPDATE features SET status = 'active' WHERE id = ?")
            .bind(fx.feature_id)
            .execute(&fx.state.write_pool)
            .await
            .unwrap();
        drop(guard);
        assert!(matches!(
            resume(&fx.state, fx.feature_id, ResumeForce::default()).await,
            Err(AppError::Conflict(_))
        ));
        assert!(fx.worktree.exists());
    }

    #[tokio::test]
    async fn unarchiving_abandons_the_cleanup_and_keeps_the_worktree() {
        let fx = fixture().await;
        archive_with_cleanup(&fx.state, fx.feature_id, &remove_both(), Archiver::User)
            .await
            .unwrap();
        sqlx::query("UPDATE features SET status = 'active' WHERE id = ?")
            .bind(fx.feature_id)
            .execute(&fx.state.write_pool)
            .await
            .unwrap();
        abandon(&fx.state, fx.feature_id).await.unwrap();

        assert!(journal::load(&fx.state.read_pool, fx.feature_id)
            .await
            .unwrap()
            .is_empty());
        let forced = ResumeForce {
            worktree: true,
            branch: true,
        };
        assert!(matches!(
            resume(&fx.state, fx.feature_id, forced).await,
            Err(AppError::Conflict(_))
        ));
        assert!(fx.worktree.exists());
    }

    #[tokio::test]
    async fn tabs_left_open_without_a_desktop_close_once_one_registers() {
        use axum::{routing::post, Router};
        let fx = fixture().await;
        let request = ArchiveRequest {
            close_browser_tabs: true,
            ..Default::default()
        };
        let outcome = archive_with_cleanup(&fx.state, fx.feature_id, &request, Archiver::User)
            .await
            .unwrap();
        assert_eq!(
            status_of(&outcome.cleanup, StepName::BrowserTabs),
            Some(StepStatus::Pending)
        );

        // Like a desktop that registers before its browser is ready.
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        let app = Router::new().route(
            "/browser-bridge",
            post(move |axum::Json(body): axum::Json<Value>| {
                let seen = seen.clone();
                async move {
                    assert_eq!(body["tool_name"], "browser_close_scope_tabs");
                    if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        return Err((
                            axum::http::StatusCode::BAD_REQUEST,
                            "Browser manager is not ready.",
                        ));
                    }
                    Ok(axum::Json(json!({ "text": "{\"closed_tabs\":3}" })))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/browser-bridge", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        fx.state
            .set_browser_bridge(crate::app_state::BrowserBridgeConfig::from_raw(&url, "t").unwrap())
            .unwrap();
        let mut events = fx.state.feature_events_tx.subscribe_archive_cleanup();
        resume_browser_steps(&fx.state);

        let done = loop {
            let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .unwrap()
                .unwrap();
            let step = event.cleanup.browser_tabs.clone().unwrap();
            if step.status == StepStatus::Done {
                break step;
            }
        };
        assert_eq!(done.detail.as_deref(), Some("closed 3 tab(s)"));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert!(journal::unsettled_feature_ids(&fx.state.read_pool)
            .await
            .unwrap()
            .is_empty());
    }
}
