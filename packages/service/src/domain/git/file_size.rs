use std::ops::ControlFlow;

use crate::domain::git::models::FileContentBatchItem;

/// Files at or above this byte size are flagged as "large" — their content is
/// omitted from batch responses and the frontend renders a placeholder until
/// the user explicitly opts in. Picked to keep CodeMirror's synchronous Myers
/// diff under ~150 ms on Apple Silicon for code-shaped text.
pub const LARGE_FILE_BYTES: u64 = 200_000;

/// Number of bytes to sniff when probing for binary content (matches git's
/// own heuristic).
pub(crate) const BINARY_SNIFF_BYTES: usize = 8192;

/// One side of a file diff fetched for batch classification, where files at or
/// above [`LARGE_FILE_BYTES`] are classified while streamed (see
/// [`BinarySniffer`]) without loading the entire object into memory.
pub(crate) enum BatchSide {
    Missing,
    Inline(Vec<u8>),
    Large { size: u64, is_binary: bool },
}

/// Derive content, size, binary, and large-file metadata from fetched bytes.
/// Both single-file and batch endpoints use this path so invalid UTF-8 is
/// consistently binary content rather than an empty text file.
pub fn classify_content_bytes(
    file_path: String,
    old_content: Vec<u8>,
    new_content: Vec<u8>,
    keep_large_content: bool,
) -> FileContentBatchItem {
    let old_size = old_content.len() as u64;
    let new_size = new_content.len() as u64;
    let old_text = String::from_utf8(old_content);
    let new_text = String::from_utf8(new_content);
    let is_binary = old_text.is_err()
        || new_text.is_err()
        || old_text
            .as_ref()
            .is_ok_and(|content| bytes_have_binary_marker(content.as_bytes()))
        || new_text
            .as_ref()
            .is_ok_and(|content| bytes_have_binary_marker(content.as_bytes()));
    let is_large = old_size.max(new_size) >= LARGE_FILE_BYTES;
    let drop_content = is_binary || (is_large && !keep_large_content);
    let (old_content, new_content) = if drop_content {
        (None, None)
    } else {
        (old_text.ok(), new_text.ok())
    };

    FileContentBatchItem {
        file_path,
        old_content,
        new_content,
        old_size,
        new_size,
        is_binary,
        is_large,
    }
}

/// Classify a batch item whose sides were fetched with a [`LARGE_FILE_BYTES`]
/// read cap so multi-MB files are never loaded into memory just to be dropped.
pub(crate) fn classify_batch_sides(
    file_path: String,
    old: BatchSide,
    new: BatchSide,
) -> FileContentBatchItem {
    if matches!(old, BatchSide::Large { .. }) || matches!(new, BatchSide::Large { .. }) {
        let (old_size, old_binary) = side_meta(&old);
        let (new_size, new_binary) = side_meta(&new);
        return FileContentBatchItem {
            file_path,
            old_content: None,
            new_content: None,
            old_size,
            new_size,
            is_binary: old_binary || new_binary,
            is_large: true,
        };
    }
    classify_content_bytes(
        file_path,
        inline_bytes(old),
        inline_bytes(new),
        /* keep_large_content */ false,
    )
}

fn side_meta(side: &BatchSide) -> (u64, bool) {
    match side {
        BatchSide::Missing => (0, false),
        BatchSide::Inline(bytes) => (
            bytes.len() as u64,
            std::str::from_utf8(bytes).is_err() || bytes_have_binary_marker(bytes),
        ),
        BatchSide::Large { size, is_binary } => (*size, *is_binary),
    }
}

fn inline_bytes(side: BatchSide) -> Vec<u8> {
    match side {
        BatchSide::Inline(bytes) => bytes,
        BatchSide::Missing | BatchSide::Large { .. } => Vec::new(),
    }
}

pub(crate) fn bytes_have_binary_marker(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0)
}

/// Read cap of the single-file content endpoint (`GET /api/git/file-content`):
/// a side past it is refused there (`413 FILE_TOO_LARGE`), so the batch need
/// not read further to classify it either.
pub(crate) const MAX_SINGLE_FILE_SIDE_BYTES: usize = 16 * 1024 * 1024;

/// The binary verdict [`classify_content_bytes`] reaches on a whole side — a
/// NUL byte in its first [`BINARY_SNIFF_BYTES`] or invalid UTF-8 anywhere —
/// reached chunk by chunk, so a large side is classified like the single-file
/// endpoint classifies it without being held in memory.
#[derive(Default)]
pub(crate) struct BinarySniffer {
    seen: usize,
    /// The start of a UTF-8 character cut by the end of the last chunk.
    carry: Vec<u8>,
    binary: bool,
}

impl BinarySniffer {
    /// Feed the next chunk; breaks once the side is known to be binary.
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> ControlFlow<()> {
        if self.binary {
            return ControlFlow::Break(());
        }
        let window = BINARY_SNIFF_BYTES
            .saturating_sub(self.seen)
            .min(chunk.len());
        self.seen = self.seen.saturating_add(chunk.len());
        if bytes_have_binary_marker(&chunk[..window]) {
            self.binary = true;
            return ControlFlow::Break(());
        }
        let joined;
        let bytes = if self.carry.is_empty() {
            chunk
        } else {
            let mut carried = std::mem::take(&mut self.carry);
            carried.extend_from_slice(chunk);
            joined = carried;
            &joined[..]
        };
        match std::str::from_utf8(bytes) {
            Ok(_) => ControlFlow::Continue(()),
            Err(error) if error.error_len().is_some() => {
                self.binary = true;
                ControlFlow::Break(())
            }
            Err(error) => {
                self.carry = bytes[error.valid_up_to()..].to_vec();
                ControlFlow::Continue(())
            }
        }
    }

    /// The verdict. `complete` says the whole side was fed: a character still
    /// unfinished at its end is then invalid UTF-8, where a read stopped at a
    /// cap merely cut it.
    pub(crate) fn is_binary(&self, complete: bool) -> bool {
        self.binary || (complete && !self.carry.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(old: &str, new: &str, keep: bool) -> FileContentBatchItem {
        classify_content_bytes(
            "a.txt".into(),
            old.as_bytes().to_vec(),
            new.as_bytes().to_vec(),
            keep,
        )
    }

    #[test]
    fn classify_content_keeps_small_text() {
        let it = item("hello", "world!", false);
        assert_eq!(it.old_content.as_deref(), Some("hello"));
        assert_eq!(it.new_content.as_deref(), Some("world!"));
        assert_eq!(it.old_size, 5);
        assert_eq!(it.new_size, 6);
        assert!(!it.is_binary);
        assert!(!it.is_large);
    }

    #[test]
    fn classify_content_strips_large_text_in_batch_mode() {
        let big = "a".repeat(LARGE_FILE_BYTES as usize + 10);
        let it = item("", &big, false);
        assert!(it.is_large);
        assert!(!it.is_binary);
        assert!(it.old_content.is_none());
        assert!(it.new_content.is_none());
        assert_eq!(it.new_size, LARGE_FILE_BYTES + 10);
    }

    #[test]
    fn classify_content_keeps_large_text_when_opted_in() {
        let big = "a".repeat(LARGE_FILE_BYTES as usize + 10);
        let it = item("", &big, true);
        assert!(it.is_large);
        assert!(it.new_content.is_some());
    }

    #[test]
    fn classify_content_strips_binary_even_when_opted_in() {
        // NUL byte in the first 8 KB makes the content classify as binary.
        let bin = "hello\0world".to_string();
        let it = item("", &bin, true);
        assert!(it.is_binary);
        assert!(it.old_content.is_none());
        assert!(it.new_content.is_none());
    }

    #[test]
    fn classify_content_bytes_treats_invalid_utf8_as_binary() {
        let item = classify_content_bytes("a.bin".into(), Vec::new(), vec![0xff, 0xfe], true);
        assert!(item.is_binary);
        assert_eq!(item.new_size, 2);
        assert!(item.old_content.is_none());
        assert!(item.new_content.is_none());
    }

    #[test]
    fn classify_content_ignores_null_past_sniff_window() {
        // NUL beyond first 8 KB shouldn't classify as binary (matches git's
        // heuristic; avoids false positives on huge text files that happen
        // to include a NUL deep inside).
        let mut s = "a".repeat(BINARY_SNIFF_BYTES + 10);
        s.push('\0');
        let it = item("", &s, false);
        assert!(!it.is_binary);
    }

    fn sniff(chunks: &[&[u8]], complete: bool) -> bool {
        let mut sniffer = BinarySniffer::default();
        for chunk in chunks {
            if sniffer.feed(chunk).is_break() {
                break;
            }
        }
        sniffer.is_binary(complete)
    }

    /// The streamed verdict is the one `classify_content_bytes` reaches on the
    /// whole side, wherever the chunks happen to be cut.
    #[test]
    fn the_streamed_verdict_matches_the_whole_side_verdict() {
        let mut latin1 = vec![b'a'; LARGE_FILE_BYTES as usize];
        latin1.push(0xE9); // 'é' in Latin-1: invalid UTF-8 far past 8 KB.
        latin1.extend_from_slice(b" tail");
        let mut deep_nul = vec![b'a'; BINARY_SNIFF_BYTES + 10];
        deep_nul.push(0);
        let utf8 = "é".repeat(LARGE_FILE_BYTES as usize).into_bytes();
        let mut cut_at_end = b"abc".to_vec();
        cut_at_end.push(0xC3);
        for (side, expected) in [
            (latin1, true),
            (deep_nul, false),
            (utf8, false),
            (cut_at_end, true),
            (b"a\0b".to_vec(), true),
        ] {
            let whole = classify_content_bytes("f".into(), Vec::new(), side.clone(), true);
            assert_eq!(whole.is_binary, expected);
            for chunk_size in [1, 2, 3, 4096, 65536, side.len()] {
                let chunks: Vec<&[u8]> = side.chunks(chunk_size).collect();
                assert_eq!(sniff(&chunks, true), expected, "chunks of {chunk_size}");
            }
        }
    }

    /// A read stopped at the cap may cut a character in two: that is not
    /// invalid UTF-8. A NUL past the sniff window is not a binary marker.
    #[test]
    fn a_capped_read_does_not_count_its_cut_character() {
        assert!(!sniff(&[b"abc", &[0xC3]], false));
        assert!(sniff(&[b"abc", &[0xC3]], true));
        assert!(!sniff(&[b"abc", &[0xC3], &[0xA9]], true));
        assert!(sniff(&[b"a", &[0xFF], b"b"], false));
        let mut late = vec![b'a'; BINARY_SNIFF_BYTES];
        late.push(0);
        assert!(!sniff(&[&late], true));
    }
}
