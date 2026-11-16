use super::{bad, records, ProviderHandoff};
use crate::RegistryError;
use serde_json::Value;

pub(crate) fn validate_payload(payload: &Value) -> Result<Vec<ProviderHandoff>, RegistryError> {
    let records = records(payload)?;
    let packages = payload["packages"]
        .as_array()
        .ok_or_else(|| bad("missing packages"))?;
    if !records.is_empty() {
        crate::catalog::validate_catalog_collisions(packages)?;
        crate::plugin_package::validate_member_ownership(packages)?;
    }
    for record in &records {
        for version in record.retired_versions.keys() {
            if !packages.iter().any(|p| {
                crate::package::identity(p) == Some((record.provider_id.as_str(), version.as_str()))
            }) {
                return Err(bad(
                    "handoff must preserve every retired package in signed history",
                ));
            }
        }
        for package in crate::plugin_package::identity_units(packages) {
            record.check_package(package, true)?;
        }
    }
    Ok(records)
}

pub(crate) fn active_packages(payload: &Value) -> Result<Vec<&Value>, RegistryError> {
    let records = records(payload)?;
    Ok(payload["packages"]
        .as_array()
        .expect("validated packages")
        .iter()
        .filter(|p| !records.iter().any(|record| record.retires(p)))
        .collect())
}

pub(crate) fn continuity(previous: &Value, candidate: &Value) -> Result<(), RegistryError> {
    let before = records(previous)?;
    let after = validate_payload(candidate)?;
    if !after.starts_with(&before) {
        return Err(bad("signed provider handoff history is append-only"));
    }
    for record in &after[before.len()..] {
        let prior: Vec<_> = previous["packages"]
            .as_array()
            .expect("verified packages")
            .iter()
            .filter(|p| crate::package::identity(p).is_some_and(|(id, _)| id == record.provider_id))
            .collect();
        if prior.is_empty() || prior.len() != record.retired_versions.len() {
            return Err(bad(
                "handoff must retire all previously signed versions of an existing provider",
            ));
        }
        for package in prior {
            if !record.retires(package) {
                return Err(bad("handoff omits a previous provider version"));
            }
            if previous["schema_version"] == 1 && candidate["schema_version"] == 2 {
                let upgraded = serde_json::json!({"kind": "provider", "package": package});
                record.check_package(&upgraded, true)?;
            } else {
                record.check_package(package, true)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{canonical_json_bytes, provider_package_is_retired};
    use chrono::{Duration, SecondsFormat, Utc};
    use serde_json::json;

    const PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n";
    const PUBLIC: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n";

    fn package(version: &str, publisher: &str) -> Value {
        let mut p: Value = serde_json::from_str(include_str!(
            "../../../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        ))
        .unwrap();
        p["agent"]["id"] = json!("pi");
        p["agent"]["version"] = json!(version);
        p["agent"]["repository"] = json!(format!("https://github.com/{publisher}/pi"));
        p["host"]["publisher"] = json!(publisher);
        json!({"kind":"provider","package":p})
    }

    fn record(old: &Value) -> ProviderHandoff {
        serde_json::from_value(json!({"provider_id":"pi",
            "from":{"publisher":"original","repository":"https://github.com/original/pi"},
            "to":{"publisher":"edjubert","repository":"https://github.com/edjubert/pi"},
            "retired_versions":{"0.4.1":crate::digest::sha256_hex(&canonical_json_bytes(old))},
            "authorization":"https://github.com/owner/registry/pull/22#issuecomment-1",
            "reason":"Retire first-party connector; retain installed state and require new conversations."})).unwrap()
    }

    fn payload(packages: Vec<Value>, records: Vec<ProviderHandoff>, minutes: i64) -> Value {
        let now = Utc::now() - Duration::minutes(minutes);
        let prepared = crate::prepare_publication_index()
            .schema_version(2)
            .packages(packages)
            .provider_handoffs(records)
            .generated_at(&now.to_rfc3339_opts(SecondsFormat::Secs, true))
            .expires_at(&(now + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true))
            .call()
            .unwrap();
        serde_json::from_slice(prepared.canonical_payload()).unwrap()
    }

    #[test]
    fn handoff_snapshot_requires_an_authenticated_previous_catalog() {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("private.pem");
        let public = root.path().join("public.pem");
        let previous = root.path().join("previous.json");
        let candidate = root.path().join("candidate.json");
        std::fs::write(&private, PRIVATE).unwrap();
        std::fs::write(&public, PUBLIC).unwrap();
        let old = package("0.4.1", "original");
        let before = payload(vec![old.clone()], vec![], 5);
        let after = payload(vec![old.clone()], vec![record(&old)], 4);
        std::fs::write(
            &previous,
            crate::sign_index_payload(&before, &private, "test-key").unwrap(),
        )
        .unwrap();
        std::fs::write(
            &candidate,
            crate::sign_index_payload(&after, &private, "test-key").unwrap(),
        )
        .unwrap();
        let prepare = |prior| {
            crate::prepare_catalog_snapshot()
                .catalog_file(&candidate)
                .previous(prior)
                .public_key_file(&public)
                .key_id("test-key")
                .repository("owner/registry")
                .registry_commit(&"a".repeat(40))
                .call()
        };
        assert!(prepare(crate::PreviousCatalog::Bootstrap)
            .err()
            .unwrap()
            .to_string()
            .contains("handoff requires an authenticated baseline"));
        assert!(prepare(crate::PreviousCatalog::File(&previous)).is_ok());
        let mut tampered: Value =
            serde_json::from_slice(&std::fs::read(&previous).unwrap()).unwrap();
        tampered["signed"]["packages"][0]["package"]["agent"]["name"] = json!("forged");
        std::fs::write(&previous, serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(prepare(crate::PreviousCatalog::File(&previous)).is_err());
    }

    #[test]
    fn explicit_schema_upgrade_uses_the_preserved_schema_two_retirement_digest() {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("private.pem");
        std::fs::write(&private, PRIVATE).unwrap();
        let old = package("0.4.1", "original");
        let mut previous = payload(vec![old.clone()], vec![], 5);
        previous["schema_version"] = json!(1);
        previous["packages"] = json!([old["package"].clone()]);
        let baseline = crate::sign_index_payload(&previous, &private, "test-key").unwrap();
        let now = Utc::now() - Duration::minutes(4);
        let generated = now.to_rfc3339_opts(SecondsFormat::Secs, true);
        let expires = (now + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let prepare = |records, allow| {
            crate::prepare_incremental_publication_index()
                .previous_bytes(&baseline)
                .public_key_bytes(PUBLIC.as_bytes())
                .key_id("test-key")
                .schema_version(2)
                .allow_schema_upgrade(allow)
                .packages(vec![])
                .provider_handoffs(records)
                .generated_at(&generated)
                .expires_at(&expires)
                .call()
        };
        let good = record(&old);
        let prepared = prepare(vec![good.clone()], true).unwrap();
        let value: Value = serde_json::from_slice(prepared.canonical_payload()).unwrap();
        assert_eq!(value["packages"][0], old);
        assert!(prepare(vec![good.clone()], false).is_err());
        let mut wrong = good;
        wrong.retired_versions.insert(
            "0.4.1".into(),
            crate::digest::sha256_hex(&canonical_json_bytes(&old["package"])),
        );
        assert!(prepare(vec![wrong], true).is_err());
    }

    #[test]
    fn retirement_destination_obeys_the_reserved_publisher_rule() {
        let old = package("0.4.1", "original");
        for publisher in ["cadencr", "Cadencr", "CADENCR"] {
            let mut handoff = record(&old);
            handoff.to.publisher = publisher.into();
            handoff.to.repository = "https://github.com/acme/pi".into();
            assert!(super::super::validate_records(&[handoff.clone()])
                .unwrap_err()
                .to_string()
                .contains("reserved"));
            handoff.to.repository = "https://github.com/Merkr-Software/pi".into();
            super::super::validate_records(&[handoff]).unwrap();
        }
    }

    #[test]
    fn signed_retirement_successor_and_renewal_preserve_exact_history() {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("key.pem");
        std::fs::write(&private, PRIVATE).unwrap();
        let old = package("0.4.1", "original");
        let previous = payload(vec![old.clone()], vec![], 5);
        let mut baseline = crate::sign_index_payload(&previous, &private, "test-key").unwrap();
        let record = record(&old);
        for (minutes, packages, records) in [
            (4, vec![], vec![record.clone()]),
            (3, vec![package("0.5.0", "edjubert")], vec![]),
            (2, vec![], vec![]),
        ] {
            let now = Utc::now() - Duration::minutes(minutes);
            let prepared = crate::prepare_incremental_publication_index()
                .previous_bytes(&baseline)
                .public_key_bytes(PUBLIC.as_bytes())
                .key_id("test-key")
                .schema_version(2)
                .packages(packages)
                .provider_handoffs(records)
                .generated_at(&now.to_rfc3339_opts(SecondsFormat::Secs, true))
                .expires_at(&(now + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true))
                .call()
                .unwrap();
            let candidate: Value = serde_json::from_slice(prepared.canonical_payload()).unwrap();
            assert_eq!(candidate["packages"][0], old);
            assert_eq!(candidate["provider_handoffs"], json!([record]));
            assert!(provider_package_is_retired(&candidate, &old).unwrap());
            assert_eq!(
                active_packages(&candidate).unwrap().len(),
                usize::from(minutes < 4)
            );
            baseline = crate::sign_prepared_index(prepared, &private, "test-key").unwrap();
        }
        let envelope: Value = serde_json::from_slice(&baseline).unwrap();
        let public = root.path().join("public.pem");
        std::fs::write(&public, PUBLIC).unwrap();
        let signed = root.path().join("catalog.json");
        std::fs::write(&signed, &baseline).unwrap();
        crate::verify_signed_index(&signed, &public, "test-key", false).unwrap();
        assert_eq!(envelope["signed"]["packages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn handoff_cannot_move_a_retired_standalone_identity_into_a_plugin() {
        let old = package("0.4.1", "original");
        let successor = package("0.5.0", "edjubert");
        let record = record(&old);
        let mut plugin = crate::plugin_package::tests::plugin("0.5.0");
        plugin["package"]["plugin"]["repository"] =
            successor["package"]["agent"]["repository"].clone();
        plugin["package"]["host"] = json!({
            "publisher": "edjubert",
            "compatibility": successor["package"]["host"]["compatibility"].clone()
        });
        plugin["package"]["contributes"] = json!([successor]);
        crate::validate_marketplace_package(&plugin).unwrap();
        let now = Utc::now() - Duration::minutes(1);
        let result = crate::prepare_publication_index()
            .schema_version(2)
            .packages(vec![old, plugin])
            .provider_handoffs(vec![record])
            .generated_at(&now.to_rfc3339_opts(SecondsFormat::Secs, true))
            .expires_at(&(now + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true))
            .call();
        assert!(result.unwrap_err().to_string().contains("member of plugin"));
    }

    #[test]
    fn handoff_is_exact_append_only_and_cannot_authorize_unrelated_changes() {
        let old = package("0.4.1", "original");
        let next = package("0.5.0", "edjubert");
        let record = record(&old);
        let previous = payload(vec![old.clone()], vec![], 5);
        let candidate = payload(vec![old.clone(), next], vec![record], 4);
        crate::validate_catalog_continuity(&previous, &candidate).unwrap();
        for mutation in 0..9 {
            let mut bad = candidate.clone();
            match mutation {
                0 => bad["packages"].as_array_mut().unwrap().remove(0),
                1 => {
                    bad["packages"][0]["package"]["agent"]["name"] = json!("changed");
                    Value::Null
                }
                2 => {
                    bad["provider_handoffs"][0]["retired_versions"]["0.4.1"] =
                        json!("0".repeat(64));
                    Value::Null
                }
                3 => {
                    bad["packages"][1]["package"]["host"]["publisher"] = json!("mallory");
                    Value::Null
                }
                4 => {
                    bad["packages"][1]["package"]["agent"]["repository"] =
                        json!("https://github.com/mallory/pi");
                    Value::Null
                }
                5 => {
                    bad["packages"][1]["package"]["agent"]["version"] = json!("0.4.0");
                    Value::Null
                }
                6 => {
                    bad["provider_handoffs"][0]["from"]["publisher"] = json!("mallory");
                    Value::Null
                }
                7 => {
                    bad["provider_handoffs"][0]["retired_versions"]["0.4.0"] =
                        json!("0".repeat(64));
                    Value::Null
                }
                _ => {
                    bad["provider_handoffs"][0]["unknown"] = json!(true);
                    Value::Null
                }
            };
            assert!(
                crate::validate_catalog_continuity(&previous, &bad).is_err(),
                "mutation {mutation}"
            );
        }
        let mut renewal = candidate.clone();
        renewal["generated_at"] =
            json!((Utc::now() - Duration::minutes(2)).to_rfc3339_opts(SecondsFormat::Secs, true));
        renewal.as_object_mut().unwrap().remove("provider_handoffs");
        assert!(crate::validate_catalog_continuity(&candidate, &renewal).is_err());
        let mut retirement = candidate.clone();
        retirement["packages"].as_array_mut().unwrap().pop();
        assert!(crate::validate_catalog_continuity(&previous, &retirement).is_ok());
    }
}
