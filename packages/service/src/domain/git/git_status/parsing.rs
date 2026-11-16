//! Pure parser for `git status --porcelain=v2 -b --ahead-behind` output.
//! Lives alongside `compute_status` (in the parent `mod.rs`) but stays self-
//! contained so the per-line decoding can be unit-tested without spawning
//! git, and so the parent file stays under the 400-line cap.

use std::collections::HashSet;

use crate::domain::git::models::FileStageState;
use crate::domain::git::porcelain::{decode_porcelain_v2_record, visit_porcelain_v2_records};

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct ParsedPorcelain {
    pub(super) current_branch: String,
    /// `branch.ab` ahead — `0` when there's no upstream configured. **Only
    /// meaningful when `upstream` is present**; without an upstream, git
    /// omits `branch.ab` and the ahead-of-remote count must be derived
    /// another way (see `count_unpushed` in the parent module).
    pub(super) ahead: u32,
    pub(super) behind: u32,
    /// Exact ref from `# branch.upstream <ref>`, when configured. Keeping the
    /// value lets the status hot path select an incoming upstream without
    /// rediscovering data Git already returned.
    pub(super) upstream: Option<String>,
    pub(super) staged_count: u32,
    pub(super) unstaged_count: u32,
    pub(super) untracked_count: u32,
    pub(super) conflict_count: u32,
}

/// Parse `git status --porcelain=v2 -b --ahead-behind` output.
///
/// Header lines start with `#`. Per-entry lines start with `1` (changed),
/// `2` (renamed/copied), `?` (untracked), or `u` (unmerged). For `1` and `2`
/// the next two characters are the XY status codes (X = staged, Y = unstaged;
/// `.` means unchanged on that side in v2).
pub(super) fn parse_porcelain_v2(output: &str) -> ParsedPorcelain {
    let mut p = ParsedPorcelain::default();

    let mut conflicts = HashSet::new();
    visit_porcelain_v2_records(output, |record, nul_old_path| {
        if let Some(rest) = record.strip_prefix("# branch.head ") {
            p.current_branch = rest.trim().to_string();
            // A detached HEAD shows up as `(detached)` (`DETACHED_HEAD`) — keep
            // it verbatim so the UI can display something sensible without
            // inventing a name.
        } else if let Some(rest) = record.strip_prefix("# branch.upstream ") {
            p.upstream = Some(rest.trim().to_string());
        } else if let Some(rest) = record.strip_prefix("# branch.ab ") {
            // Format: `+<ahead> -<behind>`
            let mut parts = rest.split_whitespace();
            if let Some(a) = parts.next() {
                p.ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(b) = parts.next() {
                p.behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(entry) = decode_porcelain_v2_record(record, nul_old_path) {
            match entry.stage_state {
                FileStageState::Staged => p.staged_count += 1,
                FileStageState::Unstaged => p.unstaged_count += 1,
                FileStageState::Both => {
                    p.staged_count += 1;
                    p.unstaged_count += 1;
                }
                FileStageState::Untracked => p.untracked_count += 1,
                FileStageState::Conflicted => {
                    p.staged_count += 1;
                    p.unstaged_count += 1;
                    conflicts.insert(entry.path);
                }
                FileStageState::NotApplicable => {}
            }
        }
    });
    p.conflict_count = u32::try_from(conflicts.len()).unwrap_or(u32::MAX);

    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_repo() {
        let out = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.current_branch, "main");
        assert_eq!(p.ahead, 0);
        assert_eq!(p.behind, 0);
        assert_eq!(p.upstream.as_deref(), Some("origin/main"));
        assert_eq!(p.staged_count, 0);
        assert_eq!(p.unstaged_count, 0);
        assert_eq!(p.untracked_count, 0);
    }

    #[test]
    fn parses_staged_only() {
        // `M.` = staged-modified, unchanged in worktree
        let out = "# branch.head feat\n# branch.ab +0 -0\n1 M. N... 100644 100644 100644 abc def src/a.rs\n";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.staged_count, 1);
        assert_eq!(p.unstaged_count, 0);
        assert_eq!(p.untracked_count, 0);
    }

    #[test]
    fn parses_unstaged_only() {
        // `.M` = unchanged in index, modified in worktree
        let out = "# branch.head feat\n# branch.ab +0 -0\n1 .M N... 100644 100644 100644 abc def src/a.rs\n";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.staged_count, 0);
        assert_eq!(p.unstaged_count, 1);
    }

    #[test]
    fn parses_both_staged_and_unstaged_for_same_file() {
        // `MM` = staged change AND further unstaged change
        let out = "# branch.head feat\n# branch.ab +0 -0\n1 MM N... 100644 100644 100644 abc def src/a.rs\n";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.staged_count, 1);
        assert_eq!(p.unstaged_count, 1);
    }

    #[test]
    fn parses_untracked() {
        let out = "# branch.head feat\n# branch.ab +0 -0\n? new.txt\n? other.md\n";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.untracked_count, 2);
        assert_eq!(p.staged_count, 0);
        assert_eq!(p.unstaged_count, 0);
    }

    #[test]
    fn parses_ahead_behind() {
        let out = "# branch.head feat\n# branch.upstream origin/feat\n# branch.ab +3 -1\n";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.ahead, 3);
        assert_eq!(p.behind, 1);
        assert_eq!(p.upstream.as_deref(), Some("origin/feat"));
    }

    #[test]
    fn parses_no_upstream_when_branch_upstream_is_missing() {
        // Local-only branch (never pushed): git omits `# branch.upstream`
        // entirely. The missing ref drives the `count_unpushed` fallback.
        let out = "# branch.head feat\n? new.txt\n";
        let p = parse_porcelain_v2(out);
        assert!(p.upstream.is_none());
        assert_eq!(p.ahead, 0);
    }

    #[test]
    fn parses_renamed_entry_as_staged() {
        // `R.` = renamed in index, unchanged in worktree (kind=2 line)
        let out = "# branch.head feat\n# branch.ab +0 -0\n2 R. N... 100644 100644 100644 abc def R100 new.rs\told.rs\n";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.staged_count, 1);
        assert_eq!(p.unstaged_count, 0);
    }

    #[test]
    fn parses_unmerged_as_both_staged_and_unstaged() {
        let out = "# branch.head feat\n# branch.ab +0 -0\nu UU N... 100644 100644 100644 100644 a b c conflict.rs\nu UU N... 100644 100644 100644 100644 a b c conflict.rs\n";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.staged_count, 2);
        assert_eq!(p.unstaged_count, 2);
        assert_eq!(p.conflict_count, 1);
    }

    #[test]
    fn missing_branch_ab_means_no_upstream() {
        // When there's no upstream, git omits `branch.ab` entirely.
        let out = "# branch.head feat\n? new.txt\n";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.ahead, 0);
        assert_eq!(p.behind, 0);
        assert_eq!(p.untracked_count, 1);
    }

    #[test]
    fn mixed_real_world_output() {
        let out = "\
# branch.oid 1234567890\n\
# branch.head feat/x\n\
# branch.upstream origin/feat/x\n\
# branch.ab +2 -1\n\
1 .M N... 100644 100644 100644 a b src/a.rs\n\
1 M. N... 100644 100644 100644 c d src/b.rs\n\
1 MM N... 100644 100644 100644 e f src/c.rs\n\
? untracked.txt\n\
? another.txt\n\
";
        let p = parse_porcelain_v2(out);
        assert_eq!(p.current_branch, "feat/x");
        assert_eq!(p.ahead, 2);
        assert_eq!(p.behind, 1);
        // staged: b.rs (M.), c.rs (MM) = 2
        assert_eq!(p.staged_count, 2);
        // unstaged: a.rs (.M), c.rs (MM) = 2
        assert_eq!(p.unstaged_count, 2);
        assert_eq!(p.untracked_count, 2);
    }
}
