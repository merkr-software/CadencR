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
/// above [`LARGE_FILE_BYTES`] are classified from metadata plus an 8 KB binary
/// sniff without loading the entire object into memory.
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

/// Binary heuristic for an 8 KB prefix sniffed from a large file: detects a NUL
/// byte or invalid UTF-8 without false-positiving when a multi-byte UTF-8
/// character is split at the prefix truncation boundary.
pub(crate) fn head_is_binary(head: &[u8]) -> bool {
    let prefix = &head[..head.len().min(BINARY_SNIFF_BYTES)];
    if bytes_have_binary_marker(prefix) {
        return true;
    }
    match std::str::from_utf8(prefix) {
        Ok(_) => false,
        Err(error) => error.error_len().is_some(),
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

    #[test]
    fn head_is_binary_tolerates_utf8_character_split_at_sniff_boundary() {
        // 'é' is [0xC3, 0xA9]; ending the sniff buffer on 0xC3 is a truncation
        // boundary, not invalid UTF-8.
        let mut truncated = vec![b'a'; 10];
        truncated.push(0xC3);
        assert!(!head_is_binary(&truncated));

        // Genuine invalid UTF-8 byte is still detected as binary.
        assert!(head_is_binary(&[b'a', 0xFF, b'b']));
        assert!(head_is_binary(&[b'a', 0x00, b'b']));

        // Bytes beyond the sniff window are not scanned.
        let mut past_window = vec![b'a'; BINARY_SNIFF_BYTES + 16];
        past_window[BINARY_SNIFF_BYTES + 4] = 0xFF;
        assert!(!head_is_binary(&past_window));
    }
}
