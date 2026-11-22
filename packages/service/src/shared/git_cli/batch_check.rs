//! Shared parser for `git cat-file --batch-check=%(objectname)` output lines.

/// Parsed line from `git cat-file --batch-check=%(objectname)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BatchCheckEntry<'a> {
    /// Resolved object present in the object database (`<oid>`).
    Object(&'a str),
    /// Gitlink / submodule entry (`<oid> submodule`).
    Submodule(&'a str),
    /// Absent or ambiguous reference (`<spec> missing` / `<spec> ambiguous`).
    Missing { spec: &'a str },
}

/// True when `value` is a full lowercase hex Git object ID (SHA-1 or SHA-256).
pub(crate) fn is_valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Parse one line from `git cat-file --batch-check=%(objectname)`.
/// Returns `None` when the line does not match a known batch-check shape.
pub(crate) fn parse_batch_check_line(line: &str) -> Option<BatchCheckEntry<'_>> {
    if is_valid_oid(line) {
        return Some(BatchCheckEntry::Object(line));
    }
    if let Some(oid) = line
        .strip_suffix(" submodule")
        .filter(|oid| is_valid_oid(oid))
    {
        return Some(BatchCheckEntry::Submodule(oid));
    }
    for status in ["missing", "ambiguous"] {
        if let Some(spec) = line
            .strip_suffix(status)
            .and_then(|value| value.strip_suffix(' '))
        {
            return Some(BatchCheckEntry::Missing { spec });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_objects_submodules_and_missing_entries() {
        for len in [40, 64] {
            let oid = "a".repeat(len);
            assert!(is_valid_oid(&oid));
            assert_eq!(
                parse_batch_check_line(&oid),
                Some(BatchCheckEntry::Object(&oid))
            );
            let sub = format!("{oid} submodule");
            assert_eq!(
                parse_batch_check_line(&sub),
                Some(BatchCheckEntry::Submodule(&oid))
            );
        }
        assert_eq!(
            parse_batch_check_line("HEAD:foo bar missing"),
            Some(BatchCheckEntry::Missing {
                spec: "HEAD:foo bar"
            })
        );
        assert_eq!(
            parse_batch_check_line("deadbeef ambiguous"),
            Some(BatchCheckEntry::Missing { spec: "deadbeef" })
        );
    }

    #[test]
    fn rejects_invalid_oids_and_unknown_statuses() {
        assert!(!is_valid_oid(&"A".repeat(40)));
        assert!(!is_valid_oid(&"g".repeat(40)));
        assert!(!is_valid_oid(&"a".repeat(39)));
        assert_eq!(parse_batch_check_line("HEAD excluded"), None);
        assert_eq!(parse_batch_check_line("HEAD submodule"), None);
        assert_eq!(parse_batch_check_line(""), None);
    }
}
