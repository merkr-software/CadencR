//! Concurrent theme/tab requests share acquisition without sharing theme policy.
use super::{Context, VerifiedCatalog};
use crate::error::AppError;
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Instant,
};

type Outcome = (Result<VerifiedCatalog, String>, Option<String>);
type Flight = tokio::sync::Mutex<Option<(Instant, bool, Arc<Outcome>)>>;

fn flight(root: &PathBuf) -> Result<Arc<Flight>, AppError> {
    static ROOTS: OnceLock<Mutex<HashMap<PathBuf, Weak<Flight>>>> = OnceLock::new();
    let mut roots = ROOTS
        .get_or_init(Default::default)
        .lock()
        .map_err(super::invalid)?;
    roots.retain(|_, flight| flight.strong_count() > 0);
    if let Some(flight) = roots.get(root).and_then(Weak::upgrade) {
        return Ok(flight);
    }
    let flight = Arc::new(Flight::default());
    roots.insert(root.clone(), Arc::downgrade(&flight));
    Ok(flight)
}

pub(super) async fn acquire(
    context: Context,
    refresh: bool,
    fetch: Option<impl Future<Output = Result<Vec<u8>, AppError>> + Send>,
) -> Arc<Outcome> {
    let requested = Instant::now();
    let flight = match flight(&context.root) {
        Ok(flight) => flight,
        Err(error) => return Arc::new((Err(error.to_string()), None)),
    };
    let mut state = flight.lock().await;
    if let Some((completed, forced, result)) = &*state {
        if *completed >= requested && (!refresh || *forced) && current(result) {
            return result.clone();
        }
    }
    let (result, warning) = super::acquire_or_cached(context, refresh, fetch).await;
    let outcome = Arc::new((result.map_err(|error| error.to_string()), warning));
    *state = Some((Instant::now(), refresh, outcome.clone()));
    outcome
}

fn current(result: &Outcome) -> bool {
    match &result.0 {
        Err(_) => true,
        Ok(catalog) => chrono::DateTime::parse_from_rfc3339(&catalog.index.signed.expires_at)
            .is_ok_and(|expiry| expiry > chrono::Utc::now()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn concurrent_forced_refreshes_share_verification_and_later_refreshes_fetch_again() {
        let temp = tempfile::tempdir().unwrap();
        let (index, trust) = super::super::super::tests::signed();
        let bytes = serde_json::to_vec(&index).unwrap();
        let context = Context {
            root: temp.path().join("catalog"),
            trust,
        };
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            Ok(bytes.clone())
        };
        let (theme, tab) = tokio::join!(
            acquire(context.clone(), true, Some(fetch())),
            acquire(context.clone(), true, Some(fetch())),
        );
        assert!(theme.0.is_ok(), "{:?}", theme.0.as_ref().err());
        assert!(Arc::ptr_eq(&theme, &tab));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert!(acquire(context, true, Some(fetch())).await.0.is_ok());
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn concurrent_failures_are_shared_without_becoming_a_persistent_cache() {
        let temp = tempfile::tempdir().unwrap();
        let (_, trust) = super::super::super::tests::signed();
        let context = Context {
            root: temp.path().join("catalog"),
            trust,
        };
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            Err(super::super::invalid("offline fixture"))
        };
        let (theme, tab) = tokio::join!(
            acquire(context.clone(), true, Some(fetch())),
            acquire(context.clone(), true, Some(fetch())),
        );
        assert!(theme.0.as_ref().unwrap_err().contains("offline fixture"));
        assert!(Arc::ptr_eq(&theme, &tab));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert!(acquire(context, true, Some(fetch())).await.0.is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }
}
