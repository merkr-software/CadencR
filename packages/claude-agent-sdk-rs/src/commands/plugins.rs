use super::filesystem::{scan_commands_dir, scan_skills_dir};
use super::CommandCollector;
use crate::error::SdkError;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct InstalledPlugins {
    plugins: HashMap<String, Vec<InstalledPlugin>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPlugin {
    install_path: PathBuf,
}

pub(super) fn scan_installed_plugins(
    collector: &mut CommandCollector,
    config_dir: &Path,
) -> Result<(), SdkError> {
    let manifest_path = config_dir.join("plugins/installed_plugins.json");
    if !manifest_path.is_file() {
        return Ok(());
    }
    let manifest = read_installed_plugins_manifest(&manifest_path)?;
    let mut seen_paths = HashSet::new();
    for (plugin_id, installs) in manifest.plugins {
        let namespace = plugin_id
            .split_once('@')
            .map_or(plugin_id.as_str(), |(plugin, _)| plugin);
        for install in installs {
            if seen_paths.insert(install.install_path.clone()) {
                scan_plugin_root(collector, &install.install_path, namespace)?;
            }
        }
    }
    Ok(())
}

fn read_installed_plugins_manifest(path: &Path) -> Result<InstalledPlugins, SdkError> {
    let content = std::fs::read_to_string(path).map_err(SdkError::IoError)?;
    serde_json::from_str(&content).map_err(SdkError::SerializationError)
}

fn scan_plugin_root(
    collector: &mut CommandCollector,
    plugin_root: &Path,
    namespace: &str,
) -> Result<(), SdkError> {
    if !plugin_root.is_dir() {
        return Ok(());
    }
    scan_skills_dir(collector, &plugin_root.join("skills"), Some(namespace))?;
    scan_commands_dir(collector, &plugin_root.join("commands"), Some(namespace))
}
