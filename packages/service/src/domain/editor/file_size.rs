/// Files at or above this byte size are flagged as "large" on read — the
/// frontend opens them in a read-only mode (no syntax highlighting, no LSP,
/// no auto-save) so CodeMirror stays responsive. Mirrored on the frontend
/// (`packages/desktop/src/lib/editor-thresholds.ts::LARGE_FILE_OPEN_BYTES`) —
/// keep the two in sync.
pub const LARGE_FILE_OPEN_BYTES: u64 = 1_000_000;

/// Whether a file of `len` bytes opens in the read-only "large file" mode.
pub fn is_large_file(len: u64) -> bool {
    len >= LARGE_FILE_OPEN_BYTES
}

/// Bound the editor's JSON write/format bodies, including JSON escaping. The
/// default 2 MiB limit blocks large files opened through "Edit anyway".
/// Use the read path's 100 MiB OOM ceiling as the total request budget, not a
/// guarantee that a 100 MiB file plus JSON escaping fits. Other APIs keep their
/// default limit.
pub const EDITOR_REQUEST_BODY_BYTES: usize = 100 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_is_one_megabyte() {
        assert_eq!(LARGE_FILE_OPEN_BYTES, 1_000_000);
    }

    #[test]
    fn classifies_sizes_around_threshold() {
        assert!(!is_large_file(LARGE_FILE_OPEN_BYTES - 1));
        assert!(is_large_file(LARGE_FILE_OPEN_BYTES));
        assert!(is_large_file(LARGE_FILE_OPEN_BYTES + 1));
    }
}
