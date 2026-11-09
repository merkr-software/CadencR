//! Offline server resolution. Installation is only an explicit marketplace operation.
use super::{
    catalog, managed,
    probe::{ServerProbe, ServerProbeStatus},
};
use crate::error::AppError;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::{Child, Command};

#[derive(Debug, Clone)]
pub struct ServerSpec {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub display_name: String,
    pub managed_revision: Option<ManagedRevision>,
}
#[derive(Debug, Clone)]
pub struct ManagedRevision {
    pub root: PathBuf,
    pub id: String,
    pub pointer: managed::storage::Pointer,
    pub receipt_sha256: String,
}
pub async fn resolve_server(language: &str) -> Result<(ServerSpec, ServerProbe), AppError> {
    let entry = catalog::lookup(language).await?.ok_or_else(|| {
        AppError::NotFound(format!(
            "No installed language server for {language}; install one in Marketplace"
        ))
    })?;
    resolve(entry).await
}
pub async fn resolve_server_by_id(
    id: &str,
    language: &str,
) -> Result<(ServerSpec, ServerProbe), AppError> {
    let entry = catalog::lookup_by_id(id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Language server {id} is not installed")))?;
    let entry = validate_requested_server(entry, language, |id| async move {
        let root = managed::storage::root()?;
        tokio::task::spawn_blocking(move || {
            managed::storage::read(&root, &id).map(|(probe, _)| probe)
        })
        .await
        .map_err(managed::invalid)?
    })
    .await?;
    resolve(entry).await
}
pub(in crate::domain::lsp) async fn validate_requested_server<F>(
    mut entry: ServerProbe,
    language: &str,
    revalidate: impl FnOnce(String) -> F,
) -> Result<ServerProbe, AppError>
where
    F: std::future::Future<Output = Result<ServerProbe, AppError>>,
{
    if entry.status == ServerProbeStatus::Invalid {
        // Quarantine clears untrusted language metadata and retains only display
        // text. Recheck its receipt before interpreting that empty language set.
        entry = revalidate(entry.lsp_id).await?;
    }
    if !entry.language_ids.iter().any(|id| id == language) {
        return Err(AppError::BadRequest(format!(
            "Language server {} does not support {language}",
            entry.lsp_id
        )));
    }
    Ok(entry)
}
async fn resolve(mut entry: ServerProbe) -> Result<(ServerSpec, ServerProbe), AppError> {
    if let Some(error) = &entry.error {
        return Err(managed::invalid(error));
    }
    let path = entry.path.as_ref().ok_or_else(|| {
        AppError::NotFound(format!("Language server {} is unavailable", entry.lsp_id))
    })?;
    let mut command = PathBuf::from(path);
    let mut args;
    let mut managed_revision = None;
    if entry.status == ServerProbeStatus::Managed {
        let root = managed::storage::root()?;
        let id = entry.lsp_id.clone();
        let (verified, target, proof) = tokio::task::spawn_blocking(move || {
            let pointer = managed::storage::pointer(&root, &id)?;
            let (verified, target) = managed::storage::read_revision(&root, &id, &pointer)?;
            let receipt_sha256 = managed::storage::receipt_digest(&root, &id, &pointer)?;
            Ok::<_, AppError>((
                verified,
                target,
                ManagedRevision {
                    root,
                    id,
                    pointer,
                    receipt_sha256,
                },
            ))
        })
        .await
        .map_err(managed::invalid)??;
        managed_revision = Some(proof);
        args = verified.args.clone();
        command = PathBuf::from(
            verified
                .path
                .as_ref()
                .ok_or_else(|| managed::invalid("LSP entry missing"))?,
        );
        if target.runtime == cadencr_registry_core::LspRuntime::Node {
            args.insert(0, command.to_string_lossy().into_owned());
            command = node(target.node_minimum()).await?;
        }
        entry = verified;
    } else {
        args = entry.args.clone();
    }
    Ok((
        ServerSpec {
            command,
            args,
            display_name: entry.name.clone(),
            managed_revision,
        },
        entry,
    ))
}
/// Reservations pin a revision; connect rechecks the same bytes and current cached revocations.
pub async fn revalidate(spec: &ServerSpec) -> Result<(), AppError> {
    let Some(proof) = spec.managed_revision.clone() else {
        return Ok(());
    };
    tokio::task::spawn_blocking(move || {
        verify_reserved(
            &proof,
            &crate::domain::agents::providers::installed::managed::trust::pinned_index_trust_store(
            ),
        )
    })
    .await
    .map_err(managed::invalid)?
}
pub(in crate::domain::lsp) fn verify_reserved(
    proof: &ManagedRevision,
    trust: &crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore,
) -> Result<(), AppError> {
    managed::storage::read_revision_trusted(&proof.root, &proof.id, &proof.pointer, trust)?;
    if managed::storage::receipt_digest(&proof.root, &proof.id, &proof.pointer)?
        != proof.receipt_sha256
    {
        return Err(managed::invalid("LSP reserved receipt changed"));
    }
    Ok(())
}
pub(in crate::domain::lsp) async fn node_candidate() -> Option<cli_discovery::Candidate> {
    let spec = cli_discovery::DiscoverySpec {
        bin_name: "node".into(),
        well_known_relative_to_home: vec![],
        well_known_absolute: vec![
            "/usr/local/bin".into(),
            "/opt/homebrew/bin".into(),
            "/usr/bin".into(),
        ],
        version_args: vec!["--version".into()],
        version_must_contain: None,
    };
    let candidates = cli_discovery::discover_all(&spec, None).await;
    cli_discovery::select_best(&candidates).cloned()
}
pub(in crate::domain::lsp) fn node_version_satisfies(
    version: Option<cli_discovery::VersionKey>,
    minimum: &str,
) -> bool {
    match (version, cli_discovery::parse_version_string(minimum)) {
        (Some(version), Some(minimum)) => version >= minimum,
        _ => false,
    }
}
pub async fn node(minimum: &str) -> Result<PathBuf, AppError> {
    require_node(node_candidate().await, minimum)
}
fn require_node(
    candidate: Option<cli_discovery::Candidate>,
    minimum: &str,
) -> Result<PathBuf, AppError> {
    if let Some(candidate) = candidate {
        if node_version_satisfies(candidate.version, minimum) {
            return Ok(candidate.canonical);
        }
    }
    Err(AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "LSP_NODE_REQUIRED",
        format!("This language server requires Node.js {minimum} or newer. Install a compatible Node.js version, then retry."),
    ))
}

pub fn spawn_server(spec: &ServerSpec, workspace_root: &Path) -> Result<Child, AppError> {
    let mut command = Command::new(&spec.command);
    if let Some(revision) = &spec.managed_revision {
        configure_runtime_cache(
            &mut command,
            &crate::shared::app_paths::cache_dir().map_err(managed::invalid)?,
            &revision.id,
        )?;
    }
    command
        .args(&spec.args)
        .current_dir(workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            AppError::internal(format!("Failed to spawn {}: {error}", spec.display_name))
        })
}

/// Managed servers keep generated metadata outside their immutable signed revision.
/// Arguments remain literal; a server may expand this variable using its own CLI contract.
fn configure_runtime_cache(
    command: &mut Command,
    cache_root: &Path,
    id: &str,
) -> Result<(), AppError> {
    let root = cache_root.join("lsp");
    let path = managed::storage::owner(&root, id)?;
    managed::storage::secure(&root)?;
    managed::storage::secure(&path)?;
    command.env("CADENCR_LSP_CACHE_ROOT", path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn healthy_probe_controls_language_validation_without_revalidation() {
        let package: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tooling/marketplace-registry/examples/lsp/package.node.json"
        )))
        .unwrap();
        let mut current =
            managed::storage::probe(&package["package"], ServerProbeStatus::Managed).unwrap();
        current.language_ids = vec!["current-language".into()];
        let accepted = validate_requested_server(current.clone(), "current-language", |_| async {
            panic!("healthy inventory must not be revalidated")
        })
        .await
        .unwrap();
        assert_eq!(accepted.language_ids, ["current-language"]);
        assert!(matches!(
            validate_requested_server(current, "old-language", |_| async {
                panic!("healthy inventory must not be revalidated")
            }).await,
            Err(AppError::BadRequest(message))
                if message == "Language server example-language-server does not support old-language"
        ));
    }

    #[tokio::test]
    async fn managed_runtime_cache_is_private_and_distinct_for_each_server() {
        let cache = tempfile::tempdir().unwrap();
        for id in ["lua-language-server", "other-server"] {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "printf %s \"$CADENCR_LSP_CACHE_ROOT\""]);
            command.env("CADENCR_LSP_CACHE_ROOT", "/untrusted/inherited/path");
            configure_runtime_cache(&mut command, cache.path(), id).unwrap();
            let output = command.output().await.unwrap();
            assert!(output.status.success());
            let expected = cache.path().join("lsp").join(id);
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                expected.to_string_lossy()
            );
            assert!(expected.is_dir());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                assert_eq!(
                    std::fs::metadata(expected).unwrap().permissions().mode() & 0o777,
                    0o700
                );
            }
        }
    }

    #[test]
    fn invalid_or_unavailable_runtime_cache_prevents_launch_configuration() {
        let cache = tempfile::tempdir().unwrap();
        let mut command = Command::new("/not-executed");
        assert!(configure_runtime_cache(&mut command, cache.path(), "../escape").is_err());
        std::fs::write(cache.path().join("lsp"), "occupied").unwrap();
        assert!(
            configure_runtime_cache(&mut command, cache.path(), "lua-language-server").is_err()
        );
        assert!(command.as_std().get_envs().next().is_none());
    }

    #[test]
    fn node_requirements_compare_the_complete_version_on_both_platforms() {
        use cli_discovery::VersionKey;
        for (installed, minimum, accepted) in [
            (Some(VersionKey(20, 0, 0)), "20.0.0", true),
            (Some(VersionKey(19, 99, 99)), "20.0.0", false),
            (Some(VersionKey(22, 17, 99)), "22.18.0", false),
            (Some(VersionKey(22, 18, 0)), "22.18.0", true),
            (Some(VersionKey(24, 0, 0)), "22.18.0", true),
            (None, "20.0.0", false),
        ] {
            assert_eq!(node_version_satisfies(installed, minimum), accepted);
        }
    }

    #[test]
    fn absent_old_and_unversioned_node_require_the_signed_version() {
        for path in ["/opt/homebrew/bin/node", "/usr/bin/node"] {
            let candidate = |version| cli_discovery::Candidate {
                path: PathBuf::from(path),
                canonical: PathBuf::from(path),
                version,
                version_text: None,
                source: cli_discovery::CandidateSource::EnvPath,
            };
            for value in [
                None,
                Some(candidate(None)),
                Some(candidate(Some(cli_discovery::VersionKey(22, 17, 9)))),
            ] {
                let error = require_node(value, "22.18.0").unwrap_err();
                assert!(matches!(
                    &error,
                    AppError::Coded {
                        code: "LSP_NODE_REQUIRED",
                        ..
                    }
                ));
                assert!(error.to_string().contains("22.18.0"));
            }
            assert_eq!(
                require_node(
                    Some(candidate(Some(cli_discovery::VersionKey(22, 18, 0)))),
                    "22.18.0"
                )
                .unwrap(),
                PathBuf::from(path)
            );
        }
    }

    #[tokio::test]
    async fn external_and_legacy_launches_keep_the_inventory_arguments() {
        let package: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tooling/marketplace-registry/examples/lsp/package.node.json"
        )))
        .unwrap();
        for status in [ServerProbeStatus::OnPath, ServerProbeStatus::Legacy] {
            for args in [vec!["--stdio"], vec!["--lsp", "-stdio"], vec!["lsp-proxy"]] {
                let mut probe = managed::storage::probe(&package["package"], status).unwrap();
                probe.path = Some("/existing/server".into());
                probe.args = args.iter().map(|arg| arg.to_string()).collect();
                let (spec, _) = resolve(probe).await.unwrap();
                assert_eq!(spec.args, args);
                assert!(spec.managed_revision.is_none());
            }
        }
    }
}
