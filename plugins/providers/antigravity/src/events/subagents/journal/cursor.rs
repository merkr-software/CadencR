use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::SystemTime;

use super::super::store::open_file;
use super::projection::{PendingRow, ProjectedRow};

pub(super) const READ_BUDGET: usize = 256 * 1024;
const TAIL_BYTES: usize = 64;

#[derive(Default)]
pub(super) struct JournalCursor {
    offset: u64,
    partial: Vec<u8>,
    oversized_start: Option<u64>,
    decoding: Option<PendingRow>,
    backlog: bool,
    invalid_record: bool,
    revision: Option<(u64, Option<SystemTime>)>,
    tail: Vec<u8>,
    #[cfg(unix)]
    file_id: Option<(u64, u64)>,
}

impl JournalCursor {
    pub(super) fn read(&mut self, path: &Path) -> Vec<ProjectedRow> {
        self.backlog = false;
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
        let len = metadata.len();
        let revision = (len, metadata.modified().ok());
        let rewritten = self.revision.replace(revision).is_some_and(|previous| {
            revision != previous && (len <= previous.0 || !self.matches_tail(&mut file))
        });
        if rewritten || len < self.offset {
            self.offset = 0;
            self.partial.clear();
            self.oversized_start = None;
            self.decoding = None;
            self.tail.clear();
        }
        let mut rows = Vec::new();
        if let Some(decoding) = &mut self.decoding {
            let Some(result) = decoding.poll() else {
                self.backlog = true;
                return rows;
            };
            self.accept(result, &mut rows);
            self.decoding = None;
        }
        if len == self.offset || file.seek(SeekFrom::Start(self.offset)).is_err() {
            return rows;
        }
        let mut bytes = Vec::new();
        if (&mut file)
            .take(READ_BUDGET as u64)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return rows;
        }
        let offset = self.offset;
        self.parse_chunk(&bytes, file, &mut rows);
        let consumed = (self.offset - offset) as usize;
        let tail = &bytes[consumed.saturating_sub(TAIL_BYTES)..consumed];
        let discard = self.tail.len().saturating_sub(TAIL_BYTES - tail.len());
        drop(self.tail.drain(..discard));
        self.tail.extend_from_slice(tail);
        self.backlog = self.decoding.is_some() || self.offset < len;
        rows
    }

    fn matches_tail(&self, file: &mut File) -> bool {
        // Native snapshots can rewrite an existing inode and grow at the same
        // time. Check the boundary before treating those bytes as an append.
        let mut bytes = [0; TAIL_BYTES];
        let len = self.tail.len();
        file.seek(SeekFrom::Start(self.offset - len as u64))
            .and_then(|_| file.read_exact(&mut bytes[..len]))
            .is_ok()
            && self.tail == bytes[..len]
    }

    pub(super) fn has_backlog(&self) -> bool {
        self.backlog
    }

    pub(super) fn take_invalid_record(&mut self) -> bool {
        std::mem::take(&mut self.invalid_record)
    }

    fn parse_chunk(&mut self, bytes: &[u8], file: File, rows: &mut Vec<ProjectedRow>) {
        for line in bytes.split_inclusive(|byte| *byte == b'\n') {
            let complete = line.ends_with(b"\n");
            if self.oversized_start.is_none() {
                if self.partial.len() + line.len() > READ_BUDGET {
                    self.oversized_start = Some(self.offset - self.partial.len() as u64);
                    self.partial.clear();
                } else {
                    self.partial.extend_from_slice(line);
                }
            }
            self.offset += line.len() as u64;
            if !complete {
                continue;
            }
            if let Some(start) = self.oversized_start.take() {
                let mut decoding = PendingRow::new(file, start..self.offset);
                // Start now and let the next poll collect the result.
                drop(decoding.poll());
                self.decoding = Some(decoding);
                return;
            }
            let row = serde_json::from_slice(&self.partial)
                .ok()
                .map(ProjectedRow::from_value);
            self.accept(row, rows);
            self.partial.clear();
        }
    }

    fn accept(&mut self, row: Option<ProjectedRow>, rows: &mut Vec<ProjectedRow>) {
        match row {
            Some(row) => rows.push(row),
            None => self.invalid_record = true,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::time::{Duration, SystemTime};

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
        assert_eq!(cursor.read(&path)[0].value, json!({"step_index": 42}));
        assert!(cursor.read(&path).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn restarts_a_replaced_file_even_if_its_length_increases() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        fs::write(&path, b"true\n").unwrap();
        let mut cursor = JournalCursor::default();
        assert_eq!(cursor.read(&path)[0].value, json!(true));
        let replacement = dir.path().join("replacement");
        fs::write(&replacement, b"false\nnull\n").unwrap();
        fs::rename(&replacement, &path).unwrap();
        let records = cursor.read(&path);
        assert_eq!(records[0].value, json!(false));
        assert_eq!(records[1].value, json!(null));
    }

    #[test]
    fn restarts_in_place_snapshots_of_the_same_size_or_larger() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        fs::write(&path, b"true \n").unwrap();
        fs::File::open(&path)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(100))
            .unwrap();
        let mut cursor = JournalCursor::default();
        assert_eq!(cursor.read(&path)[0].value, json!(true));

        fs::write(&path, b"false\n").unwrap();
        assert_eq!(cursor.read(&path)[0].value, json!(false));

        fs::write(&path, b"true \nnull\n").unwrap();
        let rows = cursor.read(&path);
        assert_eq!(rows[0].value, json!(true));
        assert_eq!(rows[1].value, json!(null));
    }
}
