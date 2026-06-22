/// Files at or above this byte size are flagged as "large" on read — the
/// frontend opens them in a read-only mode (no syntax highlighting, no LSP,
/// no auto-save) so CodeMirror stays responsive. Mirrored on the frontend
/// (`packages/desktop/src/lib/editor-thresholds.ts::LARGE_FILE_OPEN_BYTES`) —
/// keep the two in sync.
pub const LARGE_FILE_OPEN_BYTES: u64 = 1_000_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_is_one_megabyte() {
        assert_eq!(LARGE_FILE_OPEN_BYTES, 1_000_000);
    }

    #[test]
    fn classifies_sizes_around_threshold() {
        assert!(LARGE_FILE_OPEN_BYTES - 1 < LARGE_FILE_OPEN_BYTES);
        assert!(LARGE_FILE_OPEN_BYTES >= LARGE_FILE_OPEN_BYTES);
        assert!(LARGE_FILE_OPEN_BYTES + 1 >= LARGE_FILE_OPEN_BYTES);
    }
}
