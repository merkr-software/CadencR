//! A flattened agy tool name is unambiguous only in the absence of a
//! conflicting native registration. Keep custom plugin discovery and alternate
//! CLI roots on the native permission path when their inventory is unknown.
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::Path;

use serde_json::Value;

pub(crate) fn configured_servers(cwd: &Path, home: &Path) -> io::Result<Option<HashSet<String>>> {
    if !cwd.is_absolute() || !home.is_absolute() {
        return Ok(None);
    }
    if cwd.ancestors().count() > 64 {
        return Ok(None);
    }
    let mut budget = 4 * 1024 * 1024;
    let mut servers = HashSet::new();
    let global = home.join(".gemini/config");
    if let Some(config) = json_file(&global.join("config.json"), &mut budget)? {
        if let Some(plugins) = config.get("plugins") {
            if plugins
                .as_object()
                .is_none_or(|items| items.keys().any(|name| name != "swarm"))
            {
                return Ok(None);
            }
        }
    }
    let projects = global.join("projects");
    if projects.try_exists()? {
        for (index, entry) in fs::read_dir(projects)?.enumerate() {
            if index >= 128 {
                return Ok(None);
            }
            let path = entry?.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                let config = json_file(&path, &mut budget)?;
                if config
                    .as_ref()
                    .and_then(|v| v.get("projectResources"))
                    .is_none_or(|resources| resources.as_object().is_none_or(|obj| !obj.is_empty()))
                {
                    return Ok(None);
                }
            }
        }
    }
    for base in
        std::iter::once(global).chain(cwd.ancestors().flat_map(|base| {
            [".agents", ".agent", "_agents", "_agent"].map(|root| base.join(root))
        }))
    {
        if base.join("plugins.json").try_exists()? || base.join("plugins").try_exists()? {
            return Ok(None);
        }
        let Some(config) = json_file(&base.join("mcp_config.json"), &mut budget)? else {
            continue;
        };
        if let Some(map) = config.get("mcpServers") {
            let Some(map) = map.as_object() else {
                return Ok(None);
            };
            servers.extend(map.keys().cloned());
        } else if config.as_object().is_none_or(|map| !map.is_empty()) {
            return Ok(None);
        }
    }
    Ok(Some(servers))
}

fn json_file(path: &Path, budget: &mut u64) -> io::Result<Option<Value>> {
    const LIMIT: u64 = 1024 * 1024;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NONBLOCK);
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("MCP config is not a regular file"));
    }
    let mut bytes = Vec::new();
    let limit = LIMIT.min(*budget);
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other("MCP config exceeds size limit"));
    }
    *budget -= bytes.len() as u64;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovery_rejects_special_files_and_limits_total_input() {
        let dir = tempfile::tempdir().unwrap();
        let mut budget = 3;
        assert!(json_file(dir.path(), &mut budget).is_err());
        let config = dir.path().join("config.json");
        fs::write(&config, "{}").unwrap();
        assert_eq!(json_file(&config, &mut budget).unwrap(), Some(json!({})));
        assert!(json_file(&config, &mut budget).is_err());
    }

    #[test]
    fn global_and_workspace_config_contribute_names_and_invalid_config_disables_trust() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let global = home.join(".gemini/config");
        let project = temp.path().join("project");
        let local = project.join(".agents");
        fs::create_dir_all(&global).unwrap();
        fs::create_dir_all(&local).unwrap();
        for (base, name) in [(&global, "global"), (&local, "cadencr-workspace")] {
            fs::write(
                base.join("mcp_config.json"),
                json!({"mcpServers":{(name):{"command":"fixture"}}}).to_string(),
            )
            .unwrap();
        }
        assert_eq!(
            configured_servers(&project, &home).unwrap(),
            Some(HashSet::from(["global".into(), "cadencr-workspace".into()]))
        );
        fs::write(local.join("mcp_config.json"), "invalid").unwrap();
        assert!(configured_servers(&project, &home).is_err());
    }
}
