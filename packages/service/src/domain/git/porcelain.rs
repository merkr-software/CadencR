//! Porcelain v2 parsers shared by the Git workflow endpoints.
//!
//! `git_status::compute_status` parses the same format for the WS snapshot;
//! the file-list parser here is the per-row variant used by the commit
//! dialog (`GET /api/git/uncommitted-files`). Format spec:
//! <https://git-scm.com/docs/git-status>.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::models::{ConflictKind, FileStageState};

/// One row per uncommitted file. `status` is one of `"staged"`, `"unstaged"`,
/// `"untracked"`, or `"both"` (staged + further unstaged change). `change_kind`
/// is the porcelain v2 letter mapped to a friendly token: `"added"`,
/// `"modified"`, `"deleted"`, `"renamed"`, or `"untracked"`.
///
/// `additions`/`deletions` are filled from `git diff --numstat` (sum of staged
/// and unstaged sides). Untracked files get `additions` from a streamed line
/// count (git's numstat never covers them) and `deletions: 0`. Binary files
/// stay at `0` (numstat reports `-`; untracked binaries are skipped the same way).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UncommittedFile {
    pub path: String,
    pub status: String,
    pub change_kind: String,
    #[serde(default)]
    pub additions: i32,
    #[serde(default)]
    pub deletions: i32,
    /// Typed equivalent of `status`; new consumers should prefer this field.
    #[serde(default)]
    pub stage_state: FileStageState,
    /// Canonical porcelain-v2 unmerged `XY` kind when the row is conflicted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_kind: Option<ConflictKind>,
}

/// Canonical decoded representation of one porcelain-v2 working-tree row.
///
/// Both public file-list shapes are projections of this type. Keeping rename
/// metadata, index/worktree state, and unmerged `XY` decoding here prevents
/// the changed-files and commit-dialog endpoints from disagreeing about the
/// same worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PorcelainFileEntry {
    pub(crate) path: String,
    pub(crate) old_path: Option<String>,
    pub(crate) status_code: String,
    pub(crate) change_kind: String,
    pub(crate) stage_state: FileStageState,
    pub(crate) conflict_kind: Option<ConflictKind>,
    pub(crate) additions: i32,
    pub(crate) deletions: i32,
}

impl PorcelainFileEntry {
    pub(crate) fn into_uncommitted(self) -> UncommittedFile {
        UncommittedFile {
            path: self.path,
            status: self.stage_state.legacy_status().to_string(),
            change_kind: self.change_kind,
            additions: self.additions,
            deletions: self.deletions,
            stage_state: self.stage_state,
            conflict_kind: self.conflict_kind,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct PorcelainFileEntryRef<'a> {
    pub(crate) path: &'a str,
    old_path: Option<&'a str>,
    status_code: &'a str,
    change_kind: &'static str,
    pub(crate) stage_state: FileStageState,
    pub(crate) conflict_kind: Option<ConflictKind>,
}

impl From<PorcelainFileEntryRef<'_>> for PorcelainFileEntry {
    fn from(entry: PorcelainFileEntryRef<'_>) -> Self {
        Self {
            path: entry.path.to_string(),
            old_path: entry.old_path.map(ToOwned::to_owned),
            status_code: entry.status_code.to_string(),
            change_kind: entry.change_kind.to_string(),
            stage_state: entry.stage_state,
            conflict_kind: entry.conflict_kind,
            additions: 0,
            deletions: 0,
        }
    }
}

/// Parse `git status --porcelain=v2` into a list of `UncommittedFile`s.
#[allow(dead_code)] // Convenience projection retained for non-stat consumers and tests.
pub fn parse_porcelain_v2_files(output: &str) -> Vec<UncommittedFile> {
    parse_porcelain_v2_entries(output)
        .into_iter()
        .map(PorcelainFileEntry::into_uncommitted)
        .collect()
}

pub(crate) fn parse_porcelain_v2_entries(output: &str) -> Vec<PorcelainFileEntry> {
    let mut out = Vec::new();
    visit_porcelain_v2_records(output, |record, nul_old_path| {
        if let Some(entry) = decode_porcelain_v2_record(record, nul_old_path) {
            out.push(entry.into());
        }
    });
    out
}

pub(crate) fn visit_porcelain_v2_records<'a>(
    output: &'a str,
    mut visit: impl FnMut(&'a str, Option<&'a str>),
) {
    if output.contains('\0') {
        let mut records = output.split_terminator('\0');
        while let Some(record) = records.next() {
            let old_path = record.starts_with("2 ").then(|| records.next()).flatten();
            visit(record, old_path);
        }
    } else {
        for record in output.lines() {
            visit(record, None);
        }
    }
}

pub(crate) fn decode_porcelain_v2_record<'a>(
    record: &'a str,
    nul_old_path: Option<&'a str>,
) -> Option<PorcelainFileEntryRef<'a>> {
    if let Some(path) = record.strip_prefix("? ") {
        return Some(PorcelainFileEntryRef {
            path,
            old_path: None,
            status_code: "A",
            change_kind: "untracked",
            stage_state: FileStageState::Untracked,
            conflict_kind: None,
        });
    }
    if let Some(rest) = record.strip_prefix("1 ") {
        return decode_changed_entry(rest, false, None);
    }
    if let Some(rest) = record.strip_prefix("2 ") {
        return decode_changed_entry(rest, true, nul_old_path);
    }
    let rest = record.strip_prefix("u ")?;
    let path = unmerged_path(rest)?;
    let xy = rest.get(..2)?;
    Some(PorcelainFileEntryRef {
        path,
        old_path: None,
        status_code: xy,
        change_kind: "modified",
        stage_state: FileStageState::Conflicted,
        conflict_kind: parse_conflict_kind(xy),
    })
}

/// Map a porcelain v2 XY pair to (status, change_kind). For ordinary `1`/`2`
/// rows, X is the index side (staged) and Y is the worktree side (unstaged);
/// in v2 the unchanged side is `.`, not space.
fn classify_xy(x: char, y: char) -> (&'static str, FileStageState) {
    let staged = x != '.';
    let stage_state = FileStageState::from_xy(x, y);
    let kind_letter = if staged { x } else { y };
    let change_kind = match kind_letter {
        'A' => "added",
        'M' => "modified",
        'D' => "deleted",
        'R' | 'C' => "renamed",
        _ => "modified",
    };
    (change_kind, stage_state)
}

/// Format reference for ordinary changed entries:
///   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
/// Renamed/copied entries add a `<X><score>` field and a tab-separated
/// `<path>\t<orig_path>` tail:
///   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<orig>`
/// So we skip 7 whitespace-separated tokens for kind=1 and 8 for kind=2,
/// then take the rest as the path (stopping at the tab for kind=2).
fn decode_changed_entry<'a>(
    rest: &'a str,
    renamed: bool,
    nul_old_path: Option<&'a str>,
) -> Option<PorcelainFileEntryRef<'a>> {
    let mut chars = rest.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    let (change_kind, stage_state) = classify_xy(x, y);
    let skip = if renamed { 8 } else { 7 };
    let tail = skip_fields(rest, skip)?;
    let (path, old_path) = if renamed {
        if let Some(old_path) = nul_old_path {
            (tail, Some(old_path))
        } else {
            let mut paths = tail.splitn(2, '\t');
            (paths.next().unwrap_or(""), paths.next())
        }
    } else {
        (tail, None)
    };
    if path.is_empty() {
        return None;
    }
    let status_code = if renamed {
        rest.split_whitespace().nth(7).unwrap_or("R")
    } else if x != '.' {
        rest.get(..1).unwrap_or("M")
    } else {
        rest.get(1..2).unwrap_or("M")
    };
    Some(PorcelainFileEntryRef {
        path,
        old_path,
        status_code,
        change_kind,
        stage_state,
        conflict_kind: None,
    })
}

/// Sum the two diff sides for ordinary rows. Unmerged paths can appear in
/// both diffs with the same synthetic conflict stat; use the per-column
/// maximum there so one porcelain `u` row never gets its stats doubled.
pub(crate) fn attach_stats(
    mut entry: PorcelainFileEntry,
    staged: &HashMap<String, (i32, i32)>,
    unstaged: &HashMap<String, (i32, i32)>,
) -> PorcelainFileEntry {
    let staged = lookup_stats(&entry, staged);
    let unstaged = lookup_stats(&entry, unstaged);
    let (additions, deletions) = if entry.stage_state == FileStageState::Conflicted {
        let staged = staged.unwrap_or_default();
        let unstaged = unstaged.unwrap_or_default();
        (staged.0.max(unstaged.0), staged.1.max(unstaged.1))
    } else {
        let staged = staged.unwrap_or_default();
        let unstaged = unstaged.unwrap_or_default();
        (staged.0 + unstaged.0, staged.1 + unstaged.1)
    };
    entry.additions = additions;
    entry.deletions = deletions;
    entry
}

fn lookup_stats(
    entry: &PorcelainFileEntry,
    stats: &HashMap<String, (i32, i32)>,
) -> Option<(i32, i32)> {
    stats
        .get(&entry.path)
        .or_else(|| stats.get(entry.old_path.as_ref()?))
        .copied()
}

/// Skip `n` whitespace-separated fields and return the remainder of the
/// input (preserving any embedded `\t` so the rename split works). Returns
/// `None` if the input doesn't have at least `n` fields.
fn skip_fields(input: &str, n: usize) -> Option<&str> {
    let mut s = input;
    for _ in 0..n {
        let trimmed = s.trim_start();
        let end = trimmed.find(|c: char| c.is_whitespace())?;
        s = &trimmed[end..];
    }
    Some(s.trim_start())
}

/// Unmerged: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`.
/// Nine fields before the path.
fn unmerged_path(rest: &str) -> Option<&str> {
    let path = skip_fields(rest, 9)?;
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn parse_conflict_kind(xy: &str) -> Option<ConflictKind> {
    match xy {
        "DD" => Some(ConflictKind::Dd),
        "AU" => Some(ConflictKind::Au),
        "UD" => Some(ConflictKind::Ud),
        "UA" => Some(ConflictKind::Ua),
        "DU" => Some(ConflictKind::Du),
        "AA" => Some(ConflictKind::Aa),
        "UU" => Some(ConflictKind::Uu),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_untracked_into_untracked_status() {
        let out = "? new.txt\n? sub/dir/other.md\n";
        let files = parse_porcelain_v2_files(out);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].status, "untracked");
        assert_eq!(files[0].change_kind, "untracked");
        assert_eq!(files[1].path, "sub/dir/other.md");
    }

    #[test]
    fn parses_staged_only_change() {
        let out = "1 M. N... 100644 100644 100644 abc def src/a.rs\n";
        let files = parse_porcelain_v2_files(out);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!(files[0].status, "staged");
        assert_eq!(files[0].change_kind, "modified");
    }

    #[test]
    fn parses_unstaged_only_change() {
        let out = "1 .M N... 100644 100644 100644 abc def src/a.rs\n";
        let files = parse_porcelain_v2_files(out);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "unstaged");
        assert_eq!(files[0].change_kind, "modified");
    }

    #[test]
    fn parses_both_staged_and_unstaged_change() {
        let out = "1 MM N... 100644 100644 100644 abc def src/a.rs\n";
        let files = parse_porcelain_v2_files(out);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "both");
        assert_eq!(files[0].change_kind, "modified");
    }

    #[test]
    fn parses_added_and_deleted_change_kinds() {
        let out = "\
1 A. N... 000000 100644 100644 0000 abc new.rs
1 D. N... 100644 000000 100644 abc 0000 gone.rs
";
        let files = parse_porcelain_v2_files(out);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].change_kind, "added");
        assert_eq!(files[1].change_kind, "deleted");
    }

    #[test]
    fn parses_renamed_entry_picks_new_path() {
        let out = "2 R. N... 100644 100644 100644 abc def R100 newname.rs\toldname.rs\n";
        let files = parse_porcelain_v2_files(out);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "newname.rs");
        assert_eq!(files[0].status, "staged");
        assert_eq!(files[0].change_kind, "renamed");
        let entries = parse_porcelain_v2_entries(out);
        assert_eq!(entries[0].old_path.as_deref(), Some("oldname.rs"));
    }

    #[test]
    fn parses_nul_delimited_paths_without_git_quoting() {
        let out = concat!(
            "2 R. N... 100644 100644 100644 abc def R100 new name\0",
            "old name\0",
            "? quote\"name\0",
            "? line\nbreak\0",
        );
        let entries = parse_porcelain_v2_entries(out);

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "new name");
        assert_eq!(entries[0].old_path.as_deref(), Some("old name"));
        assert_eq!(entries[1].path, "quote\"name");
        assert_eq!(entries[2].path, "line\nbreak");
    }

    #[test]
    fn parses_unmerged_entry_as_both() {
        let out = "u UU N... 100644 100644 100644 100644 a b c conflict.rs\n";
        let files = parse_porcelain_v2_files(out);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "conflict.rs");
        assert_eq!(files[0].status, "both");
        assert_eq!(files[0].stage_state, FileStageState::Conflicted);
        assert_eq!(files[0].conflict_kind, Some(ConflictKind::Uu));
    }

    #[test]
    fn parses_every_canonical_conflict_kind() {
        for (xy, expected) in [
            ("DD", ConflictKind::Dd),
            ("AU", ConflictKind::Au),
            ("UD", ConflictKind::Ud),
            ("UA", ConflictKind::Ua),
            ("DU", ConflictKind::Du),
            ("AA", ConflictKind::Aa),
            ("UU", ConflictKind::Uu),
        ] {
            let out = format!("u {xy} N... 100644 100644 100644 100644 a b c conflict-{xy}.rs\n");
            let files = parse_porcelain_v2_files(&out);
            assert_eq!(files[0].conflict_kind, Some(expected), "XY={xy}");
        }
    }

    // --- Real-git consistency tests ---
    // Run actual `git` against a tempdir so a future git release that tweaks
    // porcelain v2 (or our command-line glue) is caught here.

    use std::path::Path;
    use std::process::Command as ProcCommand;

    struct RealRepo {
        _tmp: tempfile::TempDir,
        path: std::path::PathBuf,
    }

    impl RealRepo {
        fn init() -> Self {
            let tmp = tempfile::tempdir().expect("tempdir");
            let path = tmp.path().to_path_buf();
            for cfg in [
                &["init", "-q", "-b", "main"][..],
                &["config", "user.email", "t@example.com"],
                &["config", "user.name", "T"],
                &["config", "commit.gpgsign", "false"],
                &["config", "tag.gpgsign", "false"],
            ] {
                run(&path, cfg);
            }
            Self { _tmp: tmp, path }
        }

        fn write(&self, rel: &str, contents: &[u8]) {
            let target = self.path.join(rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("mkdir");
            }
            std::fs::write(&target, contents).expect("write");
        }

        fn git(&self, args: &[&str]) {
            run(&self.path, args);
        }

        fn capture(&self, args: &[&str]) -> String {
            let output = ProcCommand::new("git")
                .args(args)
                .current_dir(&self.path)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", &self.path)
                .output()
                .expect("git capture");
            assert!(
                output.status.success(),
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        fn install_unmerged_stages(&self, stages: &[u8]) {
            use std::io::Write;
            use std::process::Stdio;

            self.write("blob-base", b"base\n");
            self.write("blob-ours", b"ours\n");
            self.write("blob-theirs", b"theirs\n");
            let blobs = [
                self.capture(&["hash-object", "-w", "blob-base"]),
                self.capture(&["hash-object", "-w", "blob-ours"]),
                self.capture(&["hash-object", "-w", "blob-theirs"]),
            ];
            self.git(&["read-tree", "--empty"]);
            let mut child = ProcCommand::new("git")
                .args(["update-index", "--index-info"])
                .current_dir(&self.path)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", &self.path)
                .stdin(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let input = stages
                .iter()
                .map(|stage| {
                    let oid = &blobs[usize::from(*stage - 1)];
                    format!("100644 {oid} {stage}\tconflict.txt\n")
                })
                .collect::<String>();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "update-index failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            if stages != [1] {
                self.write("conflict.txt", b"worktree\n");
            }
        }

        fn porcelain(&self) -> String {
            let out = ProcCommand::new("git")
                .args(["status", "--porcelain=v2", "-z"])
                .current_dir(&self.path)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("HOME", &self.path)
                .output()
                .expect("git status spawn");
            assert!(
                out.status.success(),
                "git status failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout).expect("non-utf8 porcelain")
        }
    }

    fn run(dir: &Path, args: &[&str]) {
        let out = ProcCommand::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("HOME", dir)
            .output()
            .expect("git spawn");
        assert!(
            out.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn find<'a>(files: &'a [UncommittedFile], path: &str) -> &'a UncommittedFile {
        files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("missing {path} in {files:?}"))
    }

    /// Seed a repo with an `a.txt` committed to HEAD. Lets each follow-up
    /// case start from a one-commit baseline without 4 lines of preamble.
    fn seeded_repo() -> RealRepo {
        let repo = RealRepo::init();
        repo.write("a.txt", b"v1\n");
        repo.git(&["add", "a.txt"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo
    }

    #[test]
    fn real_git_staged_only_file() {
        let repo = seeded_repo();
        repo.write("a.txt", b"v2\n");
        repo.git(&["add", "a.txt"]);
        let f = find(&parse_porcelain_v2_files(&repo.porcelain()), "a.txt").clone();
        assert_eq!(f.status, "staged");
        assert_eq!(f.change_kind, "modified");
    }

    #[test]
    fn real_git_unstaged_only_file() {
        let repo = seeded_repo();
        repo.write("a.txt", b"v2\n");
        let f = find(&parse_porcelain_v2_files(&repo.porcelain()), "a.txt").clone();
        assert_eq!(f.status, "unstaged");
        assert_eq!(f.change_kind, "modified");
    }

    #[test]
    fn real_git_staged_and_unstaged_same_file_is_both() {
        let repo = seeded_repo();
        repo.write("a.txt", b"v2\n");
        repo.git(&["add", "a.txt"]);
        repo.write("a.txt", b"v3\n");
        let f = find(&parse_porcelain_v2_files(&repo.porcelain()), "a.txt").clone();
        assert_eq!(f.status, "both", "expected both, got: {f:?}");
    }

    #[test]
    fn real_git_untracked_file() {
        let repo = RealRepo::init();
        repo.write("seed.txt", b"seed\n");
        repo.git(&["add", "seed.txt"]);
        repo.git(&["commit", "-q", "-m", "seed"]);
        repo.write("new.txt", b"new\n");

        let files = parse_porcelain_v2_files(&repo.porcelain());
        let f = find(&files, "new.txt");
        assert_eq!(f.status, "untracked");
        assert_eq!(f.change_kind, "untracked");
    }

    #[test]
    fn real_git_deleted_file() {
        let repo = RealRepo::init();
        repo.write("gone.txt", b"bye\n");
        repo.git(&["add", "gone.txt"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        std::fs::remove_file(repo.path.join("gone.txt")).unwrap();

        let files = parse_porcelain_v2_files(&repo.porcelain());
        let f = find(&files, "gone.txt");
        assert_eq!(f.change_kind, "deleted");
        // Worktree-only deletion (no `git rm`) shows up as unstaged.
        assert_eq!(f.status, "unstaged");
    }

    #[test]
    fn real_git_renamed_file_picks_new_path() {
        let repo = RealRepo::init();
        repo.write("old.txt", b"hello\n");
        repo.git(&["add", "old.txt"]);
        repo.git(&["commit", "-q", "-m", "init"]);
        repo.git(&["mv", "old.txt", "new.txt"]);

        let files = parse_porcelain_v2_files(&repo.porcelain());
        let f = find(&files, "new.txt");
        assert_eq!(f.change_kind, "renamed");
        assert_eq!(f.status, "staged");
    }

    #[test]
    fn real_git_binary_file_classified_as_added() {
        // Tiny PNG-like blob with embedded NULs. Numstat reports `-` for
        // binaries; this test only pins the porcelain row.
        let repo = RealRepo::init();
        let mut bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x00];
        bytes.extend_from_slice(&[0u8; 16]);
        repo.write("img.bin", &bytes);
        repo.git(&["add", "img.bin"]);

        let files = parse_porcelain_v2_files(&repo.porcelain());
        let f = find(&files, "img.bin");
        assert_eq!(f.status, "staged");
        assert_eq!(f.change_kind, "added");
    }

    #[test]
    fn real_git_preserves_all_seven_unmerged_xy_kinds() {
        for (xy, stages, expected) in [
            ("DD", &[1][..], ConflictKind::Dd),
            ("AU", &[2][..], ConflictKind::Au),
            ("UD", &[1, 2][..], ConflictKind::Ud),
            ("UA", &[3][..], ConflictKind::Ua),
            ("DU", &[1, 3][..], ConflictKind::Du),
            ("AA", &[2, 3][..], ConflictKind::Aa),
            ("UU", &[1, 2, 3][..], ConflictKind::Uu),
        ] {
            let repo = seeded_repo();
            repo.install_unmerged_stages(stages);
            let entries = parse_porcelain_v2_entries(&repo.porcelain());
            let conflict = entries
                .iter()
                .find(|entry| entry.path == "conflict.txt")
                .unwrap_or_else(|| panic!("missing {xy} in {entries:?}"));
            assert_eq!(conflict.status_code, xy);
            assert_eq!(conflict.conflict_kind, Some(expected));
            assert_eq!(conflict.stage_state, FileStageState::Conflicted);
        }
    }
}
