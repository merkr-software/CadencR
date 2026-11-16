//! Raw notify events retain create/change/delete and both halves of a rename.
use super::registration::normalized;
use notify_debouncer_mini::notify::{
    event::{ModifyKind, RenameMode},
    Event, EventKind,
};
use serde_json::{json, Value};
use std::path::PathBuf;

pub(super) fn changes(event: Event) -> Vec<(PathBuf, u8)> {
    let kinds: Vec<u8> = match event.kind {
        EventKind::Create(_) => vec![1; event.paths.len()],
        EventKind::Remove(_) => vec![4; event.paths.len()],
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() == 2 => {
            vec![4, 1]
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => vec![4; event.paths.len()],
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => vec![1; event.paths.len()],
        EventKind::Modify(_) => vec![2; event.paths.len()],
        _ => return Vec::new(),
    };
    event
        .paths
        .into_iter()
        .zip(kinds)
        .filter_map(|(path, kind)| normalized(&path).ok().map(|path| (path, kind)))
        .collect()
}

pub(super) fn notification(changes: Vec<(PathBuf, u8)>) -> Value {
    let changes: Vec<_> = changes
        .into_iter()
        .filter_map(|(path, kind)| {
            reqwest::Url::from_file_path(path).ok().map(|uri| {
                json!({
                    "uri": uri.as_str(), "type": match kind { 1 => 1, 4 => 3, _ => 2 }
                })
            })
        })
        .collect();
    json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles","params":{"changes":changes}})
}

/// Match the short coalescing window used by IDE/native watcher clients.
/// In particular FSEvents can report Created and Modified together repeatedly.
#[derive(Default)]
pub(super) struct PendingFileEvents {
    changes: std::collections::BTreeMap<String, Value>,
}
impl PendingFileEvents {
    pub fn push(&mut self, message: Value) -> Result<(), String> {
        if let Some(changes) = message["params"]["changes"].as_array() {
            for change in changes {
                let (Some(uri), Some(kind)) = (change["uri"].as_str(), change["type"].as_u64())
                else {
                    return Err("Invalid language-server filesystem event".into());
                };
                // FSEvents repeats Created on later writes. Prefer the latest
                // actual kind; a trailing Modified flag cannot undo a deletion.
                // Kind masks were already applied before batching, so a
                // create-only registration still receives its Created event.
                if self
                    .changes
                    .get(uri)
                    .is_some_and(|previous| previous["type"] == 3)
                    && kind == 2
                {
                    continue;
                }
                if self.changes.len() == 1024 && !self.changes.contains_key(uri) {
                    return Err("Language-server filesystem event batch exceeded its limit".into());
                }
                self.changes.insert(uri.to_string(), change.clone());
            }
        }
        Ok(())
    }
    pub fn drain(&mut self) -> Option<Value> {
        if self.changes.is_empty() {
            return None;
        }
        let changes: Vec<_> = std::mem::take(&mut self.changes).into_values().collect();
        Some(
            json!({"jsonrpc":"2.0","method":"workspace/didChangeWatchedFiles","params":{"changes":changes}}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batches_coalesce_sticky_created_flags_and_preserve_deletion_and_recreation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("dep.ts");
        for (kinds, expected) in [
            (vec![1, 1], 1),
            (vec![1, 2, 2], 2),
            (vec![1, 2, 4, 2], 3),
            (vec![4, 1], 1),
            (vec![4, 1, 2], 2),
        ] {
            let mut pending = PendingFileEvents::default();
            for kind in kinds {
                pending
                    .push(notification(vec![(path.clone(), kind)]))
                    .unwrap();
            }
            let message = pending.drain().unwrap();
            assert_eq!(message["params"]["changes"].as_array().unwrap().len(), 1);
            assert_eq!(message["params"]["changes"][0]["type"], expected);
            assert!(pending.drain().is_none());
        }
    }
    #[test]
    fn event_batch_is_bounded_and_can_accept_further_changes_for_known_paths() {
        let temp = tempfile::tempdir().unwrap();
        let mut pending = PendingFileEvents::default();
        for index in 0..1024 {
            pending
                .push(notification(vec![(
                    temp.path().join(format!("{index}.ts")),
                    1,
                )]))
                .unwrap();
        }
        pending
            .push(notification(vec![(temp.path().join("0.ts"), 2)]))
            .unwrap();
        assert!(pending
            .push(notification(vec![(temp.path().join("extra.ts"), 1)]))
            .is_err());
        assert_eq!(
            pending.drain().unwrap()["params"]["changes"]
                .as_array()
                .unwrap()
                .len(),
            1024
        );
    }
    #[test]
    fn rename_preserves_deleted_and_created_paths_and_ignores_access() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old.ts");
        let new = temp.path().join("new.ts");
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(old)
            .add_path(new);
        let changed = changes(event);
        assert_eq!(
            changed.iter().map(|(_, kind)| *kind).collect::<Vec<_>>(),
            [4, 1]
        );
        let message = notification(changed);
        assert_eq!(message["params"]["changes"][0]["type"], 3);
        assert_eq!(message["params"]["changes"][1]["type"], 1);
        assert!(changes(Event::new(EventKind::Access(
            notify_debouncer_mini::notify::event::AccessKind::Any
        )))
        .is_empty());
    }
}
