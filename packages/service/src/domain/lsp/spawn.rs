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
    if !entry.language_ids.iter().any(|id| id == language) {
        return Err(AppError::BadRequest(format!(
            "Language server {id} does not support {language}"
        )));
    }
    resolve(entry).await
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
            command = node().await?;
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
pub async fn node() -> Result<PathBuf, AppError> {
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
    cli_discovery::select_best(&candidates)
        .map(|best| best.canonical.clone())
        .ok_or_else(|| {
            AppError::coded(
                axum::http::StatusCode::CONFLICT,
                "LSP_NODE_REQUIRED",
                "This language server requires Node.js. Install Node.js, then retry.",
            )
        })
}
pub fn spawn_server(spec: &ServerSpec, workspace_root: &Path) -> Result<Child, AppError> {
    Command::new(&spec.command)
        .args(&spec.args)
        .current_dir(workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            AppError::Internal(format!("Failed to spawn {}: {error}", spec.display_name))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

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
