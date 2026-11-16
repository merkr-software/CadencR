//! The TCP ports listening on this computer and the process behind each:
//! `lsof` on macOS, `/proc` on Linux. Each platform module produces a
//! [`Snapshot`]; [`entries`] turns it into what the page shows.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use cadencr_tab_backend::Error;
use serde::Serialize;

/// One listening socket and the process holding it. A socket shared by
/// several processes (a pre-forking server) appears once per process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listening {
    pub pid: u32,
    /// As `lsof` prints it: `*`, `127.0.0.1`, `[::1]`.
    pub address: String,
    pub port: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcessInfo {
    pub command: String,
    pub user: Option<String>,
    /// `None` when the platform does not tell (another user's process).
    pub cwd: Option<PathBuf>,
}

/// What one platform reports.
#[derive(Debug, Default)]
pub struct Snapshot {
    pub listening: Vec<Listening>,
    pub processes: HashMap<u32, ProcessInfo>,
}

/// One process listening on one port, its addresses merged. The page checks
/// this shape (`portEntrySchema` in `src/usePorts.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortEntry {
    pub port: u16,
    pub pid: u32,
    pub command: String,
    pub user: Option<String>,
    pub cwd: Option<String>,
    pub addresses: Vec<String>,
    /// Running in the conversation's folder; `None` when `cwd` is unknown.
    pub in_folder: Option<bool>,
}

/// The conversation's folder, as given and resolved (`/tmp` and `/var` are
/// symbolic links on macOS, while process working directories are resolved).
#[derive(Debug, Clone)]
pub struct Folder {
    given: PathBuf,
    resolved: Option<PathBuf>,
}

impl Folder {
    pub fn new(path: &Path) -> Self {
        Self {
            given: path.to_path_buf(),
            resolved: path.canonicalize().ok(),
        }
    }

    /// Component-wise, so `/a/bc` is not inside `/a/b`.
    pub fn contains(&self, path: &Path) -> bool {
        path.starts_with(&self.given)
            || self
                .resolved
                .as_ref()
                .is_some_and(|resolved| path.starts_with(resolved))
    }
}

/// The listening ports right now, sorted by port then pid.
pub fn list(folder: &Folder) -> Result<Vec<PortEntry>, Error> {
    #[cfg(target_os = "linux")]
    let snapshot = crate::procfs::snapshot()?;
    #[cfg(not(target_os = "linux"))]
    let snapshot = crate::lsof::snapshot()?;
    Ok(entries(snapshot, folder))
}

/// One entry per (port, process), addresses deduplicated in the order seen.
pub fn entries(snapshot: Snapshot, folder: &Folder) -> Vec<PortEntry> {
    let Snapshot {
        listening,
        processes,
    } = snapshot;
    let mut merged: BTreeMap<(u16, u32), PortEntry> = BTreeMap::new();
    for Listening { pid, address, port } in listening {
        let entry = merged.entry((port, pid)).or_insert_with(|| {
            let info = processes.get(&pid).cloned().unwrap_or_default();
            PortEntry {
                port,
                pid,
                command: info.command,
                user: info.user,
                in_folder: info.cwd.as_deref().map(|cwd| folder.contains(cwd)),
                cwd: info.cwd.map(|cwd| cwd.to_string_lossy().into_owned()),
                addresses: Vec::new(),
            }
        });
        if !entry.addresses.contains(&address) {
            entry.addresses.push(address);
        }
    }
    merged.into_values().collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn listening(pid: u32, address: &str, port: u16) -> Listening {
        Listening {
            pid,
            address: address.into(),
            port,
        }
    }

    fn process(command: &str, cwd: Option<&str>) -> ProcessInfo {
        ProcessInfo {
            command: command.into(),
            user: Some("ada".into()),
            cwd: cwd.map(PathBuf::from),
        }
    }

    #[test]
    fn merges_addresses_and_sorts_by_port_then_pid() {
        let snapshot = Snapshot {
            listening: vec![
                listening(20, "*", 5005),
                listening(10, "127.0.0.1", 3000),
                listening(20, "*", 5005),
                listening(20, "[::1]", 5005),
                listening(5, "*", 5005),
            ],
            processes: HashMap::from([
                (20, process("service", Some("/work/app/packages/service"))),
                (10, process("vite", Some("/elsewhere"))),
            ]),
        };
        let entries = entries(snapshot, &Folder::new(Path::new("/work/app")));
        let keys: Vec<_> = entries
            .iter()
            .map(|entry| (entry.port, entry.pid))
            .collect();
        assert_eq!(keys, [(3000, 10), (5005, 5), (5005, 20)]);
        assert_eq!(entries[2].addresses, ["*", "[::1]"]);
        assert_eq!(entries[2].in_folder, Some(true));
        assert_eq!(entries[0].in_folder, Some(false));
        // A process the platform told nothing about.
        assert_eq!(
            (entries[1].command.as_str(), entries[1].in_folder),
            ("", None)
        );
    }

    #[test]
    fn serializes_the_shape_the_page_checks() {
        let snapshot = Snapshot {
            listening: vec![listening(7, "*", 80)],
            processes: HashMap::from([(7, process("nginx", Some("/srv")))]),
        };
        let value =
            serde_json::to_value(entries(snapshot, &Folder::new(Path::new("/srv")))).unwrap();
        assert_eq!(
            value,
            json!([{
                "port": 80, "pid": 7, "command": "nginx", "user": "ada",
                "cwd": "/srv", "addresses": ["*"], "inFolder": true,
            }])
        );
    }

    #[test]
    fn a_folder_contains_whole_components_only() {
        let folder = Folder::new(Path::new("/work/app"));
        assert!(folder.contains(Path::new("/work/app")));
        assert!(folder.contains(Path::new("/work/app/sub")));
        assert!(!folder.contains(Path::new("/work/application")));
        assert!(!folder.contains(Path::new("/work")));
    }

    #[test]
    fn a_folder_matches_its_resolved_path() {
        let resolved = std::env::temp_dir().canonicalize().unwrap();
        assert!(Folder::new(&std::env::temp_dir()).contains(&resolved.join("x")));
    }
}
