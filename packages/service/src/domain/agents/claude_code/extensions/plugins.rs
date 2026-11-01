//! Claude Code plugins (skill packs): `claude plugin list --json --available`
//! plus the marketplace manifests the CLI keeps on disk, which carry the
//! version a plugin would update to.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

use crate::domain::agents::extensions::{
    AvailableSkill, InstalledSkill, SkillInventory, SkillOffer, SkillSource,
};
use crate::domain::agents::updates::version::is_newer;

#[derive(Debug, Deserialize)]
pub struct PluginList {
    #[serde(default)]
    installed: Vec<InstalledPlugin>,
    #[serde(default)]
    available: Vec<AvailablePlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPlugin {
    id: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    install_path: Option<String>,
    #[serde(default)]
    installed_at: Option<String>,
    #[serde(default)]
    last_updated: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AvailablePlugin {
    plugin_id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    marketplace_name: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    install_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct Marketplace {
    name: String,
    #[serde(rename = "installLocation", default)]
    install_location: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    #[serde(default)]
    plugins: Vec<ManifestPlugin>,
}

#[derive(Debug, Deserialize)]
struct ManifestPlugin {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    source: serde_json::Value,
}

/// What a marketplace currently lists for one plugin.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CatalogEntry {
    pub description: Option<String>,
    /// Declared version, else the pinned source commit (how Claude Code
    /// versions plugins without one).
    pub version: Option<String>,
}

/// `plugin@marketplace` → current catalog entry, for marketplaces kept on disk.
pub async fn catalog_entries(marketplaces: &[Marketplace]) -> HashMap<String, CatalogEntry> {
    let mut entries = HashMap::new();
    for marketplace in marketplaces {
        let Some(location) = &marketplace.install_location else {
            continue;
        };
        let path = Path::new(location)
            .join(".claude-plugin")
            .join("marketplace.json");
        let Ok(text) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Manifest>(&text) else {
            continue;
        };
        for plugin in manifest.plugins {
            let sha = plugin.source.get("sha").and_then(|sha| sha.as_str());
            let version = plugin
                .version
                .or_else(|| sha.map(|sha| sha.chars().take(12).collect()));
            entries.insert(
                format!("{}@{}", plugin.name, marketplace.name),
                CatalogEntry {
                    description: plugin.description,
                    version,
                },
            );
        }
    }
    entries
}

/// Whether moving from `installed` to `catalog` is an update.
fn is_update(catalog: &str, installed: &str) -> bool {
    let commit = |value: &str| value.len() >= 7 && value.chars().all(|ch| ch.is_ascii_hexdigit());
    if commit(catalog) && commit(installed) {
        return !catalog.starts_with(installed) && !installed.starts_with(catalog);
    }
    is_newer(catalog, installed)
}

pub fn inventory(
    provider_id: &str,
    list: PluginList,
    catalog: &HashMap<String, CatalogEntry>,
) -> SkillInventory {
    let installed = list
        .installed
        .into_iter()
        .map(|plugin| {
            let entry = catalog.get(&plugin.id).cloned().unwrap_or_default();
            let update = match (&entry.version, &plugin.version) {
                (Some(latest), Some(current)) if is_update(latest, current) => Some(latest.clone()),
                _ => None,
            };
            InstalledSkill {
                provider_id: provider_id.to_string(),
                name: plugin
                    .id
                    .split('@')
                    .next()
                    .unwrap_or(&plugin.id)
                    .to_string(),
                id: plugin.id,
                description: entry.description,
                source: SkillSource::Plugin,
                version: plugin.version,
                update,
                enabled: plugin.enabled,
                scope: plugin.scope,
                path: plugin.install_path,
                installed_at: plugin.installed_at,
                updated_at: plugin.last_updated,
            }
        })
        .collect();
    let available = list
        .available
        .into_iter()
        .map(|plugin| AvailableSkill {
            name: plugin.name,
            description: plugin.description,
            offer: SkillOffer {
                provider_id: provider_id.to_string(),
                plugin_id: plugin.plugin_id,
                marketplace: plugin.marketplace_name,
                version: plugin.version,
                install_count: plugin.install_count,
            },
        })
        .collect();
    SkillInventory {
        installed,
        available,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_plugins_compare_to_their_marketplace_entry() {
        let list: PluginList = serde_json::from_value(serde_json::json!({
            "installed": [
                {"id": "skill-creator@official", "version": "a7ba5b93db0c", "scope": "user", "enabled": true},
                {"id": "swift-lsp@official", "version": "1.0.0"},
                {"id": "gone@elsewhere", "version": "2.0.0"}
            ],
            "available": [
                {"pluginId": "figma@official", "name": "figma", "marketplaceName": "official",
                 "description": "Figma", "installCount": 12}
            ]
        }))
        .unwrap();
        let catalog = HashMap::from([
            (
                "skill-creator@official".to_string(),
                CatalogEntry {
                    description: Some("Create skills".into()),
                    version: Some("b1c2d3e4f5a6".into()),
                },
            ),
            (
                "swift-lsp@official".to_string(),
                CatalogEntry {
                    description: None,
                    version: Some("1.0.0".into()),
                },
            ),
        ]);
        let inventory = inventory("claude-code", list, &catalog);
        assert_eq!(inventory.installed[0].name, "skill-creator");
        assert_eq!(
            inventory.installed[0].update.as_deref(),
            Some("b1c2d3e4f5a6")
        );
        assert_eq!(
            inventory.installed[0].description.as_deref(),
            Some("Create skills")
        );
        assert_eq!(inventory.installed[1].update, None);
        assert_eq!(inventory.installed[2].update, None);
        assert_eq!(inventory.available[0].offer.install_count, Some(12));
    }

    #[test]
    fn commit_versions_match_by_prefix() {
        assert!(!is_update("a7ba5b93db0c", "a7ba5b93db0c"));
        assert!(!is_update("a7ba5b93db0c7c8d17f3", "a7ba5b93db0c"));
        assert!(is_update("ffba5b93db0c", "a7ba5b93db0c"));
        assert!(is_update("1.1.0", "1.0.0"));
        assert!(!is_update("1.0.0", "1.1.0"));
    }
}
