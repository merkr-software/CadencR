//! Read-only compatibility for servers installed before marketplace receipts.
use super::super::{
    legacy::{self, LegacyInstall},
    probe::{LspLanguage, ServerProbe, ServerProbeStatus},
};
use super::{invalid, storage};
use crate::error::AppError;
use std::sync::OnceLock;

mod cache;
fn cache() -> &'static cache::DiscoveryCache {
    static CACHE: OnceLock<cache::DiscoveryCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

pub(super) async fn invalidate() {
    cache().invalidate().await;
}

pub async fn inventory() -> Result<Vec<ServerProbe>, AppError> {
    let root = storage::root()?;
    Ok(cache()
        .get(&root, discover())
        .await?
        .into_iter()
        .filter(|entry| !storage::removed(&root, &entry.lsp_id))
        .collect())
}

async fn discover() -> Result<Vec<ServerProbe>, AppError> {
    let data = crate::shared::app_paths::data_dir().map_err(invalid)?;
    let entries = futures::future::join_all(legacy::CATALOG.iter().map(|entry| {
        let data = data.clone();
        async move {
            let candidates = cli_discovery::discover_all(&entry.discovery_spec(), None).await;
            let found = cli_discovery::select_best(&candidates).map(|best| {
                (
                    best.canonical.clone(),
                    ServerProbeStatus::OnPath,
                    best.version
                        .as_ref()
                        .map(|version| version.to_string_dotted()),
                )
            });
            let found = found.or_else(|| {
                let recipe = entry.legacy_install.as_ref()?;
                let dir = data.join("lsp").join(entry.lsp_id).join(recipe.version());
                let path = match recipe {
                    LegacyInstall::Native { .. } => dir.join(entry.bin_name),
                    LegacyInstall::Npm { .. } => dir.join("node_modules/.bin").join(entry.bin_name),
                };
                path.is_file().then(|| {
                    (
                        path,
                        ServerProbeStatus::Legacy,
                        Some(recipe.version().to_string()),
                    )
                })
            });
            found.map(|(path, status, version)| ServerProbe {
                lsp_id: entry.lsp_id.into(),
                name: entry.lsp_id.into(),
                description: "Existing installation (unsigned legacy metadata)".into(),
                bin_name: entry.bin_name.into(),
                args: entry.args.iter().map(|arg| arg.to_string()).collect(),
                language_ids: entry.language_ids.iter().map(|id| id.to_string()).collect(),
                languages: entry
                    .language_ids
                    .iter()
                    .map(|id| LspLanguage {
                        id: id.to_string(),
                        extensions: vec![],
                        filenames: vec![],
                    })
                    .collect(),
                root_markers: entry
                    .root_markers
                    .iter()
                    .map(|marker| marker.to_string())
                    .collect(),
                role: entry.role,
                status,
                path: Some(path.to_string_lossy().into_owned()),
                version,
                downloadable: false,
                initialization_options: serde_json::json!({}),
                error: None,
            })
        }
    }))
    .await
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    Ok(entries)
}
