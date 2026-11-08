//! Native backends (`docs/CUSTOM_TABS.md` §4.7): the process a tab declares in
//! `tab.json` `backend`, started by Cadencr when the tab first calls
//! `backend.request`.
//!
//! One backend runs per tab and conversation, shared by that conversation's
//! open instances of the tab. It runs with the user's rights — Cadencr does
//! not sandbox it — but it never receives the main token: its first stdin line
//! carries its own grant, with the tab's consented scopes, bound to the
//! conversation. It is stopped once no instance holds a presence lease
//! ([`reap_orphans`], however long the tab stays open before that), when its
//! grant is revoked (permissions changed, tab turned off), when Cadencr's
//! revocation policy blocks its tab, or from the tab's Activity dialog.

mod ending;
mod first_start;
mod handshake;
mod history;
mod launch;
mod lines;
pub mod models;
mod process;
mod protocol;
mod request;
mod stop_reason;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use tokio::sync::Mutex;

use self::history::{History, LiveRun};
pub use self::launch::{unavailable_on_platform, BackendLaunch};
use self::models::{PluginBackendRequest, PluginBackendResponse, PluginTabBackendStatus};
use self::process::{Prepared, Running};
use self::request::check_request;
pub use self::request::RunningBackend;
pub use self::stop_reason::StopReason;
use super::grants::GrantStore;
use super::presence::PresenceStore;
use crate::error::AppError;

/// How long a backend survives with no open instance of its tab: covers a
/// tab moved between panes, which releases its lease and takes a new one.
const ORPHAN_GRACE: Duration = Duration::from_secs(30);
const REAP_INTERVAL: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    plugin_id: String,
    feature_id: i64,
}

impl Key {
    fn new(plugin_id: &str, feature_id: i64) -> Self {
        Self {
            plugin_id: plugin_id.to_string(),
            feature_id,
        }
    }

    fn of(launch: &BackendLaunch) -> Self {
        Self::new(&launch.plugin_id, launch.feature_id)
    }
}

#[derive(Default)]
struct Slot {
    running: Option<Arc<Running>>,
    history: Arc<History>,
    orphaned_since: Option<Instant>,
    /// Held across one start, so concurrent requests start one process.
    starting: Arc<Mutex<()>>,
    /// Bumped by every stop of this tab: a start begun before it spawns nothing.
    stops: u64,
}

/// What [`BackendSupervisor::reuse`] found.
enum Reuse {
    Running(Arc<Running>),
    Start {
        history: Arc<History>,
        starting: Arc<Mutex<()>>,
        stops: u64,
    },
}

/// 503 `PLUGIN_BACKEND_UNAVAILABLE` once [`BackendSupervisor::shutdown`] ran.
fn quitting() -> AppError {
    AppError::coded(
        StatusCode::SERVICE_UNAVAILABLE,
        "PLUGIN_BACKEND_UNAVAILABLE",
        "Cadencr is quitting",
    )
}

/// `error`, also shown in the Activity's log as a refused start.
fn failed_start(history: &History, error: AppError) -> AppError {
    history.record_failed_start(&error);
    error
}

impl Slot {
    /// The process, while it has not exited (it may be stopping).
    fn live(&self) -> Option<&Arc<Running>> {
        self.running.as_ref().filter(|running| running.is_live())
    }

    /// The process new requests may use.
    fn usable(&self) -> Option<&Arc<Running>> {
        self.running.as_ref().filter(|running| running.is_usable())
    }
}

#[derive(Default)]
struct Slots {
    by_key: HashMap<Key, Slot>,
    /// Set by [`BackendSupervisor::shutdown`]: nothing starts after it.
    closed: bool,
}

/// Every tab backend of this process. Cheap to clone.
#[derive(Clone, Default)]
pub struct BackendSupervisor {
    slots: Arc<Mutex<Slots>>,
}

impl BackendSupervisor {
    /// Relay `request` to `launch`'s backend, starting it first if needed.
    pub async fn request(
        &self,
        grants: &GrantStore,
        launch: BackendLaunch,
        request: PluginBackendRequest,
    ) -> Result<PluginBackendResponse, AppError> {
        let budget = check_request(&request)?;
        // The start counts against the request's budget. The process holds
        // its own revision lease; `launch` goes with the start task.
        let (this, grants) = (self.clone(), grants.clone());
        let start = async move { this.ensure_running(&grants, &launch).await };
        let running = budget.wait_detached(&request.method, start).await?;
        running.call(&request.method, request.params, budget).await
    }

    /// The usable backend of `plugin_id` in `feature_id` when it runs under
    /// `permissions_hash`; `None` otherwise, and once Cadencr is quitting.
    /// What else it must still match is the caller's to check (see
    /// `runtime_routes::reusable_backend`); [`Self::request`] checks it all.
    pub async fn running(
        &self,
        plugin_id: &str,
        feature_id: i64,
        permissions_hash: &str,
    ) -> Option<RunningBackend> {
        let slots = self.slots.lock().await;
        if slots.closed {
            return None;
        }
        let running = slots
            .by_key
            .get(&Key::new(plugin_id, feature_id))?
            .usable()?;
        (running.permissions_hash == permissions_hash).then(|| RunningBackend::new(running.clone()))
    }

    /// The usable backend of `launch`, started first when there is none.
    /// Starts of one tab in one conversation are serialized by its slot; the
    /// checks before a start (the binary hashed against its signed digest)
    /// run off the slots lock, so they hold up no other tab. The process is
    /// spawned and registered under that lock, and only if the tab was not
    /// stopped meanwhile, so a stop or removal never misses it.
    async fn ensure_running(
        &self,
        grants: &GrantStore,
        launch: &BackendLaunch,
    ) -> Result<Arc<Running>, AppError> {
        let starting = match self.reuse(launch).await? {
            Reuse::Running(running) => return Ok(running),
            Reuse::Start { starting, .. } => starting,
        };
        let _starting = starting.lock().await;
        // Another request may have started it while this one waited.
        let (history, stops) = match self.reuse(launch).await? {
            Reuse::Running(running) => return Ok(running),
            Reuse::Start { history, stops, .. } => (history, stops),
        };
        history.check_may_start()?;
        let prepared = match launch.prepare().await {
            Ok(prepared) => prepared,
            Err(error) => return Err(failed_start(&history, error)),
        };
        self.spawn_unless_stopped(grants, launch, prepared, &history, stops)
            .await
    }

    /// Spawn `prepared` and register it, unless `launch`'s tab was stopped
    /// (its slot's `stops` moved past `stops`) since the start began.
    async fn spawn_unless_stopped(
        &self,
        grants: &GrantStore,
        launch: &BackendLaunch,
        prepared: Prepared,
        history: &Arc<History>,
        stops: u64,
    ) -> Result<Arc<Running>, AppError> {
        let mut slots = self.slots.lock().await;
        if slots.closed {
            return Err(quitting());
        }
        let slot = slots.by_key.entry(Key::of(launch)).or_default();
        if slot.stops != stops {
            return Err(process::exited_error("it was stopped while starting"));
        }
        let running = process::spawn(launch, prepared, grants, history.clone())
            .map_err(|error| failed_start(history, error))?;
        slot.running = Some(running.clone());
        slot.orphaned_since = None;
        Ok(running)
    }

    /// The slot's usable backend when it still matches `launch` (one that
    /// does not is asked to stop), else what starting a new one takes.
    async fn reuse(&self, launch: &BackendLaunch) -> Result<Reuse, AppError> {
        let mut slots = self.slots.lock().await;
        if slots.closed {
            return Err(quitting());
        }
        let slot = slots.by_key.entry(Key::of(launch)).or_default();
        if let Some(running) = slot.usable() {
            if running.permissions_hash != launch.permissions_hash {
                running.request_stop(StopReason::PermissionsChanged);
            } else if running.plugin_dir != launch.plugin_dir {
                running.request_stop(StopReason::TabUpdated);
            } else {
                return Ok(Reuse::Running(running.clone()));
            }
        }
        Ok(Reuse::Start {
            history: slot.history.clone(),
            starting: slot.starting.clone(),
            stops: slot.stops,
        })
    }

    /// The backend of `plugin_id` in `feature_id`; `None` if it never started.
    pub async fn status(&self, plugin_id: &str, feature_id: i64) -> Option<PluginTabBackendStatus> {
        let slots = self.slots.lock().await;
        let slot = slots.by_key.get(&Key::new(plugin_id, feature_id))?;
        let live = slot.live().map(|running| LiveRun {
            pid: running.pid,
            starting: running.is_starting(),
        });
        Some(slot.history.status(live))
    }

    /// Stop it, and forget recent crashes so the next request starts afresh.
    pub async fn stop(&self, plugin_id: &str, feature_id: i64) {
        let mut slots = self.slots.lock().await;
        let Some(slot) = slots.by_key.get_mut(&Key::new(plugin_id, feature_id)) else {
            return;
        };
        slot.history.reset_crashes();
        slot.stops += 1;
        if let Some(running) = slot.usable() {
            running.request_stop(StopReason::FromActivity);
        }
    }

    /// Stop every running backend of `plugin_id`, in every conversation,
    /// recording `reason` as why it last stopped. Call it before revoking the
    /// tab's grants: the first reason given wins, and a revoked grant alone
    /// records only "its permissions changed or it was turned off".
    pub async fn stop_plugin(&self, plugin_id: &str, reason: StopReason) -> usize {
        let mut slots = self.slots.lock().await;
        let mut stopped = 0;
        for (key, slot) in slots.by_key.iter_mut() {
            if key.plugin_id != plugin_id {
                continue;
            }
            slot.stops += 1;
            if let Some(running) = slot.usable() {
                running.request_stop(reason);
                stopped += 1;
            }
        }
        stopped
    }

    /// [`Self::stop_plugin`], then wait (bounded) for those processes to
    /// exit, so the revision they ran from is no longer pinned — removing a
    /// tab then reclaims it. Those still running at the deadline release it
    /// when they exit.
    pub async fn stop_plugin_and_wait(&self, plugin_id: &str, reason: StopReason) {
        let running: Vec<Arc<Running>> = {
            let mut slots = self.slots.lock().await;
            slots
                .by_key
                .iter_mut()
                .filter(|(key, _)| key.plugin_id == plugin_id)
                .filter_map(|(_, slot)| {
                    slot.stops += 1;
                    slot.live().cloned()
                })
                .collect()
        };
        // Past the deadline, `supervise` still releases each one's revision.
        stop_and_wait(&running, reason).await;
    }

    /// Stop the backends whose tab has had no open instance (no presence
    /// lease) in their conversation for [`ORPHAN_GRACE`].
    async fn reap(&self, presence: &PresenceStore) {
        let mut slots = self.slots.lock().await;
        for (key, slot) in slots.by_key.iter_mut() {
            let Some(running) = slot.usable().cloned() else {
                slot.orphaned_since = None;
                continue;
            };
            if presence.is_open(&key.plugin_id, key.feature_id) {
                slot.orphaned_since = None;
                continue;
            }
            let since = *slot.orphaned_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= ORPHAN_GRACE {
                tracing::info!(
                    plugin_id = key.plugin_id,
                    feature_id = key.feature_id,
                    "custom tab closed; stopping its backend"
                );
                running.request_stop(StopReason::TabClosed);
                slot.orphaned_since = None;
            }
        }
    }

    /// Cadencr is quitting: stop every backend and wait, bounded, for each
    /// process tree to be gone — dropping the supervising tasks with the
    /// runtime would only kill each backend's main process.
    pub async fn shutdown(&self) {
        let running: Vec<Arc<Running>> = {
            let mut slots = self.slots.lock().await;
            slots.closed = true;
            slots
                .by_key
                .values()
                .filter_map(Slot::live)
                .cloned()
                .collect()
        };
        if !stop_and_wait(&running, StopReason::Quit).await {
            // Cadencr is going away, so its log is the only place left to say
            // which processes may outlive it.
            let pids: Vec<u32> = running
                .iter()
                .filter(|backend| backend.is_live())
                .map(|backend| backend.pid)
                .collect();
            tracing::error!(
                ?pids,
                "custom tab backends had not exited when Cadencr quit; they may still be running"
            );
        }
    }

    /// Start [`reap_orphans`] for the life of the service: a tab's backend
    /// stops once no instance of the tab is open.
    pub fn spawn_reaper(&self, presence: &PresenceStore) {
        tokio::spawn(reap_orphans(self.clone(), presence.clone()));
    }
}

/// Ask every one of `backends` to stop, then wait for them to exit, at most
/// [`process::STOP_DEADLINE`]; `false` when some had not by then.
async fn stop_and_wait(backends: &[Arc<Running>], reason: StopReason) -> bool {
    for backend in backends {
        backend.request_stop(reason);
    }
    let exited =
        futures::future::join_all(backends.iter().map(|backend| backend.exited.cancelled()));
    tokio::time::timeout(process::STOP_DEADLINE, exited)
        .await
        .is_ok()
}

/// Runs for the life of the service: see [`BackendSupervisor::reap`].
async fn reap_orphans(supervisor: BackendSupervisor, presence: PresenceStore) {
    let mut interval = tokio::time::interval(REAP_INTERVAL);
    loop {
        interval.tick().await;
        supervisor.reap(&presence).await;
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::{json, Value};

    use super::launch::tests::launch_in;
    use super::*;
    use crate::domain::plugin_tabs::native_tab_backend;
    use crate::domain::plugin_tabs::test_support::error_code;

    fn request(method: &str, params: Value, timeout_ms: Option<u64>) -> PluginBackendRequest {
        PluginBackendRequest {
            method: method.into(),
            params,
            timeout_ms,
        }
    }

    /// A tab folder holding the native fixture backend at `bin/<mode>`.
    fn fixture_tab(mode: &str) -> (tempfile::TempDir, PathBuf, BackendLaunch) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().canonicalize().unwrap();
        native_tab_backend::install(&dir, &format!("bin/{mode}"));
        let launch = launch_in(&dir, &format!("bin/{mode}"));
        (root, dir, launch)
    }

    /// A tab folder whose backend never reads stdin and leaves a child
    /// process (its pid in `child.pid`) behind it. The guard kills that
    /// backend's group when a test fails before shutting it down.
    #[cfg(unix)]
    fn deaf_backend() -> (
        tempfile::TempDir,
        PathBuf,
        crate::shared::test_processes::KillOnDrop,
    ) {
        let (root, dir, _) = fixture_tab("deaf");
        let cleanup = crate::shared::test_processes::KillOnDrop::default()
            .group_of_pid_in(dir.join("child.pid"));
        (root, dir, cleanup)
    }

    /// Whether `pid` still runs. A zombie does not: a killed child whose
    /// parent died too waits for init to reap it, and `kill -0` still
    /// finds it meanwhile.
    #[cfg(unix)]
    fn is_alive(pid: &str) -> bool {
        std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", pid])
            .output()
            .is_ok_and(|output| {
                let state = String::from_utf8_lossy(&output.stdout);
                output.status.success()
                    && !state.trim().is_empty()
                    && !state.trim().starts_with('Z')
            })
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_backend_that_stops_reading_times_requests_out() {
        let (_root, dir, _cleanup) = deaf_backend();
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        // Big enough to fill the stdin pipe, then the request queue behind it.
        let params = json!("x".repeat(request::MAX_PARAMS_BYTES - 16));
        let calls = async {
            for _ in 0..cadencr_tab_backend::protocol::MAX_IN_FLIGHT + 4 {
                let error = supervisor
                    .request(
                        &grants,
                        launch_in(&dir, "bin/deaf"),
                        request("m", params.clone(), Some(50)),
                    )
                    .await
                    .unwrap_err();
                assert!(
                    matches!(
                        error,
                        AppError::Coded {
                            code: "PLUGIN_BACKEND_TIMEOUT",
                            ..
                        }
                    ),
                    "{error:?}"
                );
            }
        };
        tokio::time::timeout(Duration::from_secs(20), calls)
            .await
            .expect("every request ends at its own deadline");
        supervisor.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_stops_whole_backend_trees_and_refuses_new_ones() {
        let (_root, dir, _cleanup) = deaf_backend();
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let call = || {
            supervisor.request(
                &grants,
                launch_in(&dir, "bin/deaf"),
                request("m", Value::Null, Some(200)),
            )
        };
        assert!(call().await.is_err(), "the backend never answers");
        let child = std::fs::read_to_string(dir.join("child.pid")).unwrap();
        let child = child.trim();
        assert!(is_alive(child));
        supervisor.shutdown().await;
        assert!(
            !is_alive(child),
            "the backend's child outlived the shutdown"
        );
        let refused = call().await.unwrap_err();
        assert!(matches!(
            refused,
            AppError::Coded {
                code: "PLUGIN_BACKEND_UNAVAILABLE",
                ..
            }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_backend_stops_only_once_its_tab_holds_no_lease() {
        let (_root, dir, _cleanup) = deaf_backend();
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let presence = PresenceStore::default();
        presence.renew("lease", "tab", 2).unwrap();
        let _ = supervisor
            .request(
                &grants,
                launch_in(&dir, "bin/deaf"),
                request("m", Value::Null, Some(50)),
            )
            .await;
        let running = || async {
            let slots = supervisor.slots.lock().await;
            slots.by_key.values().find_map(Slot::usable).is_some()
        };
        // Its grant never lapses and the tab, however idle, holds a lease.
        supervisor.reap(&presence).await;
        assert!(running().await);
        presence.release("lease", "tab");
        supervisor.reap(&presence).await;
        assert!(running().await, "the grace has not run out yet");
        for slot in supervisor.slots.lock().await.by_key.values_mut() {
            slot.orphaned_since = Instant::now().checked_sub(ORPHAN_GRACE);
        }
        supervisor.reap(&presence).await;
        assert!(!running().await);
        supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn a_ready_backend_answers_requests() {
        let (_root, _dir, launch) = fixture_tab("backend");
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let echoed = supervisor
            .request(
                &grants,
                launch.clone(),
                request("echo", json!({"n": [1, "two"]}), None),
            )
            .await
            .unwrap();
        assert_eq!(echoed.result, Some(json!({"n": [1, "two"]})));
        let context = supervisor
            .request(
                &grants,
                launch.clone(),
                request("context", Value::Null, None),
            )
            .await
            .unwrap()
            .result
            .unwrap();
        assert_eq!(context["state_dir"], json!(launch.state_dir));
        assert!(
            launch.state_dir.is_dir(),
            "created before the backend started"
        );
        let status = supervisor.status("tab", 2).await.unwrap();
        assert_eq!(status.state, models::PluginTabBackendState::Running);
        assert!(status.stderr_tail.contains(&"backend ready".to_string()));
        // Reused as it runs, only under the hash it was started with.
        let running = supervisor.running("tab", 2, "h").await.unwrap();
        assert_eq!(running.plugin_dir(), launch.plugin_dir);
        assert!(running.managed().is_none());
        let reused = running
            .request(request("echo", json!(3), None))
            .await
            .unwrap();
        assert_eq!(reused.result, Some(json!(3)));
        assert_eq!(supervisor.status("tab", 2).await.unwrap().starts, 1);
        assert!(supervisor.running("tab", 2, "other").await.is_none());
        assert!(supervisor.running("tab", 3, "h").await.is_none());
        supervisor.shutdown().await;
        assert!(supervisor.running("tab", 2, "h").await.is_none());
    }

    #[tokio::test]
    async fn a_backend_that_never_says_ready_is_stopped() {
        let (_root, dir, launch) = fixture_tab("silent");
        // Not this binary's first start: the strict budget applies.
        first_start::ready_budget(&dir.join("bin/silent"));
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let started = Instant::now();
        let error = supervisor
            .request(&grants, launch, request("echo", Value::Null, None))
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), "PLUGIN_BACKEND_NOT_READY", "{error}");
        assert!(started.elapsed() >= handshake::READY_TIMEOUT);
        assert!(started.elapsed() < handshake::FIRST_READY_TIMEOUT);
        let mut status = supervisor.status("tab", 2).await.unwrap();
        for _ in 0..50 {
            if status.state != models::PluginTabBackendState::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            status = supervisor.status("tab", 2).await.unwrap();
        }
        assert_eq!(status.state, models::PluginTabBackendState::Crashed);
        assert!(status.exit_reason.unwrap().contains("`ready`"));
        supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn a_protocol_mismatch_stops_it_and_is_not_retried() {
        for mode in ["future", "chatty"] {
            let (_root, _dir, launch) = fixture_tab(mode);
            let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
            let call =
                || supervisor.request(&grants, launch.clone(), request("m", Value::Null, None));
            let first = call().await.unwrap_err();
            assert_eq!(
                error_code(&first),
                "PLUGIN_BACKEND_PROTOCOL_MISMATCH",
                "{mode}: {first}"
            );
            let message = first.to_string();
            let expected = if mode == "future" {
                "speaks protocol 2"
            } else {
                "listening on 8080"
            };
            assert!(message.contains(expected), "{message}");
            let stopped = supervisor.status("tab", 2).await.unwrap();
            assert_eq!(stopped.starts, 1);
            // Deterministic: the next requests are refused without a new run…
            for _ in 0..3 {
                let again = call().await.unwrap_err();
                assert_eq!(error_code(&again), "PLUGIN_BACKEND_PROTOCOL_MISMATCH");
                assert!(again
                    .to_string()
                    .contains("restart it from the tab's Activity"));
            }
            assert_eq!(supervisor.status("tab", 2).await.unwrap().starts, 1);
            // …until the user restarts it from the Activity dialog.
            supervisor.stop("tab", 2).await;
            assert!(call().await.is_err());
            assert_eq!(supervisor.status("tab", 2).await.unwrap().starts, 2);
            supervisor.shutdown().await;
        }
    }

    #[tokio::test]
    async fn refused_launches_spawn_nothing_and_are_logged() {
        let (_root, dir, mut launch) = fixture_tab("backend");
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let elsewhere = cadencr_plugin_core::tab::TabPlatform::ALL
            .into_iter()
            .find(|platform| Some(*platform) != cadencr_plugin_core::tab::TabPlatform::current())
            .unwrap();
        launch.backend.binary =
            [(elsewhere.as_str().to_string(), "bin/backend".to_string())].into();
        let call =
            || supervisor.request(&grants, launch.clone(), request("echo", Value::Null, None));
        // Each refusal is answered as itself…
        for _ in 0..history::MAX_FAILED_STARTS {
            let error = call().await.unwrap_err();
            assert_eq!(error_code(&error), "PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM");
        }
        let status = supervisor.status("tab", 2).await.unwrap();
        assert_eq!(status.starts, 0, "nothing was spawned");
        assert!(
            status.stderr_tail[0].contains("could not start"),
            "{:?}",
            status.stderr_tail
        );
        // …until a page retrying it stops re-checking the binary.
        let limited = call().await.unwrap_err();
        assert_eq!(error_code(&limited), "PLUGIN_BACKEND_START_FAILING");
        // Why is the Activity's to say, with the button that lifts the hold.
        let held = supervisor.status("tab", 2).await.unwrap();
        assert!(held.restart_held, "{held:?}");
        assert!(
            held.start_error
                .as_deref()
                .is_some_and(|reason| reason.contains("ships no binary")),
            "{held:?}"
        );
        // Restart from the Activity clears it.
        supervisor.stop("tab", 2).await;
        assert!(!supervisor.status("tab", 2).await.unwrap().restart_held);
        assert_eq!(
            error_code(&call().await.unwrap_err()),
            "PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM"
        );
        #[cfg(unix)]
        {
            super::launch::tests::write_executable(
                &dir.join("bin/script"),
                b"#!/bin/sh\necho hi\n",
            );
            let script = supervisor
                .request(
                    &grants,
                    launch_in(&dir, "bin/script"),
                    request("m", Value::Null, None),
                )
                .await
                .unwrap_err();
            assert_eq!(error_code(&script), "PLUGIN_BACKEND_NOT_NATIVE");
            assert_eq!(supervisor.status("tab", 2).await.unwrap().starts, 0);
        }
    }

    #[tokio::test]
    async fn a_backend_reports_starting_until_it_is_ready() {
        let (_root, _dir, launch) = fixture_tab("silent");
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        supervisor.ensure_running(&grants, &launch).await.unwrap();
        let status = supervisor.status("tab", 2).await.unwrap();
        assert_eq!(status.state, models::PluginTabBackendState::Starting);
        assert!(status.pid.is_some());
        supervisor.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_marketplace_backend_is_hashed_before_launch_and_pins_its_revision() {
        use crate::domain::plugin_tabs::managed::storage::{
            self, fixtures::backend_fixture, Activation,
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let install = |number: usize| {
            let tab = backend_fixture()
                .root(&temp.path().join(format!("v{number}")))
                .revision(number)
                .call();
            storage::commit_revision()
                .root(&root)
                .receipt(&tab.receipt)
                .archive(&tab.archive)
                .files(&tab.files)
                .backend(tab.payload())
                .activation(Activation::Activate)
                .call()
                .unwrap();
            tab
        };
        let tab = install(0);
        let lease = storage::lease(&root, "graph").unwrap().unwrap();
        let revision = lease.directory().to_owned();
        let mut launch = launch_in(&revision.canonicalize().unwrap(), &tab.cmd);
        launch.lease = Some(lease);
        // Never inside the immutable revision (see `paths::state_dir`).
        launch.state_dir = temp.path().join("state");
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        // A binary that differs from its signed digest never starts.
        launch.expected_sha256 = Some("0".repeat(64));
        let error = supervisor
            .request(&grants, launch.clone(), request("echo", Value::Null, None))
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), "PLUGIN_BACKEND_TAMPERED", "{error}");
        let status = supervisor.status("tab", 2).await.unwrap();
        assert_eq!(status.starts, 0);
        assert!(
            status.stderr_tail[0].contains("signed package"),
            "{status:?}"
        );
        // The signed binary starts, and holds its revision while it runs.
        launch.expected_sha256 = Some(crate::domain::themes::managed::storage::digest(
            &tab.executable,
        ));
        let running = supervisor.ensure_running(&grants, &launch).await.unwrap();
        drop(launch);
        // Its working directory is the sealed revision: it cannot write there.
        let wrote = running
            .call(
                "write_cwd",
                Value::Null,
                request::Budget::starting_now(Duration::from_secs(10)),
            )
            .await
            .unwrap()
            .result;
        assert_eq!(wrote, Some(json!(unsafe { libc::geteuid() } == 0)));
        install(1);
        install(2);
        assert!(revision.exists(), "a running backend's revision is kept");
        running.request_stop(StopReason::TabClosed);
        tokio::time::timeout(process::STOP_DEADLINE, running.exited.cancelled())
            .await
            .unwrap();
        install(3);
        assert!(!revision.exists(), "reclaimed once its backend exited");
        supervisor.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn removing_a_tab_whose_backend_runs_reclaims_its_revision() {
        use crate::domain::plugin_tabs::managed::storage::{
            self, fixtures::backend_fixture, Activation,
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let tab = backend_fixture().root(&temp.path().join("v0")).call();
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let start = || async {
            storage::commit_revision()
                .root(&root)
                .receipt(&tab.receipt)
                .archive(&tab.archive)
                .files(&tab.files)
                .backend(tab.payload())
                .activation(Activation::Activate)
                .call()
                .unwrap();
            let lease = storage::lease(&root, "graph").unwrap().unwrap();
            let revision = lease.directory().to_owned();
            let mut launch = launch_in(&revision.canonicalize().unwrap(), &tab.cmd);
            launch.plugin_id = "graph".into();
            launch.lease = Some(lease);
            launch.state_dir = temp.path().join("state");
            let running = supervisor.ensure_running(&grants, &launch).await.unwrap();
            (revision, running)
        };
        // Stopped and awaited first (the route's order): reclaimed at once.
        let (revision, _running) = start().await;
        supervisor
            .stop_plugin_and_wait("graph", StopReason::TabRemoved)
            .await;
        storage::deactivate(&root, "graph").unwrap();
        assert!(!revision.exists());
        assert!(!root.join("graph").exists());
        let status = supervisor.status("graph", 2).await.unwrap();
        assert_eq!(status.exit_reason.as_deref(), Some("its tab was removed"));
        // Removed while it still runs: reclaimed once it exits.
        let (revision, running) = start().await;
        storage::deactivate(&root, "graph").unwrap();
        assert!(revision.exists(), "pinned by the running backend");
        running.request_stop(StopReason::TabClosed);
        tokio::time::timeout(process::STOP_DEADLINE, running.exited.cancelled())
            .await
            .unwrap();
        assert!(!revision.exists(), "released with its backend");
        assert!(!root.join("graph").exists());
        supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn a_tab_stopped_while_its_binary_is_checked_starts_nothing() {
        let (_root, _dir, launch) = fixture_tab("backend");
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let Reuse::Start { history, stops, .. } = supervisor.reuse(&launch).await.unwrap() else {
            panic!("nothing runs yet");
        };
        let prepared = launch.prepare().await.unwrap();
        supervisor.stop_plugin("tab", StopReason::TabRemoved).await;
        let Err(error) = supervisor
            .spawn_unless_stopped(&grants, &launch, prepared, &history, stops)
            .await
        else {
            panic!("a stopped tab started its backend");
        };
        assert_eq!(error_code(&error), "PLUGIN_BACKEND_EXITED", "{error}");
        let status = supervisor.status("tab", 2).await.unwrap();
        assert_eq!((status.starts, status.start_error), (0, None));
        // Not held: the next request starts it.
        supervisor.ensure_running(&grants, &launch).await.unwrap();
        supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn a_request_waiting_on_a_start_times_out_on_its_own_budget() {
        let (_root, _dir, launch) = fixture_tab("backend");
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let Reuse::Start { starting, .. } = supervisor.reuse(&launch).await.unwrap() else {
            panic!("nothing runs yet");
        };
        // Another start holds the slot past the request's budget.
        let held = starting.lock().await;
        let began = Instant::now();
        let error = supervisor
            .request(
                &grants,
                launch.clone(),
                request("echo", json!(1), Some(200)),
            )
            .await
            .unwrap_err();
        assert_eq!(error_code(&error), "PLUGIN_BACKEND_TIMEOUT", "{error}");
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "{:?}",
            began.elapsed()
        );
        // The start it was waiting on goes on, for the next request.
        drop(held);
        let mut status = supervisor.status("tab", 2).await;
        for _ in 0..100 {
            if status.as_ref().is_some_and(|status| status.starts == 1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            status = supervisor.status("tab", 2).await;
        }
        assert_eq!(status.map(|status| status.starts), Some(1));
        supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn a_backend_exiting_before_ready_is_a_crash_whatever_its_status() {
        let (_root, _dir, launch) = fixture_tab("early");
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let call = || supervisor.request(&grants, launch.clone(), request("m", Value::Null, None));
        for _ in 0..history::MAX_CRASHES {
            let error = call().await.unwrap_err();
            assert_eq!(error_code(&error), "PLUGIN_BACKEND_EXITED", "{error}");
            assert!(error.to_string().contains("before it was ready"), "{error}");
        }
        let mut status = supervisor.status("tab", 2).await.unwrap();
        for _ in 0..50 {
            if status.state != models::PluginTabBackendState::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            status = supervisor.status("tab", 2).await.unwrap();
        }
        assert_eq!(status.state, models::PluginTabBackendState::Crashed);
        assert_eq!(status.exit_code, Some(0));
        assert_eq!(
            status.exit_reason.as_deref(),
            Some("exited on its own before it was ready")
        );
        assert_eq!(
            error_code(&call().await.unwrap_err()),
            "PLUGIN_BACKEND_CRASHING"
        );
        assert_eq!(supervisor.status("tab", 2).await.unwrap().starts, 3);
        supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_first_requests_start_one_process() {
        let (_root, _dir, launch) = fixture_tab("backend");
        let (supervisor, grants) = (BackendSupervisor::default(), GrantStore::default());
        let call = || supervisor.request(&grants, launch.clone(), request("echo", json!(1), None));
        let (first, second, third) = tokio::join!(call(), call(), call());
        for answer in [first, second, third] {
            assert_eq!(answer.unwrap().result, Some(json!(1)));
        }
        assert_eq!(supervisor.status("tab", 2).await.unwrap().starts, 1);
        supervisor.shutdown().await;
    }
}
