//! The portable relative-path grammar plugin manifests and packages share.

/// Longest relative path a plugin may declare, in bytes.
pub const MAX_RELATIVE_PATH_BYTES: usize = 1024;

/// Relative, normalized, forward-slash only: every segment non-empty and
/// neither `.` nor `..`, no backslash or NUL, at most
/// [`MAX_RELATIVE_PATH_BYTES`]. Content-specific rules (such as refusing `:`)
/// are layered on by the caller.
pub fn is_normalized_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_RELATIVE_PATH_BYTES
        && !value.contains(['\\', '\0'])
        && !value.starts_with('/')
        && value
            .split('/')
            .all(|segment| !matches!(segment, "" | "." | ".."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_normalized_relative_paths() {
        for ok in ["a", "dist/index.html", "a:b", "x/y/z.svg"] {
            assert!(is_normalized_relative_path(ok), "{ok}");
        }
        let too_long = "a".repeat(MAX_RELATIVE_PATH_BYTES + 1);
        for bad in [
            "", "/a", "a//b", "./a", "a/..", "a\\b", "a\0b", "a/", &too_long,
        ] {
            assert!(!is_normalized_relative_path(bad), "{bad}");
        }
    }
}
