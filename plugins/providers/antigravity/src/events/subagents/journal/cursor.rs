use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use serde_json::Value;

use super::super::store::open_file;

pub(super) const READ_BUDGET: usize = 256 * 1024;
const TASK_HEADER_BYTES: usize = 4096;

#[derive(Default)]
pub(super) struct JournalCursor {
    offset: u64,
    partial: Vec<u8>,
    skipping_oversize: bool,
    #[cfg(unix)]
    file_id: Option<(u64, u64)>,
}

impl JournalCursor {
    pub(super) fn read(&mut self, path: &Path) -> Vec<Value> {
        let Ok(mut file) = open_file(path) else {
            return Vec::new();
        };
        let Ok(metadata) = file.metadata() else {
            return Vec::new();
        };
        #[cfg(unix)]
        {
            let file_id = (metadata.dev(), metadata.ino());
            if self.file_id != Some(file_id) {
                *self = Self::default();
                self.file_id = Some(file_id);
            }
        }
        if metadata.len() < self.offset {
            self.offset = 0;
            self.partial.clear();
            self.skipping_oversize = false;
        }
        if metadata.len() == self.offset || file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file
            .take(READ_BUDGET as u64)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return Vec::new();
        }
        self.offset += bytes.len() as u64;
        self.parse_chunk(&bytes)
    }

    fn parse_chunk(&mut self, bytes: &[u8]) -> Vec<Value> {
        let mut rows = Vec::new();
        for line in bytes.split_inclusive(|byte| *byte == b'\n') {
            let complete = line.ends_with(b"\n");
            if !self.skipping_oversize {
                if self.partial.len() + line.len() <= READ_BUDGET {
                    self.partial.extend_from_slice(line);
                } else {
                    self.partial.truncate(TASK_HEADER_BYTES);
                    let needed = TASK_HEADER_BYTES - self.partial.len();
                    self.partial
                        .extend_from_slice(&line[..needed.min(line.len())]);
                    self.skipping_oversize = true;
                }
            }
            if complete {
                let row = if self.skipping_oversize {
                    task_header(&mut self.partial)
                } else {
                    serde_json::from_slice(&self.partial).ok()
                };
                if let Some(row) = row {
                    rows.push(row);
                }
                self.partial.clear();
                self.skipping_oversize = false;
            }
        }
        rows
    }
}

/// agy writes step identity and status before its multiline content. For an
/// oversized command or notification only the leading content lines carry
/// lifecycle information. Never project this shortened text as tool output.
fn task_header(prefix: &mut Vec<u8>) -> Option<Value> {
    let newline = prefix.windows(2).rposition(|pair| pair == br"\n")?;
    prefix.truncate(newline + 2);
    prefix.extend_from_slice(br#""}"#);
    let row: Value = serde_json::from_slice(prefix).ok()?;
    match (
        row["source"].as_str(),
        row["type"].as_str(),
        row["status"].as_str(),
    ) {
        (Some("SYSTEM"), Some("SYSTEM_MESSAGE"), Some("DONE"))
        | (Some("MODEL"), Some("GENERIC"), Some("RUNNING")) => Some(row),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;

    use serde_json::json;

    use super::JournalCursor;

    #[test]
    fn resumes_a_partial_record_without_rereading_its_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        fs::write(&path, b"{\"step_index\":").unwrap();
        let mut cursor = JournalCursor::default();
        assert!(cursor.read(&path).is_empty());
        assert_eq!(cursor.offset, 14);
        assert!(cursor.read(&path).is_empty());
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"42}\n")
            .unwrap();
        assert_eq!(cursor.read(&path), [json!({"step_index": 42})]);
        assert!(cursor.read(&path).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn restarts_a_replaced_file_even_if_its_length_increases() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        fs::write(&path, b"true\n").unwrap();
        let mut cursor = JournalCursor::default();
        assert_eq!(cursor.read(&path), [json!(true)]);
        let replacement = dir.path().join("replacement");
        fs::write(&replacement, b"false\nnull\n").unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(cursor.read(&path), [json!(false), json!(null)]);
    }
}
