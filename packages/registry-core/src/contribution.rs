use crate::{
    diagnostics::Diagnostics,
    marketplace,
    package::{identity, normalized_provider_id, validate_package},
    plugin_package, reserved_publisher,
    submission::validate_submission as validate_submission_diagnostics,
    tree::{load_tree, Tree},
    RegistryError,
};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub(crate) fn validate_contribution(
    base_root: &Path,
    candidate_root: &Path,
    administrative: bool,
) -> Result<(), RegistryError> {
    let mut errors = Diagnostics::default();
    let base = load_tree(base_root, "base", &mut errors);
    let candidate = load_tree(candidate_root, "candidate", &mut errors);
    let (Some(base), Some(candidate)) = (base, candidate) else {
        return Err(RegistryError::from_messages(errors.into_messages()));
    };
    if !errors.is_empty() {
        return Err(RegistryError::from_messages(errors.into_messages()));
    }
    let handoffs = crate::provider_handoff::contribution::prepare(
        base_root,
        candidate_root,
        &base,
        &candidate,
        administrative,
    )?;
    validate_immutable(&base, &candidate, &mut errors);
    validate_candidate(&base, &candidate, &mut errors);
    validate_owners(&base, &candidate, &handoffs, &mut errors);
    validate_collisions(&candidate, &mut errors);
    if let Err(error) = plugin_package::validate_member_ownership(candidate.packages.values()) {
        errors.extend(error.messages().iter().cloned());
    }
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
        } else {
            errors.push(format!("packages/{name}: package identity is required"));
        }
    }
    for (name, submission) in &candidate.submissions {
        if errors.is_full() {
            break;
        }
        let mut submission_errors = Diagnostics::default();
        validate_submission_diagnostics(submission, &mut submission_errors);
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
            errors.push(format!("submissions/{name}: package identity is required"));
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

fn validate_owners(
    base: &Tree,
    candidate: &Tree,
    handoffs: &[crate::ProviderHandoff],
    errors: &mut Diagnostics,
) {
    let mut owners = HashMap::<String, Owner>::new();
    let base_units = plugin_package::identity_units_of(base.packages.values());
    for record in handoffs {
        owners.insert(
            record.provider_id.clone(),
            (
                "provider",
                Some(&record.to.publisher),
                Some(&record.to.repository),
            ),
        );
    }
    for package in base_units {
        if let Some((id, _)) = identity(package) {
            owners.entry(id.into()).or_insert((
                marketplace::kind(package),
                marketplace::body(package)
                    .pointer("/host/publisher")
                    .and_then(serde_json::Value::as_str),
                marketplace::descriptor(package)
                    .get("repository")
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
        if let Some(error) =
            reserved_publisher::package_reserved_publisher_error(package, "host.publisher")
        {
            errors.push(format!("packages/{name}: {error}"));
        }
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
        let source = submission
            .pointer("/source/repository")
            .and_then(serde_json::Value::as_str);
        // A plugin's members own their ids exactly as standalone packages do.
        let units = std::iter::once((id, package)).chain(
            plugin_package::plugin_members(package)
                .iter()
                .filter_map(|member| identity(member).map(|(id, _)| (id, member))),
        );
        for (id, unit) in units {
            let proposed = (
                marketplace::kind(unit),
                marketplace::body(unit)
                    .pointer("/host/publisher")
                    .and_then(serde_json::Value::as_str),
                source,
            );
            check_owner(&mut owners, id, proposed, name, errors);
        }
    }
}

type Owner<'a> = (&'a str, Option<&'a str>, Option<&'a str>);

fn check_owner<'a>(
    owners: &mut HashMap<String, Owner<'a>>,
    id: &str,
    proposed: Owner<'a>,
    name: &str,
    errors: &mut Diagnostics,
) {
    let Some(owner) = owners.get(id) else {
        owners.insert(id.into(), proposed);
        return;
    };
    if proposed.0 != owner.0 {
        errors.push(format!("packages/{name}: package kind is immutable"));
    }
    if proposed.1 != owner.1 {
        errors.push(format!(
            "packages/{name}: host.publisher must remain {:?}",
            owner.1
        ));
    }
    if proposed.2 != owner.2 {
        errors.push(format!(
            "submissions/{name}: source.repository must remain {:?}",
            owner.2
        ));
    }
}

fn validate_collisions(candidate: &Tree, errors: &mut Diagnostics) {
    let mut owners = HashMap::<String, &str>::new();
    let units = candidate.packages.iter().flat_map(|(name, package)| {
        std::iter::once(package)
            .chain(plugin_package::plugin_members(package))
            .map(move |unit| (name, unit))
    });
    for (name, package) in units {
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
