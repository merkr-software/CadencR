/// Maximum serialized signed catalog, including signature envelope and trailing newline.
/// Request/submission limits are separate; cache wrappers may add bounded metadata.
pub const MAX_CATALOG_BYTES: usize = 32 * 1024 * 1024;

mod archive;
mod blocklist;
pub use blocklist::{Blocklist, PreparedBlocklist};
mod catalog;
mod diagnostics;
mod digest;
mod discovery;
mod error;
mod gzip;
mod index;
mod marketplace;
mod metadata;
pub use marketplace::theme_distribution_repository;
pub use metadata::{check_metadata_expiry, validate_metadata_file, validate_submission_file};
mod marketplace_plan;
pub use marketplace_plan::{plugin_web_archive_kind, split_plugin_target};
mod lsp;
mod lsp_types;
mod marketplace_types;
pub use lsp::{
    pack_lsp, read_lsp_archive, signed_lsp_target, validate_lsp_entry, PackLspRequest, PackedLsp,
    MAX_LSP_ARCHIVE_BYTES, MAX_LSP_UNCOMPRESSED_BYTES,
};
pub use lsp_types::{
    LspDescriptor, LspDistribution, LspLanguage, LspPackage, LspRole, LspRuntime, LspTarget,
};
mod plugin_package;
pub use marketplace::{
    marketplace_package_identity, marketplace_package_kind, valid_theme_id,
    validate_marketplace_package,
};
pub use marketplace_types::{
    parse_marketplace_package, MarketplaceAssets, MarketplaceCompatibility, MarketplaceHost,
    MarketplacePackage, PluginDescriptor, PluginPackage, ProviderPackage, TabBackendDescriptor,
    TabBinaryTarget, TabDescriptor, TabDistribution, TabPackage, ThemeDescriptor,
    ThemeDistribution, ThemePackage,
};
pub use plugin_package::{
    catalog_members, plugin_members, valid_plugin_id, MAX_PLUGIN_MEMBERS, PLUGIN_KIND,
    PLUGIN_MEMBER_KINDS,
};
mod json;
mod package;
mod pipeline_preflight;
mod policy;
pub use policy::{authenticate_policy, AuthenticatedPolicy, PolicyKind};
mod policy_renewal;
pub use policy_renewal::{renew_policy, RenewPolicyRequest};
mod provider_blocklist;
mod publication_plan;
mod release_archive;
mod reserved_publisher;
#[cfg(test)]
mod test_keys;
pub use release_archive::{parse_github_release_archive_url, GitHubReleaseArchive};
mod safe_io;
mod signing;
mod snapshot;
mod submission;
#[cfg(test)]
mod tab_marketplace;
mod theme_blocklist;
pub use theme_blocklist::{
    prepare_theme_blocklist, PreparedThemeBlocklist, ThemeBlocklist, ThemeBlocklistEntry,
    MAX_SIGNED_THEME_BLOCKLIST_BYTES, MAX_THEME_BLOCKLIST_BYTES,
};
mod tab_archive;
pub use tab_archive::{
    pack_tab, read_tab_archive_bytes, snapshot_tab_folder, validate_tab_files,
    validate_tab_package_binding, validate_tab_package_files, verify_tab_archive, PackTabRequest,
    PackedTab, MAX_TAB_BYTES,
};
mod tab_backend;
pub use tab_backend::{
    pack_tab_backend, plan_target_platform, read_tab_backend_archive, signed_tab_backend,
    PackTabBackendRequest, PackedTabBackend, SignedTabBackend, SignedTabBinary, TabBackendRefusal,
    MAX_TAB_BACKEND_ARCHIVE_BYTES, MAX_TAB_BACKEND_EXECUTABLE_BYTES, TAB_BINARY_FIELDS,
};
mod lsp_blocklist;
pub use lsp_blocklist::{
    prepare_lsp_blocklist, LspBlocklist, LspBlocklistEntry, PreparedLspBlocklist,
    MAX_LSP_BLOCKLIST_BYTES, MAX_SIGNED_LSP_BLOCKLIST_BYTES,
};
mod tab_blocklist;
pub use tab_blocklist::{
    prepare_tab_blocklist, PreparedTabBlocklist, TabBlocklist, TabBlocklistEntry,
    MAX_SIGNED_TAB_BLOCKLIST_BYTES, MAX_TAB_BLOCKLIST_BYTES,
};
mod theme_archive;
mod theme_verify;
pub use theme_verify::{read_theme_archive, read_theme_archive_bytes, verify_theme_archive};
mod tree;
pub use theme_archive::{pack_theme, PackThemeRequest, PackedTheme};
mod trust;
pub use trust::{
    decode_registry_public_key, sign_registry_trust_manifest, verify_registry_trust_manifest,
    CatalogTrustPurpose, RegistryTrustFiles, RegistryTrustKey, RegistryTrustManifest,
    SignedRegistryTrustManifest, VerifiedRegistryTrust, MAX_TRUST_MANIFEST_BYTES,
};

use std::collections::{HashMap, HashSet};
use std::path::Path;

pub use archive::{
    pack_archive, pack_provider, PackProviderRequest, PackSpec, PackedArchive, PackedProvider,
};
pub use catalog::{
    prepare_incremental_publication_index, prepare_publication_index, verify_publication_baseline,
    PreparedSigningPayload,
};
pub use discovery::{
    assess_discovery_head, discovery_object_url, discovery_url, validate_discovery_branch,
    DISCOVERY_FILENAME, MAX_DISCOVERY_BYTES,
};
pub use error::RegistryError;
pub use index::build_index;
pub use json::{canonical_json_bytes, parse_json as parse_json_bytes};
pub use pipeline_preflight::{preflight_publication_pipeline, sign_prepared_index_pinned};
pub use publication_plan::{
    create_publication_plan, create_publication_plan_from_file, valid_publication_repository,
};
pub use signing::{
    assemble_signed_index, sign_index, sign_index_payload, sign_prepared_index,
    validate_catalog_payload_at, validate_signing_key_id, verify_signed_index,
};
pub use snapshot::{prepare_catalog_snapshot, CatalogSnapshot, PreviousCatalog};

use diagnostics::Diagnostics;
use package::{identity, normalized_provider_id, validate_package};
use submission::validate_submission as validate_submission_diagnostics;

pub fn validate_submission(value: &serde_json::Value) -> Result<(), RegistryError> {
    let mut errors = Diagnostics::default();
    validate_submission_diagnostics(value, &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(RegistryError::from_messages(errors.into_messages()))
    }
}
use tree::{load_tree, Tree};

/// Check authenticated catalog history without changing either signed payload.
/// The caller establishes signature trust separately; this boundary validates
/// shapes first, as the app consumes them (a tab backend for an unknown
/// platform or protocol is not installable, not invalid).
pub fn validate_catalog_continuity(
    previous: &serde_json::Value,
    candidate: &serde_json::Value,
) -> Result<(), RegistryError> {
    let consume = marketplace::Rules::Consume;
    index::validate_index_with(previous, chrono::Utc::now(), true, consume)?;
    index::validate_index_with(candidate, chrono::Utc::now(), true, consume)?;
    snapshot::continuity::validate_continuity(previous, candidate)
}

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

fn validate_owners(base: &Tree, candidate: &Tree, errors: &mut Diagnostics) {
    let mut owners = HashMap::<String, Owner>::new();
    let base_units = plugin_package::identity_units_of(base.packages.values());
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

pub use signing::{sign_policy, verify_policy};

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

    #[test]
    fn contribution_reserves_the_official_publisher() {
        let package = |publisher: &str, repository: &str| {
            json!({"agent": {"id": "pi", "version": "1.0.0", "repository": repository},
                "host": {"publisher": publisher}})
        };
        for (publisher, repository, reserved) in [
            ("cadencr", "https://github.com/acme/pi", true),
            ("Cadencr", "https://github.com/merkr-software-evil/pi", true),
            ("cadencr", "https://github.com/merkr-software/pi", false),
        ] {
            let root = tempfile::tempdir().unwrap();
            let base = root.path().join("base");
            let candidate = root.path().join("candidate");
            std::fs::create_dir_all(base.join("packages")).unwrap();
            std::fs::create_dir_all(candidate.join("packages")).unwrap();
            std::fs::write(
                candidate.join("packages/pi-1.0.0.json"),
                serde_json::to_vec(&package(publisher, repository)).unwrap(),
            )
            .unwrap();
            let error = validate_contribution(&base, &candidate)
                .unwrap_err()
                .to_string();
            assert_eq!(
                error.contains(&format!(
                    "packages/pi-1.0.0.json: host.publisher {publisher:?} is reserved for merkr-software repositories"
                )),
                reserved,
                "{publisher} {repository}: {error}"
            );
        }
    }
}
