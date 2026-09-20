use std::collections::HashMap;

use serde_json::{json, Value};

use crate::error::RegistryError;
use crate::index::compare_packages;
use crate::package::{identity, normalized_provider_id};
use crate::signing::validate_signing_payload;

/// A publication index whose immutable schema and canonical bytes have already
/// been validated. Only the time-dependent freshness window is rechecked when
/// it is signed.
pub struct PreparedSigningPayload {
    canonical: Vec<u8>,
    generated_at: String,
    expires_at: String,
}

impl std::fmt::Debug for PreparedSigningPayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedSigningPayload")
            .field("canonical_len", &self.canonical.len())
            .field("generated_at", &self.generated_at)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl PreparedSigningPayload {
    pub fn canonical_payload(&self) -> &[u8] {
        &self.canonical
    }

    pub(crate) fn window(&self) -> (&str, &str) {
        (&self.generated_at, &self.expires_at)
    }
}

/// Prepare the strict in-memory payload used by catalogue publication.
///
/// This adds publication-wide identity and ownership checks without widening
/// the policy accepted by ordinary index validation.
#[bon::builder]
pub fn prepare_publication_index(
    mut packages: Vec<Value>,
    generated_at: &str,
    expires_at: &str,
) -> Result<PreparedSigningPayload, RegistryError> {
    packages.sort_by(compare_packages);
    let payload = json!({
        "schema_version": 1,
        "generated_at": generated_at,
        "expires_at": expires_at,
        "packages": packages,
    });
    let canonical = validate_signing_payload(&payload, false)?;
    validate_catalog_identities(
        payload["packages"]
            .as_array()
            .expect("constructed packages array"),
    )?;
    Ok(PreparedSigningPayload {
        canonical,
        generated_at: generated_at.into(),
        expires_at: expires_at.into(),
    })
}

fn validate_catalog_identities(packages: &[Value]) -> Result<(), RegistryError> {
    let mut normalized = HashMap::<String, String>::new();
    let mut owners = HashMap::<String, String>::new();
    for package in packages {
        let Some((id, _)) = identity(package) else {
            continue;
        };
        let normalized_id = normalized_provider_id(id);
        if let Some(prior) = normalized.get(&normalized_id) {
            if prior != id {
                return Err(RegistryError::single(format!(
                    "provider id {id} collides with {prior} after runtime normalization"
                )));
            }
        } else {
            normalized.insert(normalized_id, id.to_owned());
        }
        let publisher = package
            .pointer("/host/publisher")
            .and_then(Value::as_str)
            .unwrap_or("");
        let repository = package
            .pointer("/agent/repository")
            .and_then(Value::as_str)
            .unwrap_or("");
        let owner = format!("{publisher}\0{repository}");
        if let Some(prior) = owners.get(id) {
            if prior != &owner {
                return Err(RegistryError::single(format!(
                    "provider {id} has conflicting publisher or repository ownership"
                )));
            }
        } else {
            owners.insert(id.to_owned(), owner);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, SecondsFormat, Utc};

    fn package(id: &str, version: &str, publisher: &str, repository: &str) -> Value {
        json!({
            "agent": {
                "id": id, "name": id, "version": version, "description": "test",
                "repository": repository,
                "distribution": {"binary": {"linux-x86_64": {
                    "archive": "https://example.com/provider.tgz", "cmd": "bin/provider",
                    "sha256": "a".repeat(64)
                }}}
            },
            "host": {"publisher": publisher, "compatibility": {"min_app_version": "1.0.0"},
                "assets": {"icon": "icon.png"}}
        })
    }

    fn window() -> (String, String) {
        let generated = Utc::now() - Duration::minutes(1);
        let expires = generated + Duration::days(1);
        (
            generated.to_rfc3339_opts(SecondsFormat::Secs, true),
            expires.to_rfc3339_opts(SecondsFormat::Secs, true),
        )
    }

    fn prepare(packages: Vec<Value>) -> Result<PreparedSigningPayload, RegistryError> {
        let (generated, expires) = window();
        prepare_publication_index()
            .packages(packages)
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
    }

    #[test]
    fn sorts_with_the_normal_index_order() {
        let payload = prepare(vec![
            package("zeta", "1.0.0", "acme", "https://example.com/zeta"),
            package("alpha", "2.0.0", "acme", "https://example.com/alpha"),
            package("alpha", "1.0.0", "acme", "https://example.com/alpha"),
        ])
        .unwrap();
        let decoded: Value = serde_json::from_slice(payload.canonical_payload()).unwrap();
        let identities = decoded["packages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| identity(value).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            identities,
            vec![("alpha", "1.0.0"), ("alpha", "2.0.0"), ("zeta", "1.0.0")]
        );
    }

    #[test]
    fn accepts_the_javascript_registry_package_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        ))
        .unwrap();
        let payload = prepare(vec![fixture]).unwrap();
        let payload: Value = serde_json::from_slice(payload.canonical_payload()).unwrap();
        assert_eq!(payload["packages"][0]["agent"]["id"], "example-provider");
    }

    #[test]
    fn rejects_duplicate_normalized_and_owner_conflicts() {
        let duplicate = package("alpha", "1.0.0", "acme", "https://example.com/alpha");
        assert!(prepare(vec![duplicate.clone(), duplicate])
            .unwrap_err()
            .to_string()
            .contains("duplicate id@version"));
        assert!(prepare(vec![
            package("alpha-beta", "1.0.0", "acme", "https://example.com/a"),
            package("alphabeta", "1.0.0", "acme", "https://example.com/b"),
        ])
        .unwrap_err()
        .to_string()
        .contains("runtime normalization"));
        assert!(prepare(vec![
            package("alpha", "1.0.0", "acme", "https://example.com/a"),
            package("alpha", "2.0.0", "other", "https://example.com/a"),
        ])
        .unwrap_err()
        .to_string()
        .contains("conflicting publisher or repository"));
    }

    #[test]
    fn applies_strict_signing_timestamp_policy() {
        let mut generated = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let expires = (Utc::now() + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let error = prepare_publication_index()
            .packages(vec![package(
                "alpha",
                "1.0.0",
                "acme",
                "https://example.com/a",
            )])
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
            .unwrap_err();
        assert!(error.to_string().contains("canonical UTC whole-second"));
        generated = "2020-01-01T00:00:00Z".into();
        let error = prepare_publication_index()
            .packages(vec![package(
                "alpha",
                "1.0.0",
                "acme",
                "https://example.com/a",
            )])
            .generated_at(&generated)
            .expires_at("2020-01-02T00:00:00Z")
            .call()
            .unwrap_err();
        assert!(error.to_string().contains("expired"));
    }

    #[test]
    fn rejects_canonical_payloads_over_32_mib() {
        let mut oversized = package("alpha", "1.0.0", "acme", "https://example.com/alpha");
        oversized["agent"]["name"] = Value::String("x".repeat(32 * 1024 * 1024 + 1));
        assert!(prepare(vec![oversized])
            .unwrap_err()
            .to_string()
            .contains("32 MiB"));
    }

    #[test]
    fn prepared_bytes_keep_javascript_binary64_canonicalization() {
        let mut value = package("alpha", "1.0.0", "acme", "https://example.com/alpha");
        value["agent"]["future_number"] = json!(9_007_199_254_740_993_u64);
        let prepared = prepare(vec![value]).unwrap();
        let document = String::from_utf8(prepared.canonical_payload().to_vec()).unwrap();
        assert!(document.contains("9007199254740992"));
        assert!(!document.contains("9007199254740993"));
    }
}
