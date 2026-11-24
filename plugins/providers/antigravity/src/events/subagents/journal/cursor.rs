use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::ops::Range;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::Value;

use super::projection::{PendingRow, ProjectedRow};

pub(super) const READ_BUDGET: usize = 256 * 1024;
const TAIL_BYTES: usize = 64;
const BASELINE_PEEK_BYTES: u64 = 16 * 1024;

pub(in crate::events) enum SeekOutcome {
    Positioned(Option<u64>),
    Reset,
}

#[derive(Deserialize)]
struct StepIndexRow {
    step_index: u64,
}

enum LineResult<T> {
    Row(T),
    Skip,
    Invalid,
}

#[derive(Default)]
pub(in crate::events) struct JournalCursor {
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
    pub(in crate::events) fn seek_to_offset(&mut self, path: &Path, offset: u64) -> SeekOutcome {
        *self = Self::default();
        if offset == 0 {
            return SeekOutcome::Reset;
        }
        let Ok(meta) = fs::symlink_metadata(path) else {
            return SeekOutcome::Reset;
        };
        if !meta.is_file() {
            return SeekOutcome::Reset;
        }
        let Ok(mut file) = File::open(path) else {
            return SeekOutcome::Reset;
        };
        let Ok(metadata) = file.metadata() else {
            return SeekOutcome::Reset;
        };
        let len = metadata.len();
        if offset > len {
            return SeekOutcome::Reset;
        }
        let Some((tail, last_step)) = read_tail_and_last_step(&mut file, offset) else {
            return SeekOutcome::Reset;
        };
        #[cfg(unix)]
        {
            self.file_id = Some((metadata.dev(), metadata.ino()));
        }
        self.offset = offset;
        self.revision = Some((len, metadata.modified().ok()));
        self.tail = tail;
        SeekOutcome::Positioned(last_step)
    }

    pub(super) fn read(&mut self, path: &Path) -> Vec<ProjectedRow> {
        self.read_with(
            path,
            |_, _| true,
            |line| {
                serde_json::from_slice(line)
                    .ok()
                    .map(ProjectedRow::from_value)
                    .map_or(LineResult::Invalid, LineResult::Row)
            },
            |decoded| decoded.map_or(LineResult::Invalid, LineResult::Row),
        )
    }

    pub(in crate::events) fn read_filtered<T>(
        &mut self,
        path: &Path,
        should_decode_oversized: impl FnMut(&mut File, Range<u64>) -> bool,
        mut parse_line: impl FnMut(&[u8]) -> Option<T>,
        mut parse_projected: impl FnMut(Value, bool) -> Option<T>,
    ) -> Vec<T> {
        self.read_with(
            path,
            should_decode_oversized,
            |line| parse_line(line).map_or(LineResult::Skip, LineResult::Row),
            |decoded| {
                decoded
                    .and_then(|row| parse_projected(row.value, row.content_truncated))
                    .map_or(LineResult::Skip, LineResult::Row)
            },
        )
    }

    fn read_with<T>(
        &mut self,
        path: &Path,
        should_decode_oversized: impl FnMut(&mut File, Range<u64>) -> bool,
        parse_line: impl FnMut(&[u8]) -> LineResult<T>,
        mut on_decoded: impl FnMut(Option<ProjectedRow>) -> LineResult<T>,
    ) -> Vec<T> {
        let Some((mut file, len)) = self.prepare_read(path) else {
            return Vec::new();
        };
        let mut rows = Vec::new();
        if let Some(decoding) = &mut self.decoding {
            let Some(result) = decoding.poll() else {
                self.backlog = true;
                return rows;
            };
            self.accept_result(on_decoded(result), &mut rows);
            self.decoding = None;
        }
        let Some(bytes) = self.read_chunk(&mut file, len) else {
            return rows;
        };
        let start = self.offset;
        self.parse_lines(&bytes, file, should_decode_oversized, parse_line, &mut rows);
        self.finish_chunk(start, &bytes, len);
        rows
    }

    fn prepare_read(&mut self, path: &Path) -> Option<(File, u64)> {
        self.backlog = false;
        let path_meta = fs::symlink_metadata(path).ok()?;
        if !path_meta.is_file() {
            return None;
        }
        let path_len = path_meta.len();
        let path_rev = (path_len, path_meta.modified().ok());
        #[cfg(unix)]
        let same_file = self.file_id == Some((path_meta.dev(), path_meta.ino()));
        #[cfg(not(unix))]
        let same_file = self.revision.is_some();
        if self.decoding.is_none()
            && same_file
            && path_len == self.offset
            && self.revision == Some(path_rev)
        {
            return None;
        }
        let mut file = File::open(path).ok()?;
        let metadata = file.metadata().ok()?;
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
        Some((file, len))
    }

    fn read_chunk(&self, file: &mut File, len: u64) -> Option<Vec<u8>> {
        if len == self.offset || file.seek(SeekFrom::Start(self.offset)).is_err() {
            return None;
        }
        let cap = len.saturating_sub(self.offset).min(READ_BUDGET as u64) as usize;
        let mut bytes = Vec::with_capacity(cap.saturating_add(1));
        file.take(READ_BUDGET as u64).read_to_end(&mut bytes).ok()?;
        Some(bytes)
    }

    fn finish_chunk(&mut self, start: u64, bytes: &[u8], len: u64) {
        let consumed = (self.offset - start) as usize;
        let tail = &bytes[consumed.saturating_sub(TAIL_BYTES)..consumed];
        let discard = self.tail.len().saturating_sub(TAIL_BYTES - tail.len());
        drop(self.tail.drain(..discard));
        self.tail.extend_from_slice(tail);
        self.backlog = self.decoding.is_some() || self.offset < len;
    }

    fn matches_tail(&self, file: &mut File) -> bool {
        // Native snapshots can rewrite an existing inode and grow at the same
        // time. Check the boundary before treating those bytes as an append.
        let mut bytes = [0; TAIL_BYTES];
        let len = self.tail.len();
        read_exact_at(file, self.offset - len as u64, &mut bytes[..len])
            && self.tail == bytes[..len]
    }

    pub(super) fn has_backlog(&self) -> bool {
        self.backlog
    }

    pub(super) fn take_invalid_record(&mut self) -> bool {
        std::mem::take(&mut self.invalid_record)
    }

    fn parse_lines<T>(
        &mut self,
        bytes: &[u8],
        mut file: File,
        mut should_decode_oversized: impl FnMut(&mut File, Range<u64>) -> bool,
        mut parse_line: impl FnMut(&[u8]) -> LineResult<T>,
        rows: &mut Vec<T>,
    ) {
        for line in bytes.split_inclusive(|byte| *byte == b'\n') {
            let complete = line.ends_with(b"\n");
            if self.oversized_start.is_none()
                && self.partial.is_empty()
                && complete
                && line.len() <= READ_BUDGET
            {
                self.offset += line.len() as u64;
                self.accept_result(parse_line(line), rows);
                continue;
            }
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
                let range = start..self.offset;
                if should_decode_oversized(&mut file, range.clone()) {
                    let mut decoding = PendingRow::new(file, range);
                    // Start now and let the next poll collect the result.
                    drop(decoding.poll());
                    self.decoding = Some(decoding);
                    return;
                }
                continue;
            }
            let result = parse_line(&self.partial);
            self.accept_result(result, rows);
            self.partial.clear();
        }
    }

    fn accept_result<T>(&mut self, result: LineResult<T>, rows: &mut Vec<T>) {
        match result {
            LineResult::Row(row) => rows.push(row),
            LineResult::Skip => {}
            LineResult::Invalid => self.invalid_record = true,
        }
    }
}

pub(in crate::events) fn read_exact_at(file: &mut File, start: u64, buf: &mut [u8]) -> bool {
    file.seek(SeekFrom::Start(start))
        .and_then(|_| file.read_exact(buf))
        .is_ok()
}

fn read_tail_and_last_step(file: &mut File, end: u64) -> Option<(Vec<u8>, Option<u64>)> {
    let start = end.saturating_sub(BASELINE_PEEK_BYTES);
    let mut bytes = vec![0; (end - start) as usize];
    if !read_exact_at(file, start, &mut bytes) {
        return None;
    }
    let tail = bytes[bytes.len().saturating_sub(TAIL_BYTES)..].to_vec();
    let mut step = last_step_index_in_bytes(&bytes, start > 0);
    if step.is_none() && start > 0 {
        let wide_start = end.saturating_sub(READ_BUDGET as u64);
        let prefix_len = (start - wide_start) as usize;
        let mut wide = vec![0; prefix_len + bytes.len()];
        if read_exact_at(file, wide_start, &mut wide[..prefix_len]) {
            wide[prefix_len..].copy_from_slice(&bytes);
            step = last_step_index_in_bytes(&wide, wide_start > 0);
        }
    }
    Some((tail, step))
}

fn last_step_index_in_bytes(bytes: &[u8], skip_first_partial: bool) -> Option<u64> {
    let mut lines = bytes.rsplit(|&byte| byte == b'\n').peekable();
    while let Some(line) = lines.next() {
        if skip_first_partial && lines.peek().is_none() {
            break;
        }
        let trimmed = line.trim_ascii();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_slice::<StepIndexRow>(trimmed) {
            return Some(row.step_index);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::time::{Duration, SystemTime};

    use serde_json::json;

    use super::{JournalCursor, SeekOutcome, BASELINE_PEEK_BYTES, READ_BUDGET};

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

    #[test]
    fn seek_to_offset_handles_mid_utf8_peek_boundary_large_last_rows_and_shrunk_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        // Line 1 is filled with 4-byte emojis so `baseline - 16 KiB` lands strictly
        // inside a multi-byte UTF-8 character, followed by a small step 4 row.
        let line1 = format!(
            "{{\"step_index\":0,\"content\":\"{}\"}}\n",
            "🙂".repeat(2500)
        );
        let line2 = format!(
            "{{\"step_index\":4,\"content\":\"{}\"}}\n",
            "a".repeat(8000)
        );
        let content = format!("{line1}{line2}");
        let baseline = content.len() as u64;
        let peek_start = (baseline - BASELINE_PEEK_BYTES) as usize;
        assert!(
            !content.is_char_boundary(peek_start),
            "test must split a multi-byte UTF-8 sequence at baseline - 16 KiB"
        );
        fs::write(&path, &content).unwrap();
        let mut cursor = JournalCursor::default();
        assert!(matches!(
            cursor.seek_to_offset(&path, baseline),
            SeekOutcome::Positioned(Some(4))
        ));

        // Now place a >16 KiB row at the end so the 256 KiB fallback must find step 9.
        let large_row = format!(
            "{{\"step_index\":9,\"content\":\"{}\"}}\n",
            "x".repeat(BASELINE_PEEK_BYTES as usize + 512)
        );
        let with_large = format!("{content}{large_row}");
        let baseline_large = with_large.len() as u64;
        fs::write(&path, &with_large).unwrap();
        assert!(matches!(
            cursor.seek_to_offset(&path, baseline_large),
            SeekOutcome::Positioned(Some(9))
        ));

        // If the file shrank before seek_to_offset, reset to 0 so rewritten rows are read.
        fs::write(&path, "{\"step_index\":1,\"content\":\"rewritten\"}\n").unwrap();
        assert!(matches!(
            cursor.seek_to_offset(&path, baseline_large),
            SeekOutcome::Reset
        ));
        let rows = cursor.read(&path);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].value["content"], "rewritten");
    }

    #[test]
    fn read_filtered_skips_oversized_rows_when_predicate_returns_false() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        let huge_output = "z".repeat(READ_BUDGET + 64 * 1024);
        let payload = format!(
            "{{\"step_index\":1,\"content\":\"{huge_output}\"}}\n{{\"step_index\":2,\"content\":\"keep\"}}\n"
        );
        fs::write(&path, payload).unwrap();

        let mut cursor = JournalCursor::default();
        let mut observed = Vec::new();
        let mut decode_calls = 0usize;
        let mut poll = |c: &mut JournalCursor| {
            c.read_filtered(
                &path,
                |_, _| {
                    decode_calls += 1;
                    false
                },
                |line| {
                    serde_json::from_slice::<serde_json::Value>(line)
                        .ok()
                        .filter(|v| v["content"] == "keep")
                        .and_then(|v| v["step_index"].as_u64())
                },
                |_, _| None,
            )
        };
        observed.extend(poll(&mut cursor));
        assert!(cursor.has_backlog());
        observed.extend(poll(&mut cursor));
        assert!(!cursor.has_backlog());
        assert_eq!(decode_calls, 1);
        assert_eq!(observed, vec![2]);
    }
}
