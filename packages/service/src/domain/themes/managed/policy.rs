//! Host-owned, signed declarative-theme revocations. Never projects ACP policy.
use super::{download, storage};
use crate::domain::agents::providers::installed::managed::trust::{
    pinned_index_trust_store, ManagedTrustStore,
};
use crate::domain::agents::providers::installed::managed::ManagedIndexSignature;
use crate::error::AppError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_POLICY_BYTES: usize = cadencr_registry_core::MAX_SIGNED_THEME_BLOCKLIST_BYTES;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    signed: Value,
    signature: ManagedIndexSignature,
}
struct Verified {
    generated_at: DateTime<Utc>,
    policy: cadencr_registry_core::ThemeBlocklist,
}
fn unavailable(message: impl std::fmt::Display) -> AppError {
    AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "MANAGED_THEME_POLICY_UNAVAILABLE",
        message.to_string(),
    )
}
fn source() -> Option<&'static str> {
    #[cfg(test)]
    if tests::configured_trust().is_some() {
        return Some("https://registry.example/theme-blocklist.json");
    }
    option_env!("CADENCR_MANAGED_THEME_BLOCKLIST_URL").filter(|url| !url.trim().is_empty())
}
fn trust_store() -> ManagedTrustStore {
    #[cfg(test)]
    if let Some(trust) = tests::configured_trust() {
        return trust;
    }
    pinned_index_trust_store()
}
fn require_source(url: Option<&str>) -> Result<&str, AppError> {
    url.ok_or_else(|| unavailable("managed theme revocation policy source is not configured"))
}
fn cache() -> std::path::PathBuf {
    storage::root().join("theme-blocklist.json")
}
fn parse(bytes: &[u8]) -> Result<Envelope, AppError> {
    if bytes.len() > MAX_POLICY_BYTES {
        return Err(unavailable("theme revocation policy exceeds byte budget"));
    }
    let value = cadencr_registry_core::parse_json_bytes(bytes).map_err(unavailable)?;
    serde_json::from_value(value).map_err(unavailable)
}
fn cached() -> Result<Envelope, AppError> {
    storage::secure(&storage::root()).map_err(unavailable)?;
    parse(&storage::regular(&cache(), MAX_POLICY_BYTES).map_err(unavailable)?)
}
fn verify(
    envelope: &Envelope,
    trust: &ManagedTrustStore,
    current: bool,
    now: DateTime<Utc>,
) -> Result<Verified, AppError> {
    let prepared = cadencr_registry_core::prepare_theme_blocklist(&envelope.signed, !current, now)
        .map_err(unavailable)?;
    if current {
        trust
            .verify_bytes(prepared.signing.canonical_payload(), &envelope.signature)
            .map_err(unavailable)?;
    } else {
        trust
            .authenticate_theme_policy_baseline(
                &serde_json::to_value(envelope).map_err(unavailable)?,
                now,
            )
            .map_err(unavailable)?;
    }
    let generated_at = DateTime::parse_from_rfc3339(&prepared.policy.generated_at)
        .map_err(unavailable)?
        .with_timezone(&Utc);
    Ok(Verified {
        generated_at,
        policy: prepared.policy,
    })
}

fn ingest(
    envelope: &Envelope,
    trust: &ManagedTrustStore,
    now: DateTime<Utc>,
) -> Result<Verified, AppError> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(unavailable)?;
    let incoming = verify(envelope, trust, true, now)?;
    match cached() {
        Ok(previous) => {
            // The incoming envelope is already current/authenticated. Exact
            // canonical replay also authenticates the identical cached envelope.
            if envelope.signed == previous.signed
                && envelope.signature.key_id == previous.signature.key_id
                && envelope.signature.value == previous.signature.value
            {
                return Ok(incoming);
            }
            let prior = verify(&previous, trust, false, now)?;
            if incoming.generated_at < prior.generated_at
                || (incoming.generated_at == prior.generated_at
                    && envelope.signed != previous.signed)
            {
                return Err(unavailable(
                    "theme revocation policy rollback or equivocation rejected",
                ));
            }
        }
        Err(error) => match cache().symlink_metadata() {
            Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err(error),
            Err(inspect) => {
                return Err(unavailable(format!(
                    "cannot inspect theme policy high-water cache: {inspect}"
                )))
            }
        },
    }
    storage::secure(&storage::root()).map_err(unavailable)?;
    crate::shared::atomic_file::write_atomic_private(
        &cache(),
        &serde_json::to_string(envelope).map_err(unavailable)?,
    )
    .map_err(unavailable)?;
    Ok(incoming)
}
// Cryptographic validity is independent of the online revocation poll interval.
const POLL_CADENCE: std::time::Duration = std::time::Duration::from_secs(15 * 60);
const FORCE_CADENCE: std::time::Duration = std::time::Duration::from_secs(5);
const RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_secs(60);
#[derive(Default)]
struct RefreshState {
    completed: Option<std::time::Instant>,
    failure: Option<String>,
    verified_until: Option<(u64, DateTime<Utc>)>,
}
impl RefreshState {
    fn remember(&mut self, verified: &Verified, generation: Option<u64>) -> Result<(), AppError> {
        self.verified_until = generation
            .map(|generation| expiry(verified).map(|expiry| (generation, expiry)))
            .transpose()?;
        Ok(())
    }
    fn needs_poll(&self, force: bool, requested: std::time::Instant) -> bool {
        match self.completed {
            None => true,                         // Always check remotely after process startup.
            Some(at) if at >= requested => false, // Coalesce even forced callers.
            Some(at) => {
                requested.duration_since(at)
                    >= if self.failure.is_some() {
                        RETRY_BACKOFF
                    } else if force {
                        FORCE_CADENCE
                    } else {
                        POLL_CADENCE
                    }
            }
        }
    }
}
type RefreshHandle = std::sync::Arc<tokio::sync::Mutex<RefreshState>>;
type RefreshRoots = std::collections::HashMap<std::path::PathBuf, RefreshHandle>;
fn refresh_state(root: std::path::PathBuf) -> Result<RefreshHandle, AppError> {
    static ROOTS: std::sync::OnceLock<std::sync::Mutex<RefreshRoots>> = std::sync::OnceLock::new();
    Ok(ROOTS
        .get_or_init(Default::default)
        .lock()
        .map_err(unavailable)?
        .entry(root)
        .or_default()
        .clone())
}
pub(super) async fn refresh(force: bool) -> Result<Option<String>, AppError> {
    let url = require_source(source())?;
    refresh_with(
        force,
        &trust_store(),
        refresh_state(cache())?,
        std::time::Instant::now(),
        Utc::now(),
        || async {
            download::download(url, MAX_POLICY_BYTES)
                .await
                .map_err(unavailable)
        },
    )
    .await
}
async fn refresh_with<F, Fut>(
    force: bool,
    trust: &ManagedTrustStore,
    state: RefreshHandle,
    requested: std::time::Instant,
    now: DateTime<Utc>,
    fetch: F,
) -> Result<Option<String>, AppError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>, AppError>>,
{
    // Resolve before the first await: blocking workers have separate thread-local roots.
    let root = storage::root();
    let mut state = state.lock().await;
    let checked_at = elapsed_time(now, requested)?;
    if !state.needs_poll(force, requested) {
        let coalesced = state.completed.is_some_and(|at| at >= requested);
        if coalesced
            && state.verified_until.is_some_and(|(generation, expiry)| {
                Some(generation) == trust.generation() && expiry > checked_at
            })
        {
            return Ok(state.failure.clone());
        }
        let generation = trust.generation();
        state.verified_until = None;
        let trust = trust.clone();
        let verified = offload(root, move || cached_current(&trust, now, requested)).await?;
        state.remember(&verified, generation)?;
        return Ok(state.failure.clone());
    }
    let generation = trust.generation();
    let result = async {
        let bytes = fetch().await?;
        let trust = trust.clone();
        offload(root.clone(), move || {
            let verified = ingest(&parse(&bytes)?, &trust, elapsed_time(now, requested)?)?;
            ensure_current(&verified, elapsed_time(now, requested)?)?;
            Ok(verified)
        })
        .await
    }
    .await;
    state.completed = Some(std::time::Instant::now().max(requested));
    state.failure = result.as_ref().err().map(ToString::to_string);
    state.verified_until = None;
    match result {
        Ok(verified) => {
            state.remember(&verified, generation)?;
            Ok(None)
        }
        Err(error) => {
            let trust = trust.clone();
            let verified = offload(root, move || cached_current(&trust, now, requested))
                .await
                .map_err(|cache_error| {
                    unavailable(format!(
                        "{error}; verified theme policy unavailable: {cache_error}"
                    ))
                })?;
            state.remember(&verified, generation)?;
            let warning = format!("{error}; using current verified offline theme policy");
            state.failure = Some(warning.clone());
            Ok(Some(warning))
        }
    }
}
fn elapsed_time(
    now: DateTime<Utc>,
    requested: std::time::Instant,
) -> Result<DateTime<Utc>, AppError> {
    Ok(now + chrono::Duration::from_std(requested.elapsed()).map_err(unavailable)?)
}
fn expiry(verified: &Verified) -> Result<DateTime<Utc>, AppError> {
    DateTime::parse_from_rfc3339(&verified.policy.expires_at)
        .map(|at| at.with_timezone(&Utc))
        .map_err(unavailable)
}
fn ensure_current(verified: &Verified, now: DateTime<Utc>) -> Result<(), AppError> {
    if expiry(verified)? <= now {
        return Err(unavailable("theme revocation policy expired"));
    }
    Ok(())
}
fn cached_current(
    trust: &ManagedTrustStore,
    now: DateTime<Utc>,
    requested: std::time::Instant,
) -> Result<Verified, AppError> {
    let verified = verify(&cached()?, trust, true, elapsed_time(now, requested)?)?;
    // Expiry remains fail-closed if IO or verification crossed its deadline.
    ensure_current(&verified, elapsed_time(now, requested)?)?;
    Ok(verified)
}
async fn offload<T: Send + 'static>(
    root: std::path::PathBuf,
    operation: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(move || storage::with_root(root, operation))
        .await
        .map_err(unavailable)?
}
pub(super) struct Snapshot(Verified);
pub(super) fn snapshot() -> Result<Snapshot, AppError> {
    snapshot_cached(source().is_some(), &trust_store())
}
fn snapshot_cached(configured: bool, trust: &ManagedTrustStore) -> Result<Snapshot, AppError> {
    if !configured {
        return Err(unavailable(
            "managed theme revocation policy source is not configured",
        ));
    }
    Ok(Snapshot(verify(&cached()?, trust, true, Utc::now())?))
}
impl Snapshot {
    pub(super) fn enforce(&self, id: &str, version: &str, digest: &str) -> Result<(), AppError> {
        enforce_verified(&self.0, id, version, digest)
    }
}
pub(super) fn enforce(id: &str, version: &str, digest: &str) -> Result<(), AppError> {
    enforce_cached(id, version, digest, source().is_some(), &trust_store())
}
fn enforce_cached(
    id: &str,
    version: &str,
    digest: &str,
    configured: bool,
    trust: &ManagedTrustStore,
) -> Result<(), AppError> {
    snapshot_cached(configured, trust)?.enforce(id, version, digest)
}
fn enforce_verified(
    policy: &Verified,
    id: &str,
    version: &str,
    digest: &str,
) -> Result<(), AppError> {
    ensure_current(policy, Utc::now())?;
    if let Some(reason) = policy
        .policy
        .blocked_reason(id, version, digest)
        .map_err(unavailable)?
    {
        return Err(AppError::coded(
            axum::http::StatusCode::CONFLICT,
            "MANAGED_THEME_REVOKED",
            format!("managed theme {id} is revoked: {reason}"),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::domain::agents::providers::installed::managed::trust::TrustedIndexKey;
    use base64::Engine as _;
    use ed25519_dalek::{Signer as _, SigningKey};
    type FixtureRoots = std::collections::HashMap<std::path::PathBuf, ManagedTrustStore>;
    fn fixture_roots() -> &'static std::sync::Mutex<FixtureRoots> {
        static ROOTS: std::sync::OnceLock<std::sync::Mutex<FixtureRoots>> =
            std::sync::OnceLock::new();
        ROOTS.get_or_init(Default::default)
    }
    pub(super) fn configured_trust() -> Option<ManagedTrustStore> {
        fixture_roots()
            .lock()
            .unwrap()
            .get(&storage::root())
            .cloned()
    }
    pub(in crate::domain::themes::managed) struct ConfiguredPolicy(std::path::PathBuf);
    impl Drop for ConfiguredPolicy {
        fn drop(&mut self) {
            fixture_roots().lock().unwrap().remove(&self.0);
        }
    }
    pub(in crate::domain::themes::managed) fn configured_policy() -> ConfiguredPolicy {
        let (envelope, trust) = signed(-1, serde_json::json!([]));
        ingest(&envelope, &trust, Utc::now()).unwrap();
        let root = storage::root();
        fixture_roots().lock().unwrap().insert(root.clone(), trust);
        ConfiguredPolicy(root)
    }
    fn signed(offset_minutes: i64, entries: Value) -> (Envelope, ManagedTrustStore) {
        let now = Utc::now();
        let signed = serde_json::json!({"schema_version":1,"kind":"theme-blocklist","generated_at":(now+chrono::Duration::minutes(offset_minutes)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"expires_at":(now+chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"entries":entries});
        let key = SigningKey::from_bytes(&[19; 32]);
        let signature = ManagedIndexSignature {
            algorithm: crate::domain::agents::providers::installed::managed::ManagedSignatureAlgorithm::Ed25519,
            key_id: "test".into(),
            value: base64::engine::general_purpose::STANDARD.encode(
                key.sign(&cadencr_registry_core::canonical_json_bytes(&signed))
                    .to_bytes(),
            ),
        };
        (
            Envelope { signed, signature },
            ManagedTrustStore::new([
                TrustedIndexKey::new("test", key.verifying_key().to_bytes()).unwrap()
            ]),
        )
    }
    #[test]
    fn unconfigured_policy_fails_closed_even_with_valid_cached_policy() {
        let (envelope, trust) = signed(-1, serde_json::json!([]));
        let digest = "a".repeat(64);
        assert!(require_source(None).is_err());
        assert!(require_source(Some("https://registry.example/themes/blocklist.json")).is_ok());
        assert!(snapshot_cached(false, &trust).is_err());
        assert!(snapshot_cached(true, &trust).is_err());
        assert!(enforce_cached("midnight", "1.0.0", &digest, false, &trust).is_err());
        ingest(&envelope, &trust, Utc::now()).unwrap();
        assert!(snapshot_cached(false, &trust).is_err());
        assert!(enforce_cached("midnight", "1.0.0", &digest, false, &trust).is_err());
        let snapshot = snapshot_cached(true, &trust).unwrap();
        snapshot.enforce("midnight", "1.0.0", &digest).unwrap();
        enforce_cached("midnight", "1.0.0", &digest, true, &trust).unwrap();
        assert!(snapshot_cached(true, &ManagedTrustStore::default()).is_err());
    }
    #[test]
    fn authenticated_replay_does_not_replace_cache_but_b_resigning_does() {
        let (old, original) = signed(-3, serde_json::json!([]));
        let now = Utc::now();
        ingest(&old, &original, now).unwrap();
        let bytes = std::fs::read(cache()).unwrap();
        let modified = std::fs::metadata(cache()).unwrap().modified().unwrap();
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt as _;
            std::fs::metadata(cache()).unwrap().ino()
        };
        ingest(&old, &original, now).unwrap();
        assert_eq!(std::fs::read(cache()).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(cache()).unwrap().modified().unwrap(),
            modified
        );
        assert!(ingest(&old, &original, now + chrono::Duration::hours(2)).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            assert_eq!(std::fs::metadata(cache()).unwrap().ino(), inode);
        }
        let trust = super::super::catalog::tests::rotation_trust(
            now - chrono::Duration::minutes(1),
            false,
            vec![],
            vec![],
        );
        let renewed = resign_b(old);
        ingest(&renewed, &trust, now).unwrap();
        assert_eq!(cached().unwrap().signature.value, renewed.signature.value);
        assert_ne!(std::fs::read(cache()).unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt as _;
            assert_ne!(std::fs::metadata(cache()).unwrap().ino(), inode);
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn blocking_cache_validation_preserves_root_and_async_responsiveness() {
        let (envelope, trust) = signed(-1, serde_json::json!([]));
        let now = Utc::now();
        ingest(&envelope, &trust, now).unwrap();
        let root = storage::root();
        let captured = root.clone();
        let blocking_trust = trust.clone();
        let requested = std::time::Instant::now();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = offload(root, move || {
            started_tx
                .send(())
                .map_err(|_| unavailable("cache worker failed to announce startup"))?;
            release_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(unavailable)?;
            assert_eq!(storage::root(), captured);
            cached_current(&blocking_trust, now, requested)
        });
        let heartbeat = async {
            started_rx.await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            release_tx.send(()).unwrap();
        };
        let (verified, ()) = tokio::join!(worker, heartbeat);
        verified.unwrap();
        let state = std::sync::Arc::new(tokio::sync::Mutex::new(RefreshState::default()));
        assert!(
            refresh_with(false, &trust, state.clone(), requested, now, || {
                std::future::ready(Err(unavailable("offline")))
            })
            .await
            .unwrap()
            .unwrap()
            .contains("current verified offline")
        );
        assert!(refresh_with(
            false,
            &trust,
            state,
            requested,
            now + chrono::Duration::hours(2),
            || std::future::ready(Err(unavailable("offline")))
        )
        .await
        .is_err());
    }
    fn resign_b(mut envelope: Envelope) -> Envelope {
        envelope.signature.key_id = "current-b".into();
        envelope.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[23; 32])
                .sign(&cadencr_registry_core::canonical_json_bytes(
                    &envelope.signed,
                ))
                .to_bytes(),
        );
        envelope
    }
    #[test]
    fn retired_policy_highwater_migrates_without_granting_old_current_authority() {
        let (old, original) = signed(-3, serde_json::json!([]));
        let now = Utc::now();
        ingest(&old, &original, now).unwrap();
        let trust = super::super::catalog::tests::rotation_trust(
            now - chrono::Duration::minutes(1),
            false,
            vec![],
            vec![],
        );
        assert!(verify(&old, &trust, true, now).is_err());
        verify(&old, &trust, false, now).unwrap();
        let renewed = resign_b(old.clone());
        ingest(&renewed, &trust, now).unwrap();
        assert_eq!(cached().unwrap().signature.key_id, "current-b");
        verify(&cached().unwrap(), &trust, true, now).unwrap();
        let (newer, _) = signed(
            -1,
            serde_json::json!([{"theme_id":"midnight","reason":"revoked"}]),
        );
        let newer = resign_b(newer);
        ingest(&newer, &trust, now).unwrap();
        assert!(ingest(&renewed, &trust, now).is_err());
        assert!(enforce_verified(
            &verify(&cached().unwrap(), &trust, true, now).unwrap(),
            "midnight",
            "1.0.0",
            &"a".repeat(64)
        )
        .is_err());
        let (post_retirement, _) = signed(0, serde_json::json!([]));
        assert!(verify(&post_retirement, &trust, false, Utc::now()).is_err());
    }
    #[test]
    fn expired_retired_policy_remains_highwater_but_never_offline_fallback() {
        let (mut old, original) = signed(-3, serde_json::json!([]));
        let now = Utc::now();
        old.signed["expires_at"] = (now - chrono::Duration::minutes(2))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            .into();
        old.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[19; 32])
                .sign(&cadencr_registry_core::canonical_json_bytes(&old.signed))
                .to_bytes(),
        );
        ingest(&old, &original, now - chrono::Duration::seconds(150)).unwrap();
        let trust = super::super::catalog::tests::rotation_trust(
            now - chrono::Duration::minutes(1),
            false,
            vec![],
            vec![],
        );
        assert!(verify(&old, &trust, true, now).is_err());
        verify(&old, &trust, false, now).unwrap();
        let (newer, _) = signed(-1, serde_json::json!([]));
        ingest(&resign_b(newer), &trust, now).unwrap();
        let (older, _) = signed(-4, serde_json::json!([]));
        assert!(ingest(&resign_b(older), &trust, now).is_err());
    }
    #[test]
    fn compromised_policy_needs_scoped_exact_checkpoint_for_baseline_only() {
        let (old, original) = signed(-3, serde_json::json!([]));
        let now = Utc::now();
        ingest(&old, &original, now).unwrap();
        let before = std::fs::read(cache()).unwrap();
        let digest = cadencr_registry_core::VerifiedRegistryTrust::catalog_digest(
            &serde_json::to_value(&old).unwrap(),
        );
        let denied = super::super::catalog::tests::rotation_trust(now, true, vec![], vec![]);
        let renewed = resign_b(old.clone());
        assert!(ingest(&renewed, &denied, now).is_err());
        let wrong_namespace =
            super::super::catalog::tests::rotation_trust(now, true, vec![digest.clone()], vec![]);
        assert!(ingest(&renewed, &wrong_namespace, now).is_err());
        assert_eq!(std::fs::read(cache()).unwrap(), before);
        let approved =
            super::super::catalog::tests::rotation_trust(now, true, vec![], vec![digest]);
        assert!(verify(&old, &approved, true, now).is_err());
        verify(&old, &approved, false, now).unwrap();
        let mut altered = old.clone();
        altered.signed["generated_at"] = (now - chrono::Duration::minutes(2))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            .into();
        assert!(verify(&altered, &approved, false, now).is_err());
        ingest(&renewed, &approved, now).unwrap();
        verify(&cached().unwrap(), &approved, true, now).unwrap();
        assert_eq!(cached().unwrap().signature.key_id, "current-b");
        let (rollback, _) = signed(-4, serde_json::json!([]));
        assert!(ingest(&resign_b(rollback), &approved, now).is_err());
    }
    #[tokio::test]
    async fn polls_new_revocations_coalesces_and_bounds_offline_retries() {
        let (old, trust) = signed(-2, serde_json::json!([]));
        let now = Utc::now();
        ingest(&old, &trust, now).unwrap();
        assert!(enforce_cached("midnight", "1.0.0", &"a".repeat(64), true, &trust).is_ok());
        let (new, _) = signed(
            -1,
            serde_json::json!([{"theme_id":"midnight","reason":"revoked"}]),
        );
        let bytes = serde_json::to_vec(&new).unwrap();
        let state = std::sync::Arc::new(tokio::sync::Mutex::new(RefreshState::default()));
        let requested = std::time::Instant::now();
        let calls = std::cell::Cell::new(0);
        let fetch = || async {
            calls.set(calls.get() + 1);
            tokio::task::yield_now().await;
            Ok(bytes.clone())
        };
        // A still-cryptographically-valid disk cache never suppresses startup polling.
        let (first, second) = tokio::join!(
            refresh_with(false, &trust, state.clone(), requested, now, fetch),
            refresh_with(true, &trust, state.clone(), requested, now, fetch),
        );
        assert!(first.unwrap().is_none());
        assert!(second.unwrap().is_none());
        assert_eq!(calls.get(), 1);
        assert!(enforce_cached("midnight", "1.0.0", &"a".repeat(64), true, &trust).is_err());
        // A bounded cadence discovers subsequent policy while the old signature remains current.
        let due = requested + POLL_CADENCE + std::time::Duration::from_secs(1);
        let offline = || {
            calls.set(calls.get() + 1);
            std::future::ready(Err(unavailable("offline")))
        };
        assert!(
            refresh_with(false, &trust, state.clone(), due, now, offline)
                .await
                .unwrap()
                .unwrap()
                .contains("offline")
        );
        assert_eq!(calls.get(), 2);
        assert!(refresh_with(true, &trust, state.clone(), due, now, offline)
            .await
            .unwrap()
            .unwrap()
            .contains("current verified offline"));
        assert_eq!(
            calls.get(),
            2,
            "forced hot requests still respect retry backoff"
        );
        assert!(
            refresh_with(
                false,
                &trust,
                state,
                due,
                now + chrono::Duration::hours(2),
                offline
            )
            .await
            .is_err(),
            "expired offline cache fails closed even during backoff"
        );
    }
    #[test]
    fn polling_locks_are_per_storage_root() {
        let root = storage::root();
        let same = refresh_state(root.clone()).unwrap();
        assert!(std::sync::Arc::ptr_eq(
            &same,
            &refresh_state(root.clone()).unwrap()
        ));
        assert!(!std::sync::Arc::ptr_eq(
            &same,
            &refresh_state(root.join("another-root")).unwrap()
        ));
    }
    #[test]
    fn cadence_and_backoff_are_independent_from_signature_expiry() {
        let at = std::time::Instant::now();
        let state = RefreshState {
            completed: Some(at),
            failure: None,
            ..Default::default()
        };
        assert!(!state.needs_poll(false, at + POLL_CADENCE - std::time::Duration::from_secs(1)));
        assert!(state.needs_poll(false, at + POLL_CADENCE));
        let failed = RefreshState {
            completed: Some(at),
            failure: Some("offline".into()),
            ..Default::default()
        };
        assert!(!failed.needs_poll(true, at + RETRY_BACKOFF - std::time::Duration::from_secs(1)));
        assert!(failed.needs_poll(false, at + RETRY_BACKOFF));
    }
    #[test]
    fn near_limit_payload_accepts_separate_signed_envelope_overhead() {
        let entries: Vec<Value> = (0..1024)
            .map(|n| {
                serde_json::json!({
                    "theme_id":format!("theme-{n:04}"), "reason":"r".repeat(900)
                })
            })
            .collect();
        let (mut envelope, trust) = signed(-1, serde_json::json!(entries));
        let target = cadencr_registry_core::MAX_THEME_BLOCKLIST_BYTES - 64;
        let mut remaining =
            target - cadencr_registry_core::canonical_json_bytes(&envelope.signed).len();
        for entry in envelope.signed["entries"].as_array_mut().unwrap() {
            let amount = remaining.min(124);
            entry["reason"] = "r".repeat(900 + amount).into();
            remaining -= amount;
        }
        assert_eq!(remaining, 0);
        let key = SigningKey::from_bytes(&[19; 32]);
        envelope.signature.value = base64::engine::general_purpose::STANDARD.encode(
            key.sign(&cadencr_registry_core::canonical_json_bytes(
                &envelope.signed,
            ))
            .to_bytes(),
        );
        let bytes = serde_json::to_vec(&envelope).unwrap();
        assert!(bytes.len() > cadencr_registry_core::MAX_THEME_BLOCKLIST_BYTES);
        assert!(bytes.len() <= MAX_POLICY_BYTES);
        verify(&parse(&bytes).unwrap(), &trust, true, Utc::now()).unwrap();
        assert!(parse(&vec![b' '; MAX_POLICY_BYTES + 1]).is_err());
    }
    #[test]
    fn signature_scope_matching_expiry_and_original_bytes_are_enforced() {
        let (envelope, trust) = signed(
            -1,
            serde_json::json!([
                {"theme_id":"digest","archive_sha256":"a".repeat(64),"reason":"bad artifact"},
                {"theme_id":"global","reason":"removed"},
                {"theme_id":"versions","version_requirement":"<2.0.0","reason":"unsafe"}
            ]),
        );
        let verified = verify(&envelope, &trust, true, Utc::now()).unwrap();
        assert!(enforce_verified(&verified, "global", "3.0.0", "b").is_err());
        assert!(enforce_verified(&verified, "versions", "1.0.0", "b").is_err());
        assert!(enforce_verified(&verified, "versions", "2.0.0", "b").is_ok());
        assert!(enforce_verified(&verified, "digest", "1.0.0", &"a".repeat(64)).is_err());
        assert!(enforce_verified(&verified, "digest", "1.0.0", &"b".repeat(64)).is_ok());
        let mut tampered = envelope.clone();
        tampered.signed["entries"][0]["reason"] = "changed".into();
        assert!(verify(&tampered, &trust, true, Utc::now()).is_err());
        assert!(verify(&envelope, &ManagedTrustStore::default(), true, Utc::now()).is_err());
        assert!(verify(
            &envelope,
            &trust,
            true,
            Utc::now() + chrono::Duration::hours(2)
        )
        .is_err());
        assert!(verify(
            &envelope,
            &trust,
            false,
            Utc::now() + chrono::Duration::hours(2)
        )
        .is_ok());
        let mut wrong_domain = envelope;
        wrong_domain.signed["kind"] = "provider-blocklist".into();
        assert!(verify(&wrong_domain, &trust, true, Utc::now()).is_err());
    }
    #[tokio::test]
    async fn highwater_missing_corrupt_and_revoked_policy_do_not_prevent_removal() {
        let (envelope, trust) = signed(
            -1,
            serde_json::json!([{"theme_id":"midnight","reason":"unsafe theme"}]),
        );
        assert!(enforce_cached("midnight", "1.0.0", &"a".repeat(64), true, &trust).is_err());
        assert!(enforce_cached("midnight", "1.0.0", &"a".repeat(64), false, &trust).is_err());
        ingest(&envelope, &trust, Utc::now()).unwrap();
        let (older, _) = signed(-2, serde_json::json!([]));
        assert!(ingest(&older, &trust, Utc::now()).is_err());
        let (mut equivocation, _) = signed(-1, serde_json::json!([]));
        equivocation.signed["generated_at"] = envelope.signed["generated_at"].clone();
        let key = SigningKey::from_bytes(&[19; 32]);
        equivocation.signature.value = base64::engine::general_purpose::STANDARD.encode(
            key.sign(&cadencr_registry_core::canonical_json_bytes(
                &equivocation.signed,
            ))
            .to_bytes(),
        );
        assert!(ingest(&equivocation, &trust, Utc::now()).is_err());
        super::super::service::tests::commit_fixture("midnight", "1.0.0");
        crate::domain::settings_store::global_set("theme_current", "managed:midnight")
            .await
            .unwrap();
        assert!(enforce_cached("midnight", "1.0.0", &"a".repeat(64), true, &trust).is_err());
        assert!(
            super::super::service::remove("midnight", true)
                .await
                .unwrap()
                .success
        );
        assert_eq!(
            crate::domain::settings_store::global_get("theme_current").as_deref(),
            Some("cadencr-dark")
        );
        crate::shared::atomic_file::write_atomic_private(&cache(), "broken").unwrap();
        assert!(enforce_cached("midnight", "1.0.0", &"a".repeat(64), true, &trust).is_err());
        assert!(ingest(&envelope, &trust, Utc::now()).is_err());
        #[cfg(unix)]
        {
            std::fs::rename(cache(), cache().with_extension("saved")).unwrap();
            std::os::unix::fs::symlink(storage::root().join("missing-policy"), cache()).unwrap();
            assert!(ingest(&envelope, &trust, Utc::now()).is_err());
            assert!(cache().symlink_metadata().unwrap().file_type().is_symlink());
        }
    }
}
