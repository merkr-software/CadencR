//! Document files (PDF / Office / CSV) written since the watcher's last emission.
//!
//! Rides along on `file_tree.changed` so the desktop can bring a document an
//! agent just produced into its Preview tab without a separate event stream.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use crate::shared::document_file::document_mime_for_path;

/// Bound on paths carried by one emission; a bulk export only needs the latest.
const MAX_PENDING: usize = 32;

pub struct ChangedDocuments {
    root: PathBuf,
    pending: Mutex<Vec<String>>,
}

impl ChangedDocuments {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            pending: Mutex::new(Vec::new()),
        }
    }

    /// Note `path` if it's a previewable document that still exists (a
    /// deletion is a change too, but there is nothing to preview).
    pub fn record(&self, path: &Path) {
        if document_mime_for_path(path).is_none() || !path.is_file() {
            return;
        }
        let Ok(relative) = path.strip_prefix(&self.root) else {
            return;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        // Most recent last: move a re-written path to the end.
        pending.retain(|existing| existing != &relative);
        pending.push(relative);
        let overflow = pending.len().saturating_sub(MAX_PENDING);
        pending.drain(..overflow);
    }

    /// Take everything recorded since the last call.
    pub fn drain(&self) -> Vec<String> {
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        std::mem::take(&mut *pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_existing_documents_relative_to_the_root_most_recent_last() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("out")).unwrap();
        for name in ["out/report.pdf", "deck.pptx", "notes.md"] {
            std::fs::write(root.join(name), b"x").unwrap();
        }
        let changed = ChangedDocuments::new(root.to_path_buf());
        changed.record(&root.join("out/report.pdf"));
        changed.record(&root.join("notes.md"));
        changed.record(&root.join("deck.pptx"));
        changed.record(&root.join("out/report.pdf"));
        changed.record(&root.join("missing.docx"));

        assert_eq!(changed.drain(), vec!["deck.pptx", "out/report.pdf"]);
        assert!(changed.drain().is_empty());
    }

    #[test]
    fn keeps_only_the_latest_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let changed = ChangedDocuments::new(root.to_path_buf());
        for index in 0..(MAX_PENDING + 5) {
            let path = root.join(format!("{index}.pdf"));
            std::fs::write(&path, b"x").unwrap();
            changed.record(&path);
        }
        let drained = changed.drain();
        assert_eq!(drained.len(), MAX_PENDING);
        assert_eq!(drained.last().unwrap(), &format!("{}.pdf", MAX_PENDING + 4));
    }
}
