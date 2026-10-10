//! Startup loading of local provider descriptors.
//!
//! One directory, one `*.json` file per install, read once at startup. There is
//! no hot reload and no download: a descriptor points at an executable the user
//! already selected. Scanning is deterministic (file names sorted) so two boots
//! over the same directory produce the same catalog order, and so "first
//! registration keeps the id" is a stable rule rather than a filesystem race.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::super::registry::provider_identifier_key;
use super::descriptor::ProviderDescriptor;
use super::installation::HostInstallation;
use super::rejection::{DescriptorError, DescriptorRejection, RejectionCode};

const DESCRIPTOR_EXTENSION: &str = "json";

/// Everything one directory scan produced, including what it refused.
#[derive(Debug, Clone, Default)]
pub struct InstalledLoadOutcome {
    pub directory: PathBuf,
    /// Valid descriptors, in scan order. Disabled installs are kept so the user
    /// can still see them; only enabled ones join the registry.
    pub installations: Vec<Arc<HostInstallation>>,
    pub rejections: Vec<DescriptorRejection>,
}

impl InstalledLoadOutcome {
    /// The installs that should join the runtime registry.
    pub fn registrable(&self) -> impl Iterator<Item = &Arc<HostInstallation>> {
        self.installations
            .iter()
            .filter(|installation| installation.enabled())
    }

    /// Emit one log line per outcome. The API surfaces the same data; this
    /// exists so a headless boot still records why a provider is missing.
    pub fn log(&self) {
        for installation in &self.installations {
            match installation.quarantine() {
                None => tracing::info!(
                    provider_id = installation.provider_id(),
                    enabled = installation.enabled(),
                    source = %installation.source_path().display(),
                    "loaded installed ACP provider"
                ),
                Some(quarantine) => tracing::warn!(
                    provider_id = installation.provider_id(),
                    code = quarantine.code.as_str(),
                    source = %installation.source_path().display(),
                    "installed ACP provider quarantined: {}",
                    quarantine.message
                ),
            }
        }
        for rejection in &self.rejections {
            tracing::warn!(
                provider_id = rejection.provider_id.as_deref().unwrap_or("<unknown>"),
                code = rejection.code.as_str(),
                source = %rejection.source_path.display(),
                "rejected provider descriptor: {}",
                rejection.message
            );
        }
    }
}

/// Scan `directory` for descriptors, refusing any public identifier already
/// owned by the built-ins or by an earlier descriptor in the scan. Comparison
/// uses the same normalization as runtime resolution, so an installed `claude`
/// cannot shadow the built-in alias and `acme-agent` conflicts with `acmeagent`.
///
/// A missing directory is the normal case — no installs — not an error.
pub(super) fn load_from_dir<T: AsRef<str>>(
    directory: &Path,
    reserved_ids: &[T],
) -> InstalledLoadOutcome {
    let mut outcome = InstalledLoadOutcome {
        directory: directory.to_path_buf(),
        ..InstalledLoadOutcome::default()
    };
    let paths = descriptor_paths(directory, &mut outcome);
    let mut taken: HashSet<String> = reserved_ids
        .iter()
        .map(|id| provider_identifier_key(id.as_ref()))
        .collect();
    for path in paths {
        match load_one(&path) {
            // Enablement does not enter into it: a disabled descriptor still
            // owns its id, so a collision is refused now rather than becoming a
            // surprise the day the user enables it. It also keeps "is this id
            // registered?" answerable — otherwise a disabled descriptor sharing
            // a built-in's id would look registered because of the built-in.
            Ok(installation)
                if !taken.insert(provider_identifier_key(installation.provider_id())) =>
            {
                outcome.rejections.push(
                    DescriptorRejection::new(
                        &path,
                        RejectionCode::DuplicateProviderId,
                        format!(
                            "provider id {:?} conflicts with a reserved provider identifier; \
                             the first registration keeps the name",
                            installation.provider_id()
                        ),
                    )
                    .with_provider_id(installation.provider_id()),
                );
            }
            Ok(installation) => outcome.installations.push(Arc::new(installation)),
            Err(rejection) => outcome.rejections.push(rejection),
        }
    }
    outcome
}

/// Sorted `*.json` paths. A missing directory yields none; every other read
/// failure is recorded as a rejection so a permissions problem cannot look like
/// "no providers installed".
///
/// Paths are not stat'd here — whatever is wrong with one (a directory, a
/// vanished file, a denied read) surfaces with its real cause when [`load_one`]
/// opens it.
fn descriptor_paths(directory: &Path, outcome: &mut InstalledLoadOutcome) -> Vec<PathBuf> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            outcome.rejections.push(DescriptorRejection::new(
                directory,
                RejectionCode::DescriptorUnreadable,
                format!("could not read the provider descriptor directory: {error}"),
            ));
            return Vec::new();
        }
    };
    let mut paths: Vec<PathBuf> = Vec::new();
    for entry in entries {
        // Recorded rather than filtered away: an entry that silently vanishes
        // from the scan is indistinguishable from one the user never wrote.
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(error) => {
                outcome.rejections.push(DescriptorRejection::new(
                    directory,
                    RejectionCode::DescriptorUnreadable,
                    format!("could not read an entry in the descriptor directory: {error}"),
                ));
                continue;
            }
        };
        if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case(DESCRIPTOR_EXTENSION))
        {
            paths.push(path);
        }
    }
    paths.sort();
    paths
}

/// Parse and validate one descriptor, attributing any failure to this file (and
/// to the id it claimed, once it parsed far enough to claim one).
fn load_one(path: &Path) -> Result<HostInstallation, DescriptorRejection> {
    let raw = std::fs::read_to_string(path).map_err(|error| {
        DescriptorRejection::new(
            path,
            RejectionCode::DescriptorUnreadable,
            format!("could not read descriptor: {error}"),
        )
    })?;
    parse_descriptor(path, &raw).map(|loaded| loaded.installation)
}

pub(super) struct LoadedDescriptor {
    pub descriptor: ProviderDescriptor,
    pub installation: HostInstallation,
}

/// Parse and validate descriptor contents for both startup loading and
/// lifecycle mutations so those paths cannot disagree on schema or identity.
pub(super) fn parse_descriptor(
    path: &Path,
    raw: &str,
) -> Result<LoadedDescriptor, DescriptorRejection> {
    let unattributed = |code, message| DescriptorRejection::new(path, code, message);
    let descriptor: ProviderDescriptor = serde_json::from_str(raw).map_err(|error| {
        // serde already knows which of the two this is: a data error means the
        // JSON parsed but did not fit the descriptor shape.
        let code = if error.is_data() {
            RejectionCode::DescriptorSchemaViolation
        } else {
            RejectionCode::DescriptorInvalidJson
        };
        unattributed(code, format!("could not parse descriptor: {error}"))
    })?;
    let claimed_id = descriptor.agent.id.clone();
    let attribute = |error: DescriptorError| {
        DescriptorRejection::new(path, error.code, error.message)
            .with_provider_id(claimed_id.clone())
    };

    descriptor.validate().map_err(attribute)?;
    check_identity(path, &descriptor.agent.id).map_err(attribute)?;
    let installation =
        HostInstallation::from_descriptor(descriptor.clone(), path).map_err(attribute)?;
    Ok(LoadedDescriptor {
        descriptor,
        installation,
    })
}

/// The file name is how the user manages installs, so it must agree with the
/// identity inside. A mismatch means the directory and the payload disagree
/// about which agent this is, which is exactly the shape a swapped or
/// mis-copied descriptor takes.
fn check_identity(path: &Path, agent_id: &str) -> Result<(), DescriptorError> {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    if stem == agent_id {
        return Ok(());
    }
    Err(DescriptorError::new(
        RejectionCode::DescriptorIdentityMismatch,
        format!(
            "descriptor file {stem:?}.json declares agent id {agent_id:?}; \
             rename the file to {agent_id}.json"
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::super::test_fixtures::{descriptor_json as descriptor, runnable_binary};
    use super::{load_from_dir, RejectionCode};
    use crate::domain::agents::providers::registry::builtin_provider_identifiers;
    use serde_json::json;
    use std::path::Path;

    fn write(dir: &Path, name: &str, value: serde_json::Value) {
        std::fs::write(
            dir.join(name),
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();
    }

    const NO_RESERVED: &[&str] = &[];

    #[test]
    fn a_missing_directory_is_not_an_error() {
        let outcome = load_from_dir(Path::new("/nonexistent/cadencr/providers"), NO_RESERVED);
        assert!(outcome.installations.is_empty());
        assert!(outcome.rejections.is_empty());
    }

    #[test]
    fn loads_valid_descriptors_in_deterministic_order() {
        let dir = tempfile::tempdir().unwrap();
        let bin = runnable_binary(dir.path());
        write(dir.path(), "zeta.json", descriptor("zeta", &bin));
        write(dir.path(), "alpha.json", descriptor("alpha", &bin));
        std::fs::write(dir.path().join("notes.txt"), "ignored").unwrap();

        let outcome = load_from_dir(dir.path(), NO_RESERVED);
        let ids: Vec<&str> = outcome
            .installations
            .iter()
            .map(|installation| installation.provider_id())
            .collect();
        assert_eq!(ids, vec!["alpha", "zeta"]);
        assert!(outcome.rejections.is_empty());
    }

    #[test]
    fn duplicate_ids_keep_the_first_registration_and_report_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let bin = runnable_binary(dir.path());
        write(dir.path(), "cursor.json", descriptor("cursor", &bin));

        let outcome = load_from_dir(dir.path(), &["cursor", "opencode"]);
        assert!(outcome.installations.is_empty());
        assert_eq!(outcome.rejections.len(), 1);
        assert_eq!(
            outcome.rejections[0].code,
            RejectionCode::DuplicateProviderId
        );
        assert_eq!(outcome.rejections[0].provider_id.as_deref(), Some("cursor"));
    }

    #[test]
    fn builtin_aliases_are_reserved_after_normalization_even_when_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let bin = runnable_binary(dir.path());
        write(
            dir.path(),
            "claudecode.json",
            descriptor("claudecode", &bin),
        );
        let mut disabled = descriptor("openai", &bin);
        disabled["installation"]["enabled"] = json!(false);
        write(dir.path(), "openai.json", disabled);

        let outcome = load_from_dir(dir.path(), builtin_provider_identifiers());
        assert!(outcome.installations.is_empty());
        assert_eq!(outcome.rejections.len(), 2);
        assert!(outcome.rejections.iter().all(|rejection| {
            rejection.code == RejectionCode::DuplicateProviderId
                && matches!(
                    rejection.provider_id.as_deref(),
                    Some("claudecode" | "openai")
                )
        }));
    }

    #[test]
    fn a_disabled_install_stays_visible_but_never_registers() {
        let dir = tempfile::tempdir().unwrap();
        let bin = runnable_binary(dir.path());
        let mut disabled = descriptor("acme", &bin);
        disabled["installation"]["enabled"] = json!(false);
        write(dir.path(), "acme.json", disabled);

        let outcome = load_from_dir(dir.path(), NO_RESERVED);
        assert_eq!(outcome.installations.len(), 1);
        assert!(!outcome.installations[0].enabled());
        assert_eq!(outcome.registrable().count(), 0);
        assert!(outcome.rejections.is_empty());
    }

    /// Disabling a descriptor does not release its id. A built-in's id is never
    /// available, and the API must never be able to read a built-in's
    /// registration as this descriptor's.
    #[test]
    fn a_disabled_descriptor_still_cannot_claim_a_taken_id() {
        let dir = tempfile::tempdir().unwrap();
        let bin = runnable_binary(dir.path());
        let mut disabled = descriptor("cursor", &bin);
        disabled["installation"]["enabled"] = json!(false);
        write(dir.path(), "cursor.json", disabled);
        let mut second = descriptor("acme", &bin);
        second["installation"]["enabled"] = json!(false);
        write(dir.path(), "acme.json", second);
        write(
            dir.path(),
            "acme-again.json",
            descriptor("acme-again", &bin),
        );

        let outcome = load_from_dir(dir.path(), &["cursor"]);
        assert_eq!(outcome.rejections.len(), 1);
        assert_eq!(
            outcome.rejections[0].code,
            RejectionCode::DuplicateProviderId
        );
        assert_eq!(outcome.rejections[0].provider_id.as_deref(), Some("cursor"));
        let ids: Vec<&str> = outcome
            .installations
            .iter()
            .map(|installation| installation.provider_id())
            .collect();
        // File-name order: '-' sorts before '.'.
        assert_eq!(ids, vec!["acme-again", "acme"]);
    }

    /// A path that looks like a descriptor but cannot be read must surface as a
    /// rejection; dropping it silently is indistinguishable from "not installed".
    #[test]
    fn unreadable_descriptor_paths_are_reported_not_skipped() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("directory.json")).unwrap();

        let outcome = load_from_dir(dir.path(), NO_RESERVED);
        assert!(outcome.installations.is_empty());
        assert_eq!(outcome.rejections.len(), 1);
        assert_eq!(
            outcome.rejections[0].code,
            RejectionCode::DescriptorUnreadable
        );
        assert!(outcome.rejections[0]
            .source_path
            .ends_with("directory.json"));
    }

    /// A descriptor may not pre-declare what the ACP handshake negotiates, and
    /// the refusal has to reach the user through the scan.
    #[test]
    fn descriptors_declaring_negotiated_capabilities_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let bin = runnable_binary(dir.path());
        let mut claims = descriptor("acme", &bin);
        claims["agent"]["models"] = json!([{ "id": "acme-large" }]);
        write(dir.path(), "acme.json", claims);

        let outcome = load_from_dir(dir.path(), NO_RESERVED);
        assert!(outcome.installations.is_empty());
        assert_eq!(
            outcome.rejections[0].code,
            RejectionCode::DescriptorSchemaViolation
        );
        assert!(outcome.rejections[0].message.contains("models"));
    }

    #[test]
    fn a_file_name_that_disagrees_with_the_entry_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let bin = runnable_binary(dir.path());
        write(
            dir.path(),
            "totally-different.json",
            descriptor("acme", &bin),
        );

        let outcome = load_from_dir(dir.path(), NO_RESERVED);
        assert!(outcome.installations.is_empty());
        assert_eq!(
            outcome.rejections[0].code,
            RejectionCode::DescriptorIdentityMismatch
        );
        assert_eq!(outcome.rejections[0].provider_id.as_deref(), Some("acme"));
        assert!(outcome.rejections[0].message.contains("acme.json"));
    }

    #[test]
    fn malformed_json_and_wrong_shapes_get_distinct_codes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("broken.json"), "{ not json").unwrap();
        write(dir.path(), "shape.json", json!({ "schema_version": 1 }));

        let outcome = load_from_dir(dir.path(), NO_RESERVED);
        let codes: Vec<RejectionCode> = outcome
            .rejections
            .iter()
            .map(|rejection| rejection.code)
            .collect();
        assert!(codes.contains(&RejectionCode::DescriptorInvalidJson));
        assert!(codes.contains(&RejectionCode::DescriptorSchemaViolation));
    }

    #[test]
    fn unsupported_schema_versions_and_distributions_are_rejected_distinctly() {
        let dir = tempfile::tempdir().unwrap();
        let bin = runnable_binary(dir.path());
        let mut future = descriptor("future", &bin);
        future["schema_version"] = json!(2);
        write(dir.path(), "future.json", future);

        let mut remote = descriptor("remote", &bin);
        remote["installation"] = json!({});
        remote["agent"]["distribution"] = json!({ "npx": { "package": "@remote/agent@1.0.0" } });
        write(dir.path(), "remote.json", remote);

        let outcome = load_from_dir(dir.path(), NO_RESERVED);
        assert!(outcome.installations.is_empty());
        let codes: Vec<RejectionCode> = outcome
            .rejections
            .iter()
            .map(|rejection| rejection.code)
            .collect();
        assert!(codes.contains(&RejectionCode::UnsupportedSchemaVersion));
        assert!(codes.contains(&RejectionCode::UnsupportedDistribution));
    }

    #[test]
    fn an_invalid_executable_path_is_rejected_but_a_missing_one_is_quarantined() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "relative.json", descriptor("relative", "acme"));
        write(
            dir.path(),
            "missing.json",
            descriptor("missing", "/nonexistent/cadencr/acme"),
        );

        let outcome = load_from_dir(dir.path(), NO_RESERVED);
        assert_eq!(
            outcome.rejections[0].code,
            RejectionCode::InvalidExecutablePath
        );
        assert_eq!(outcome.installations.len(), 1);
        assert_eq!(outcome.installations[0].provider_id(), "missing");
        assert!(outcome.installations[0].quarantine().is_some());
    }
}
