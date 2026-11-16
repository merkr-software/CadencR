//! Cached provider update status, periodic detection, and update execution.
//!
//! Checks run at startup and then periodically; every status change is
//! broadcast as an `app/provider_updates` event carrying the complete list, so
//! clients replace rather than merge. Updates run in the background — an
//! installer can take minutes — and close with an event carrying the outcome.

use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::Utc;
use futures::FutureExt;
use tokio::sync::{broadcast, Mutex};

use super::types::{
    ProviderUpdateActivity, ProviderUpdateEvent, ProviderUpdateOutcome, ProviderUpdateState,
    ProviderUpdateStatus, ProviderUpdatesResponse,
};
use super::{ProviderUpdater, ProviderVersionReport, UpdateContext, UpdateError};
use crate::domain::agents::providers::provider_registry;
use crate::domain::agents::providers::RegisteredProvider;

mod request_error;
pub use request_error::UpdateRequestError;

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(20);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug)]
pub struct ProviderUpdateService {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    state: RwLock<State>,
    tx: broadcast::Sender<ProviderUpdateEvent>,
    /// Held by the running full check; callers arriving meanwhile share it.
    check_lock: Arc<Mutex<()>>,
    context: UpdateContext,
}

#[derive(Debug, Default)]
struct State {
    statuses: HashMap<String, ProviderUpdateStatus>,
    checked_at: Option<String>,
}

impl State {
    fn status(&mut self, provider: &RegisteredProvider) -> &mut ProviderUpdateStatus {
        self.statuses
            .entry(provider.id().to_string())
            .or_insert_with(|| initial_status(provider))
    }

    /// Every registered provider, in catalog order.
    fn snapshot(&mut self) -> ProviderUpdatesResponse {
        let providers = provider_registry()
            .iter()
            .map(|provider| self.status(provider).clone())
            .collect();
        ProviderUpdatesResponse {
            providers,
            checked_at: self.checked_at.clone(),
        }
    }
}

impl ProviderUpdateService {
    pub fn new(read_pool: sqlx::SqlitePool) -> Self {
        let (tx, _) = broadcast::channel(16);
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent(concat!("Cadencr/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("an HTTP client with a timeout and user agent only fails without TLS");
        Self {
            inner: Arc::new(Inner {
                state: RwLock::default(),
                tx,
                check_lock: Arc::default(),
                context: UpdateContext { read_pool, http },
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ProviderUpdateEvent> {
        self.inner.tx.subscribe()
    }

    pub fn snapshot(&self) -> ProviderUpdatesResponse {
        self.with_state(State::snapshot)
    }

    fn with_state<R>(&self, change: impl FnOnce(&mut State) -> R) -> R {
        let mut state = self
            .inner
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        change(&mut state)
    }

    fn emit(&self, snapshot: ProviderUpdatesResponse, outcome: Option<ProviderUpdateOutcome>) {
        // `send` only fails without subscribers: no client is connected.
        let _ = self.inner.tx.send(snapshot.into_event(outcome));
    }

    /// Check every idle provider that manages updates, concurrently. A call
    /// arriving while a check runs waits for it and returns its result.
    pub async fn check_all(&self) -> ProviderUpdatesResponse {
        let Ok(guard) = self.inner.check_lock.clone().try_lock_owned() else {
            let _ = self.inner.check_lock.lock().await;
            return self.snapshot();
        };
        // Spawned so a dropped HTTP request cannot stop the check half-way and
        // leave providers marked as checking.
        let service = self.clone();
        let check = tokio::spawn(async move {
            let _guard = guard;
            service.run_checks().await
        });
        match check.await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                tracing::error!(%error, "provider update check task failed");
                self.snapshot()
            }
        }
    }

    async fn run_checks(&self) -> ProviderUpdatesResponse {
        let (checkable, snapshot) = self.with_state(|state| {
            let checkable: Vec<RegisteredProvider> = provider_registry()
                .iter()
                .filter(|provider| provider.metadata().updater().is_some())
                .filter(|provider| state.status(provider).activity.is_none())
                .cloned()
                .collect();
            for provider in &checkable {
                state.status(provider).activity = Some(ProviderUpdateActivity::Checking);
            }
            (checkable, state.snapshot())
        });
        self.emit(snapshot, None);

        let context = &self.inner.context;
        let results = futures::future::join_all(checkable.iter().filter_map(|provider| {
            let updater = provider.metadata().updater()?;
            Some(async move { (provider, run_check(updater.as_ref(), context).await) })
        }))
        .await;
        let snapshot = self.with_state(|state| {
            for (provider, result) in results {
                apply_check(state.status(provider), result);
            }
            state.checked_at = Some(Utc::now().to_rfc3339());
            state.snapshot()
        });
        self.emit(snapshot.clone(), None);
        snapshot
    }

    /// Validate and start an update in the background. Returns the status
    /// with `activity: updating`; the outcome arrives as a WebSocket event.
    pub fn start_update(
        &self,
        provider_id: &str,
        target: Option<String>,
    ) -> Result<ProviderUpdateStatus, UpdateRequestError> {
        let provider = provider_registry()
            .iter()
            .find(|provider| provider.id() == provider_id)
            .ok_or(UpdateRequestError::NotFound)?
            .clone();
        let updater = provider
            .metadata()
            .updater()
            .cloned()
            .ok_or(UpdateRequestError::Unsupported)?;
        let (previous, snapshot) = self.with_state(|state| {
            let status = state.status(&provider);
            validate_request(status, target.as_deref())?;
            status.activity = Some(ProviderUpdateActivity::Updating);
            Ok::<_, UpdateRequestError>((status.clone(), state.snapshot()))
        })?;
        self.emit(snapshot, None);

        let service = self.clone();
        let previous_version = previous.current_version.clone();
        tokio::spawn(async move {
            let context = &service.inner.context;
            let result = contained(updater.update(context, target.as_deref()), "update").await;
            let check = run_check(updater.as_ref(), context).await;
            let (outcome, snapshot) = service.with_state(|state| {
                let status = state.status(&provider);
                apply_check(status, check);
                (
                    build_outcome(status, previous_version, result),
                    state.snapshot(),
                )
            });
            if !outcome.success {
                tracing::warn!(provider_id = provider.id(), message = ?outcome.message, "provider update failed");
            }
            service.emit(snapshot, Some(outcome));
        });
        Ok(previous)
    }

    /// Detect new versions shortly after startup, then periodically.
    pub fn spawn_periodic_checks(&self) {
        let service = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(STARTUP_CHECK_DELAY).await;
            loop {
                service.check_all().await;
                tokio::time::sleep(CHECK_INTERVAL).await;
            }
        });
    }
}

/// Run provider-owned code so that a panic becomes a reported failure instead
/// of a provider stuck in `checking` / `updating`.
async fn contained<T>(
    work: impl Future<Output = Result<T, UpdateError>>,
    what: &str,
) -> Result<T, UpdateError> {
    AssertUnwindSafe(work)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            Err(UpdateError::failed(format!(
                "the provider's {what} crashed"
            )))
        })
}

async fn run_check(
    updater: &dyn ProviderUpdater,
    context: &UpdateContext,
) -> Result<ProviderVersionReport, UpdateError> {
    tokio::time::timeout(
        CHECK_TIMEOUT,
        contained(updater.check(context), "version check"),
    )
    .await
    .unwrap_or_else(|_| {
        Err(UpdateError::failed(format!(
            "version check timed out after {} seconds",
            CHECK_TIMEOUT.as_secs()
        )))
    })
}

fn initial_status(provider: &RegisteredProvider) -> ProviderUpdateStatus {
    let state = if provider.metadata().updater().is_some() {
        ProviderUpdateState::Unchecked
    } else {
        ProviderUpdateState::Unsupported
    };
    ProviderUpdateStatus {
        provider_id: provider.id().to_string(),
        label: provider.adapter().catalog_entry().label,
        origin: provider.origin(),
        state,
        activity: None,
        current_version: None,
        latest_version: None,
        available_versions: Vec::new(),
        supports_target_version: false,
        error: None,
    }
}

/// Record a check result. A failed check keeps the last known versions so the
/// settings page still shows what is installed.
fn apply_check(
    status: &mut ProviderUpdateStatus,
    result: Result<ProviderVersionReport, UpdateError>,
) {
    status.activity = None;
    match result {
        Err(UpdateError::Unsupported) => {
            status.state = ProviderUpdateState::Unsupported;
            status.error = None;
        }
        Err(UpdateError::Failed(message)) => {
            status.state = ProviderUpdateState::CheckFailed;
            status.error = Some(message);
        }
        Ok(report) => {
            status.state = match (&report.current_version, &report.check_error) {
                (None, _) => ProviderUpdateState::NotInstalled,
                (Some(_), Some(_)) => ProviderUpdateState::CheckFailed,
                (Some(_), None) if report.update_available => ProviderUpdateState::UpdateAvailable,
                (Some(_), None) => ProviderUpdateState::UpToDate,
            };
            if report.check_error.is_none() {
                status.latest_version = report.latest_version;
                status.available_versions = report.available_versions;
            }
            status.error = report.check_error;
            status.current_version = report.current_version;
            status.supports_target_version = report.supports_target_version;
        }
    }
}

/// Refuse a request the last report cannot honor. A provider that is checking
/// is busy too: the check's result would overwrite the update's progress.
fn validate_request(
    status: &ProviderUpdateStatus,
    target: Option<&str>,
) -> Result<(), UpdateRequestError> {
    if status.activity.is_some() {
        return Err(UpdateRequestError::InProgress);
    }
    let Some(target) = target else {
        return Ok(());
    };
    if !status.supports_target_version {
        return Err(UpdateRequestError::TargetUnsupported);
    }
    if !status
        .available_versions
        .iter()
        .any(|version| version == target)
    {
        return Err(UpdateRequestError::UnknownVersion(target.to_string()));
    }
    Ok(())
}

/// The updater's exit status alone is not proof: an upgrader can succeed on a
/// different install than the one Cadencr runs, so an unchanged version that
/// is still behind counts as a failure.
fn build_outcome(
    status: &ProviderUpdateStatus,
    previous_version: Option<String>,
    result: Result<Option<String>, UpdateError>,
) -> ProviderUpdateOutcome {
    let unchanged = status.state == ProviderUpdateState::UpdateAvailable
        && status.current_version.is_some()
        && status.current_version == previous_version;
    let (success, message) = match result {
        Ok(_) if unchanged => (
            false,
            Some(format!(
                "The updater finished, but {} is still on {}.",
                status.label,
                status.current_version.as_deref().unwrap_or_default()
            )),
        ),
        Ok(summary) => (true, summary),
        Err(error) => (false, Some(error.to_string())),
    };
    ProviderUpdateOutcome {
        provider_id: status.provider_id.clone(),
        label: status.label.clone(),
        success,
        previous_version,
        current_version: status.current_version.clone(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> ProviderUpdateStatus {
        ProviderUpdateStatus {
            provider_id: "acme".into(),
            label: "Acme".into(),
            origin: crate::domain::agents::runtime::ProviderOrigin::InstalledLocal,
            state: ProviderUpdateState::Unchecked,
            activity: Some(ProviderUpdateActivity::Checking),
            current_version: None,
            latest_version: None,
            available_versions: Vec::new(),
            supports_target_version: false,
            error: None,
        }
    }

    fn report(current: &str, latest: &str, update_available: bool) -> ProviderVersionReport {
        ProviderVersionReport {
            current_version: Some(current.into()),
            latest_version: Some(latest.into()),
            available_versions: vec![latest.into(), current.into()],
            update_available,
            supports_target_version: true,
            check_error: None,
        }
    }

    #[test]
    fn check_results_map_to_states() {
        let mut current = status();
        apply_check(&mut current, Ok(report("1.0.0", "1.1.0", true)));
        assert_eq!(current.state, ProviderUpdateState::UpdateAvailable);
        assert_eq!(current.activity, None);

        apply_check(&mut current, Ok(report("1.1.0", "1.1.0", false)));
        assert_eq!(current.state, ProviderUpdateState::UpToDate);

        apply_check(&mut current, Ok(ProviderVersionReport::default()));
        assert_eq!(current.state, ProviderUpdateState::NotInstalled);

        apply_check(&mut current, Err(UpdateError::Unsupported));
        assert_eq!(current.state, ProviderUpdateState::Unsupported);
    }

    #[test]
    fn a_failed_check_keeps_the_last_known_versions() {
        let mut current = status();
        apply_check(&mut current, Ok(report("1.0.0", "1.1.0", true)));
        apply_check(&mut current, Err(UpdateError::failed("offline")));
        assert_eq!(current.state, ProviderUpdateState::CheckFailed);
        assert_eq!(current.error.as_deref(), Some("offline"));
        assert_eq!(current.current_version.as_deref(), Some("1.0.0"));
        assert_eq!(current.latest_version.as_deref(), Some("1.1.0"));

        let lookup_failed = ProviderVersionReport {
            current_version: Some("1.0.1".into()),
            check_error: Some("registry unreachable".into()),
            ..ProviderVersionReport::default()
        };
        apply_check(&mut current, Ok(lookup_failed));
        assert_eq!(current.state, ProviderUpdateState::CheckFailed);
        assert_eq!(current.current_version.as_deref(), Some("1.0.1"));
        assert_eq!(current.latest_version.as_deref(), Some("1.1.0"));
    }

    #[test]
    fn requests_are_validated_against_the_last_report() {
        let mut current = status();
        current.activity = None;
        assert_eq!(
            validate_request(&current, Some("1.1.0")),
            Err(UpdateRequestError::TargetUnsupported)
        );
        apply_check(&mut current, Ok(report("1.0.0", "1.1.0", true)));
        assert_eq!(validate_request(&current, None), Ok(()));
        assert_eq!(validate_request(&current, Some("1.1.0")), Ok(()));
        assert_eq!(
            validate_request(&current, Some("9.9.9")),
            Err(UpdateRequestError::UnknownVersion("9.9.9".into()))
        );
        for activity in [
            ProviderUpdateActivity::Checking,
            ProviderUpdateActivity::Updating,
        ] {
            current.activity = Some(activity);
            assert_eq!(
                validate_request(&current, None),
                Err(UpdateRequestError::InProgress)
            );
        }
    }

    #[test]
    fn outcomes_carry_the_version_transition() {
        let mut current = status();
        apply_check(&mut current, Ok(report("1.1.0", "1.1.0", false)));
        let outcome = build_outcome(&current, Some("1.0.0".into()), Ok(None));
        assert!(outcome.success);
        assert_eq!(outcome.previous_version.as_deref(), Some("1.0.0"));
        assert_eq!(outcome.current_version.as_deref(), Some("1.1.0"));

        let failed = build_outcome(&current, None, Err(UpdateError::failed("EACCES")));
        assert!(!failed.success);
        assert_eq!(failed.message.as_deref(), Some("EACCES"));
    }

    #[test]
    fn an_update_that_left_the_version_behind_is_a_failure() {
        let mut current = status();
        apply_check(&mut current, Ok(report("1.0.0", "1.1.0", true)));
        let outcome = build_outcome(&current, Some("1.0.0".into()), Ok(None));
        assert!(!outcome.success);
        assert_eq!(
            outcome.message.as_deref(),
            Some("The updater finished, but Acme is still on 1.0.0.")
        );
    }

    #[tokio::test]
    async fn contained_turns_a_panic_into_a_failure() {
        let result: Result<(), UpdateError> =
            contained(async { panic!("updater bug") }, "update").await;
        assert_eq!(
            result,
            Err(UpdateError::failed("the provider's update crashed"))
        );
    }
}
