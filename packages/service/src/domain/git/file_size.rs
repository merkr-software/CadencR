use crate::domain::git::models::FileContentBatchItem;

/// Files at or above this byte size are flagged as "large" — their content is
/// omitted from batch responses and the frontend renders a placeholder until
/// the user explicitly opts in. Picked to keep CodeMirror's synchronous Myers
/// diff under ~150 ms on Apple Silicon for code-shaped text.
pub const LARGE_FILE_BYTES: u64 = 200_000;

/// Number of bytes to sniff when probing for binary content (matches git's
/// own heuristic).
const BINARY_SNIFF_BYTES: usize = 8192;

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

pub(crate) fn bytes_have_binary_marker(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0)
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
}
