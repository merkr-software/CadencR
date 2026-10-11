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
    option_env!("CADENCR_MANAGED_THEME_BLOCKLIST_URL").filter(|url| !url.trim().is_empty())
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
    trust
        .verify_bytes(prepared.signing.canonical_payload(), &envelope.signature)
        .map_err(unavailable)?;
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
) -> Result<(), AppError> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(unavailable)?;
    let incoming = verify(envelope, trust, true, now)?;
    match cached() {
        Ok(previous) => {
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
    .map_err(unavailable)
}
pub(super) async fn refresh(force: bool) -> Result<(), AppError> {
    let Some(url) = source() else {
        return Ok(());
    };
    static REFRESH_LOCK: std::sync::OnceLock<
        tokio::sync::Mutex<std::collections::HashMap<std::path::PathBuf, std::time::Instant>>,
    > = std::sync::OnceLock::new();
    let requested_at = std::time::Instant::now();
    let mut completed = REFRESH_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
        .await;
    let coalesced = completed
        .get(&cache())
        .is_some_and(|at| *at >= requested_at);
    let trust = pinned_index_trust_store();
    if (!force || coalesced)
        && cached()
            .and_then(|envelope| verify(&envelope, &trust, true, Utc::now()))
            .is_ok()
    {
        return Ok(());
    }
    let result = async {
        let bytes = download::download(url, MAX_POLICY_BYTES)
            .await
            .map_err(unavailable)?;
        ingest(&parse(&bytes)?, &trust, Utc::now())
    }
    .await;
    match result {
        Ok(()) => {
            completed.insert(cache(), std::time::Instant::now());
            Ok(())
        }
        Err(error) => {
            cached()
                .and_then(|envelope| verify(&envelope, &trust, true, Utc::now()))
                .map_err(|cache_error| {
                    unavailable(format!(
                        "{error}; verified theme policy unavailable: {cache_error}"
                    ))
                })?;
            Err(error)
        }
    }
}
pub(super) struct Snapshot(Option<Verified>);
pub(super) fn snapshot() -> Result<Snapshot, AppError> {
    if source().is_none() {
        return Ok(Snapshot(None));
    }
    Ok(Snapshot(Some(verify(
        &cached()?,
        &pinned_index_trust_store(),
        true,
        Utc::now(),
    )?)))
}
impl Snapshot {
    pub(super) fn enforce(&self, id: &str, version: &str, digest: &str) -> Result<(), AppError> {
        match &self.0 {
            Some(policy) => enforce_verified(policy, id, version, digest),
            None => Ok(()),
        }
    }
}
pub(super) fn enforce(id: &str, version: &str, digest: &str) -> Result<(), AppError> {
    enforce_cached(
        id,
        version,
        digest,
        source().is_some(),
        &pinned_index_trust_store(),
    )
}
fn enforce_cached(
    id: &str,
    version: &str,
    digest: &str,
    required: bool,
    trust: &ManagedTrustStore,
) -> Result<(), AppError> {
    if !required {
        return Ok(());
    }
    let verified = verify(&cached()?, trust, true, Utc::now())?;
    enforce_verified(&verified, id, version, digest)
}
fn enforce_verified(
    policy: &Verified,
    id: &str,
    version: &str,
    digest: &str,
) -> Result<(), AppError> {
    let expires_at =
        DateTime::parse_from_rfc3339(&policy.policy.expires_at).map_err(unavailable)?;
    if expires_at <= Utc::now() {
        return Err(unavailable("theme revocation policy expired"));
    }
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
mod tests {
    use super::*;
    use crate::domain::agents::providers::installed::managed::trust::TrustedIndexKey;
    use base64::Engine as _;
    use ed25519_dalek::{Signer as _, SigningKey};
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
        assert!(enforce_cached("midnight", "1.0.0", &"a".repeat(64), false, &trust).is_ok());
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
