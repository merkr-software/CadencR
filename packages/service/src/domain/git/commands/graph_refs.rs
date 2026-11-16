//! Parsing of git's `%D` commit decoration for the graph view.
//!
//! The graph logs with `--decorate=full`, so every label arrives with its
//! namespace (`refs/heads/…`, `refs/remotes/…`, `tag: refs/tags/…`). That is
//! the only reliable way to tell a local branch from a remote-tracking one:
//! short names cannot (`feature/x` and `origin/x` both contain a slash).

use crate::domain::git::models::{CommitRef, CommitRefKind};

/// Clean git's `--decorate=full` `%D` decoration into typed refs by short
/// name. Drops the symbolic `HEAD` / `origin/HEAD` pointers (pure clutter in
/// the UI) and any namespace that is not a branch or tag (`refs/stash`,
/// `refs/notes/…`), which would otherwise read as a branch named `refs/…`.
pub(super) fn parse_refs(decoration: &str) -> Vec<CommitRef> {
    decoration.split(',').filter_map(parse_ref).collect()
}

fn parse_ref(raw: &str) -> Option<CommitRef> {
    let raw = raw.trim();
    let (raw, checked_out) = match raw.strip_prefix("HEAD -> ") {
        Some(rest) => (rest, true),
        None => (raw, false),
    };
    let raw = raw.strip_prefix("tag: ").unwrap_or(raw);
    let (name, kind) = if let Some(name) = raw.strip_prefix("refs/heads/") {
        let kind = if checked_out {
            CommitRefKind::Head
        } else {
            CommitRefKind::Local
        };
        (name, kind)
    } else if let Some(name) = raw.strip_prefix("refs/remotes/") {
        (name, CommitRefKind::Remote)
    } else if let Some(name) = raw.strip_prefix("refs/tags/") {
        (name, CommitRefKind::Tag)
    } else {
        return None;
    };
    if name.is_empty() || name.ends_with("/HEAD") {
        return None;
    }
    Some(CommitRef {
        name: name.to_string(),
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(refs: &[CommitRef]) -> Vec<&str> {
        refs.iter().map(|r| r.name.as_str()).collect()
    }

    #[test]
    fn parse_refs_drops_symbolic_and_foreign_refs() {
        // A detached `HEAD`, `origin/HEAD` and non-branch namespaces are noise
        // — keep only the real branch/tag labels.
        let refs = parse_refs(
            "HEAD, refs/remotes/origin/HEAD, refs/stash, refs/notes/commits, refs/heads/main",
        );
        assert_eq!(names(&refs), vec!["main"]);
        assert!(parse_refs("").is_empty());
    }

    #[test]
    fn parse_refs_classifies_full_decorations() {
        let refs = parse_refs(
            "HEAD -> refs/heads/feature/x, refs/remotes/origin/feature/x, \
             refs/heads/main, tag: refs/tags/v1.0",
        );
        assert_eq!(
            refs,
            vec![
                CommitRef {
                    name: "feature/x".into(),
                    kind: CommitRefKind::Head
                },
                CommitRef {
                    name: "origin/feature/x".into(),
                    kind: CommitRefKind::Remote
                },
                CommitRef {
                    name: "main".into(),
                    kind: CommitRefKind::Local
                },
                CommitRef {
                    name: "v1.0".into(),
                    kind: CommitRefKind::Tag
                },
            ]
        );
    }
}
