//! Narrow reads of the native agy 1.5.14 registry and launch-message records.

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use super::is_subagent_launch;
const MAX_RECORD_BYTES: u64 = 128 * 1024;
const REGISTRY_SCAN_BATCH: usize = 128;
const MESSAGE_SCAN_BATCH: usize = 16;
const LAUNCH_RECORD_MAX_AGE: Duration = Duration::from_secs(60);

pub(super) struct NativeChild {
    pub(super) id: String,
    pub(super) carrier: String,
    pub(super) descriptor: PathBuf,
    pub(super) transcript: PathBuf,
}

pub(super) fn native_brain(args: &[OsString]) -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if !home.is_absolute() {
        return None;
    }
    let gemini = relative_directory(args, &["--gemini-dir", "--gemini_dir"], ".gemini")?;
    let app = relative_directory(
        args,
        &["--app-data-dir", "--app_data_dir"],
        "antigravity-cli",
    )?;
    Some(home.join(gemini).join(app).join("brain"))
}

fn relative_directory<'a>(
    args: &'a [OsString],
    flags: &[&str],
    default: &'a str,
) -> Option<&'a Path> {
    let mut value = OsStr::new(default);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let Some(arg) = arg.to_str() else {
            continue;
        };
        let (flag, inline) = arg.split_once('=').unzip();
        if flags.contains(&flag.unwrap_or(arg)) {
            value = match inline {
                Some(inline) => OsStr::new(inline),
                None => args.next()?.as_os_str(),
            };
        }
    }
    let path = Path::new(value);
    (!path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_))))
    .then_some(path)
}

pub(super) fn uuid_segment(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[derive(Default)]
pub(super) struct Discovery {
    entries: Option<fs::ReadDir>,
    seen: HashSet<String>,
    launches: HashMap<String, LaunchScan>,
    children: Vec<NativeChild>,
}

impl Discovery {
    pub(super) fn pause(&mut self) {
        *self = Self::default();
    }

    pub(super) fn scan(&mut self, brain: &Path, root: &str) {
        if self.entries.is_none() {
            self.entries = generated(brain, root)
                .and_then(|path| directory(&path, "subagents"))
                .and_then(|path| fs::read_dir(path).ok());
        }
        for _ in 0..REGISTRY_SCAN_BATCH {
            let Some(entry) = self.entries.as_mut().and_then(Iterator::next) else {
                self.entries = None;
                break;
            };
            let Ok(entry) = entry else { continue };
            self.inspect_entry(brain, root, entry);
        }
    }

    pub(super) fn take_children(
        &mut self,
        mut has_carrier: impl FnMut(&str) -> bool,
    ) -> Vec<NativeChild> {
        self.children
            .extract_if(.., move |child| has_carrier(&child.carrier))
            .collect()
    }

    fn inspect_entry(&mut self, brain: &Path, root: &str, entry: fs::DirEntry) {
        let path = entry.path();
        let Some(id) = record_id(&path) else { return };
        if id == root || self.seen.contains(id) {
            return;
        }
        if entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| {
                modified
                    .elapsed()
                    .is_ok_and(|age| age > LAUNCH_RECORD_MAX_AGE)
            })
        {
            self.launches.remove(id);
            return;
        }
        if let Some(child) = read_child(brain, root, id, &path, &mut self.launches) {
            self.seen.insert(id.to_owned());
            self.children.push(child);
        }
    }
}

fn read_child(
    brain: &Path,
    root: &str,
    id: &str,
    descriptor: &Path,
    launches: &mut HashMap<String, LaunchScan>,
) -> Option<NativeChild> {
    let record = read_record(descriptor)?;
    if record["conversationId"] != id {
        return None;
    }
    let child = generated(brain, id)?;
    let transcript = directory(&child, "logs")?.join("transcript_full.jsonl");
    // A launch can publish its descriptor before it opens the journal. Keep
    // the discovery deadline until there is a source of lifecycle events.
    if record["state"] != "SUBAGENT_STATE_KILLED" {
        open_file(&transcript).ok()?;
    }
    let scan = match launches.entry(id.to_owned()) {
        std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
        std::collections::hash_map::Entry::Vacant(entry) => {
            let messages = fs::read_dir(directory(&child, "messages")?).ok()?;
            entry.insert(LaunchScan {
                messages,
                carrier: None,
            })
        }
    };
    let carrier = scan.advance(root, id)?;
    launches.remove(id);
    Some(NativeChild {
        id: id.to_owned(),
        carrier: carrier?,
        descriptor: descriptor.to_owned(),
        transcript,
    })
}

struct LaunchScan {
    messages: fs::ReadDir,
    carrier: Option<String>,
}

impl LaunchScan {
    /// Batched siblings can share the registry's spawnStepIndex. The addressed
    /// launch message carries the exact ACP call ID for this child.
    fn advance(&mut self, root: &str, child: &str) -> Option<Option<String>> {
        for _ in 0..MESSAGE_SCAN_BATCH {
            let Some(entry) = self.messages.next() else {
                return Some(self.carrier.take());
            };
            let Ok(entry) = entry else { continue };
            let path = entry.path();
            if record_id(&path).is_none() {
                continue;
            }
            let Some(record) = read_record(&path) else {
                continue;
            };
            let tool = &record["sourceMetadata"]["tool"];
            let call = &tool["toolCall"];
            if record["sender"] != root
                || record["recipient"] != child
                || tool["conversationId"] != root
                || !call["name"].as_str().is_some_and(is_subagent_launch)
            {
                continue;
            }
            let Some(id) = call["id"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            if self.carrier.as_deref().is_some_and(|found| found != id) {
                return Some(None);
            }
            self.carrier = Some(id.to_owned());
        }
        None
    }
}

fn generated(brain: &Path, id: &str) -> Option<PathBuf> {
    directory(&directory(brain, id)?, ".system_generated")
}

fn directory(parent: &Path, name: &str) -> Option<PathBuf> {
    let path = parent.join(name);
    fs::symlink_metadata(&path)
        .is_ok_and(|metadata| metadata.is_dir())
        .then_some(path)
}

fn record_id(path: &Path) -> Option<&str> {
    if path.extension() != Some(OsStr::new("json")) {
        return None;
    }
    path.file_stem()?.to_str().filter(|id| uuid_segment(id))
}

pub(super) fn open_file(path: &Path) -> io::Result<File> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not an agy journal file",
        ));
    }
    File::open(path)
}

pub(super) fn read_record(path: &Path) -> Option<Value> {
    let mut bytes = Vec::new();
    open_file(path)
        .ok()?
        .take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_paths_accept_relative_cli_overrides_and_reject_traversal() {
        let flags = ["--app-data-dir", "--app_data_dir"];
        let args = [OsString::from("--app_data_dir=fixture")];
        assert_eq!(
            relative_directory(&args, &flags, "default"),
            Some(Path::new("fixture"))
        );
        let args = [
            OsString::from("--app-data-dir"),
            OsString::from("../outside"),
        ];
        assert_eq!(relative_directory(&args, &flags, "default"), None);
        assert!(uuid_segment("74ccee4e-faa9-4276-b857-b31ad2e5de70"));
        assert!(!uuid_segment("../cee4e-faa9-4276-b857-b31ad2e5de70"));
    }

    #[cfg(unix)]
    #[test]
    fn native_records_and_descendant_directories_reject_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let unrelated = temp.path().join("unrelated.json");
        fs::write(&unrelated, "{}").unwrap();
        let linked_file = temp.path().join("linked.json");
        std::os::unix::fs::symlink(unrelated, &linked_file).unwrap();
        assert!(read_record(&linked_file).is_none());
        let unrelated = temp.path().join("other-data");
        fs::create_dir(&unrelated).unwrap();
        std::os::unix::fs::symlink(unrelated, temp.path().join("linked-directory")).unwrap();
        assert!(directory(temp.path(), "linked-directory").is_none());
    }
}
