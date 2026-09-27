mod archive;
mod catalog;
mod diagnostics;
mod error;
mod index;
mod json;
mod package;
mod publication_plan;
mod safe_io;
mod signing;
mod snapshot;
mod submission;
mod tree;

use std::collections::{HashMap, HashSet};
use std::path::Path;

pub use archive::{
    pack_archive, pack_provider, PackProviderRequest, PackSpec, PackedArchive, PackedProvider,
};
pub use catalog::{prepare_publication_index, PreparedSigningPayload};
pub use error::RegistryError;
pub use index::build_index;
pub use json::{canonical_json_bytes, parse_json as parse_json_bytes};
pub use publication_plan::{
    create_publication_plan, create_publication_plan_from_file, valid_publication_repository,
};
pub use signing::{
    assemble_signed_index, sign_index, sign_index_payload, sign_prepared_index,
    validate_signing_key_id, verify_signed_index,
};
pub use snapshot::{prepare_catalog_snapshot, CatalogSnapshot, PreviousCatalog};

use diagnostics::Diagnostics;
use package::{identity, normalized_provider_id, validate_package};
use submission::validate_submission;
use tree::{load_tree, Tree};

pub fn validate_contribution(base: &Path, candidate: &Path) -> Result<(), RegistryError> {
    let mut errors = Diagnostics::default();
    let base = load_tree(base, "base", &mut errors);
    let candidate = load_tree(candidate, "candidate", &mut errors);
    let (Some(base), Some(candidate)) = (base, candidate) else {
        return Err(RegistryError::from_messages(errors.into_messages()));
    };
    if !errors.is_empty() {
        return Err(RegistryError::from_messages(errors.into_messages()));
    }
    validate_immutable(&base, &candidate, &mut errors);
    validate_candidate(&base, &candidate, &mut errors);
    validate_owners(&base, &candidate, &mut errors);
    validate_collisions(&candidate, &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(RegistryError::from_messages(errors.into_messages()))
    }
}

fn validate_immutable(base: &Tree, candidate: &Tree, errors: &mut Diagnostics) {
    for (kind, before, after) in [
        ("package", &base.packages, &candidate.packages),
        ("submission", &base.submissions, &candidate.submissions),
    ] {
        for (name, value) in before {
            match after.get(name) {
                None => errors.push(format!("{kind}s/{name}: deletion is not allowed")),
                Some(next) if value != next => {
                    errors.push(format!("{kind}s/{name}: existing {kind}s are immutable"))
                }
                Some(_) => {}
            }
        }
    }
}

fn validate_candidate(base: &Tree, candidate: &Tree, errors: &mut Diagnostics) {
    for (name, package) in &candidate.packages {
        if errors.is_full() {
            break;
        }
        validate_package(package, &format!("candidate packages/{name}"), errors);
        if let Some((id, version)) = identity(package) {
            let expected = format!("{id}-{version}.json");
            if *name != expected {
                errors.push(format!("packages/{name}: filename must be {expected}"));
            }
        }
    }
    for (name, submission) in &candidate.submissions {
        if errors.is_full() {
            break;
        }
        let mut submission_errors = Diagnostics::default();
        validate_submission(submission, &mut submission_errors);
        errors.extend(
            submission_errors
                .into_messages()
                .into_iter()
                .map(|error| format!("submissions/{name}: {error}")),
        );
        let Some(package) = submission.get("package") else {
            continue;
        };
        let Some((id, version)) = identity(package) else {
            continue;
        };
        let expected = format!("{id}-{version}.json");
        if *name != expected {
            errors.push(format!("submissions/{name}: filename must be {expected}"));
        }
        match candidate.packages.get(&expected) {
            None => errors.push(format!(
                "submissions/{name}: orphan submission has no packages/{expected}"
            )),
            Some(found) if found != package => errors.push(format!(
                "submissions/{name}: submission.package must exactly match packages/{expected}"
            )),
            Some(_) => {}
        }
        if !base.submissions.contains_key(name) && base.packages.contains_key(name) {
            errors.push(format!("submissions/{name}: retroactive provenance claims for legacy packages are not allowed"));
        }
    }
}

fn validate_owners(base: &Tree, candidate: &Tree, errors: &mut Diagnostics) {
    let mut owners = HashMap::<String, (Option<&str>, Option<&str>)>::new();
    for package in base.packages.values() {
        if let Some((id, _)) = identity(package) {
            owners.entry(id.into()).or_insert((
                package
                    .pointer("/host/publisher")
                    .and_then(serde_json::Value::as_str),
                package
                    .pointer("/agent/repository")
                    .and_then(serde_json::Value::as_str),
            ));
        }
    }
    let base_ids = base
        .packages
        .values()
        .filter_map(identity)
        .map(|(id, version)| format!("{id}\0{version}"))
        .collect::<HashSet<_>>();
    for (name, package) in &candidate.packages {
        if errors.is_full() {
            break;
        }
        if base.packages.contains_key(name) {
            continue;
        }
        let Some((id, version)) = identity(package) else {
            continue;
        };
        let Some(submission) = candidate.submissions.get(name) else {
            errors.push(format!(
                "packages/{name}: new package versions require submissions/{name}"
            ));
            continue;
        };
        if base_ids.contains(&format!("{id}\0{version}")) {
            errors.push(format!("submissions/{name}: retroactive provenance claims for legacy packages are not allowed"));
            continue;
        }
        let proposed = (
            package
                .pointer("/host/publisher")
                .and_then(serde_json::Value::as_str),
            submission
                .pointer("/source/repository")
                .and_then(serde_json::Value::as_str),
        );
        if let Some(owner) = owners.get(id) {
            if proposed.0 != owner.0 {
                errors.push(format!(
                    "packages/{name}: host.publisher must remain {:?}",
                    owner.0
                ));
            }
            if proposed.1 != owner.1 {
                errors.push(format!(
                    "submissions/{name}: source.repository must remain {:?}",
                    owner.1
                ));
            }
        } else {
            owners.insert(id.into(), proposed);
        }
    }
}

fn validate_collisions(candidate: &Tree, errors: &mut Diagnostics) {
    let mut owners = HashMap::<String, &str>::new();
    for (name, package) in &candidate.packages {
        if errors.is_full() {
            break;
        }
        let Some((id, _)) = identity(package) else {
            continue;
        };
        let key = normalized_provider_id(id);
        if let Some(prior) = owners.get(&key) {
            if *prior != id {
                errors.push(format!("packages/{name}: provider id {id:?} collides with {prior:?} after runtime normalization"));
            }
        } else {
            owners.insert(key, id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::canonical_json;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_object_keys_recursively() {
        assert_eq!(
            canonical_json(&json!({"z": 1, "a": {"y": 2, "b": 3}})),
            r#"{"a":{"b":3,"y":2},"z":1}"#
        );
    }

    #[test]
    fn rejects_symlinked_package_directory() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let candidate = root.path().join("candidate");
        std::fs::create_dir_all(base.join("packages")).unwrap();
        std::fs::create_dir_all(candidate.join("real")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(candidate.join("real"), candidate.join("packages")).unwrap();
        let error = validate_contribution(&base, &candidate).unwrap_err();
        assert!(error.to_string().contains("real directory"));
    }

    #[test]
    fn contribution_caps_adversarial_package_diagnostics() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let candidate = root.path().join("candidate");
        std::fs::create_dir_all(base.join("packages")).unwrap();
        std::fs::create_dir_all(candidate.join("packages")).unwrap();
        let mut agent = serde_json::Map::new();
        for index in 0..10_000 {
            agent.insert(format!("field{index}token"), json!(true));
        }
        let package = json!({"agent": agent, "host": {}});
        std::fs::write(
            candidate.join("packages/adversarial.json"),
            serde_json::to_vec(&package).unwrap(),
        )
        .unwrap();
        let error = validate_contribution(&base, &candidate).unwrap_err();
        assert!(error.messages().len() <= 256);
        assert!(error.to_string().len() <= 64 * 1024);
        assert_eq!(
            error.messages().last().unwrap(),
            "additional validation errors omitted"
        );
    }
}
