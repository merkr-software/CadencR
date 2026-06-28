use std::collections::HashMap;
use std::path::Path;

use chrono::DateTime;

use crate::app_state::AppState;
use crate::domain::git::models::*;
use crate::error::AppError;

pub async fn get_blame(
    state: &AppState,
    params: GetBlameParams,
) -> Result<BlameResponse, AppError> {
    let project_root = crate::domain::projects::service::resolve_feature_editor_root(
        &state.read_pool,
        params.project_id,
        params.feature_id,
    )
    .await?;
    // Confirm the file is inside the resolved root — blame is read-only but
    // still runs git from whatever cwd we pass, so contain it.
    let file_canonical =
        crate::domain::editor::service::validate_path(&project_root, &params.file_path)?;
    let relative = file_canonical
        .strip_prefix(&project_root)
        .map_err(|_| AppError::BadRequest("file outside project root".into()))?
        .to_string_lossy()
        .into_owned();
    // Files outside the index (node_modules, build artefacts, dotfiles in a
    // non-git directory) have no blame to report. Running `git blame` on them
    // fails with "no such path in HEAD" and spams the user with toast errors
    // on every editor open. Cheaper to ask up front.
    if !is_path_tracked(&project_root, &relative).await {
        return Ok(BlameResponse { lines: vec![] });
    }
    let output = crate::shared::git_cli::run_git_safe(
        &["blame"],
        &["--porcelain"],
        &[&relative],
        &project_root,
    )
    .await?;
    let lines = parse_blame_porcelain(&output);
    Ok(BlameResponse { lines })
}

/// `true` iff `relative` is tracked by the git repo rooted at `cwd`.
///
/// Uses `git ls-files -- <relative>`: when the path is tracked git prints
/// it on stdout; for untracked files (including paths outside any repo)
/// stdout is empty and the exit code is 0. Any spawn / non-repo failure is
/// treated as "not tracked" — we'd rather skip blame than surface a noisy
/// error to the user.
async fn is_path_tracked(cwd: &Path, relative: &str) -> bool {
    let out = crate::shared::git_cli::run_git_safe(&["ls-files"], &[], &[relative], cwd)
        .await
        .unwrap_or_default();
    !out.trim().is_empty()
}

#[derive(Default)]
struct CommitMeta {
    author: String,
    date: String,
    summary: String,
}

fn parse_blame_porcelain(output: &str) -> Vec<BlameLine> {
    let mut results: Vec<BlameLine> = Vec::new();
    let mut commits: HashMap<String, CommitMeta> = HashMap::new();
    let mut current_sha: Option<String> = None;
    let mut line_num: u32 = 0;

    for raw_line in output.lines() {
        if raw_line.len() >= 40
            && raw_line.as_bytes()[..40]
                .iter()
                .all(|b| b.is_ascii_hexdigit())
        {
            // Header line: "<sha> <orig-line> <final-line> [<num-lines>]".
            // git blame --porcelain only emits the metadata block (author/
            // summary/...) on the first occurrence of a given SHA; subsequent
            // chunks of the same commit reuse the cached metadata.
            let sha = raw_line[..40].to_string();
            if let Some(field) = raw_line.split_whitespace().nth(2) {
                line_num = field.parse().unwrap_or(0);
            }
            commits.entry(sha.clone()).or_default();
            current_sha = Some(sha);
        } else if let Some(val) = raw_line.strip_prefix("author ") {
            if let Some(meta) = current_sha.as_deref().and_then(|s| commits.get_mut(s)) {
                meta.author = val.to_string();
            }
        } else if let Some(val) = raw_line.strip_prefix("author-time ") {
            if let Some(meta) = current_sha.as_deref().and_then(|s| commits.get_mut(s)) {
                let ts: i64 = val.parse().unwrap_or(0);
                meta.date = DateTime::from_timestamp(ts, 0)
                    .map(|dt| dt.format("%Y-%m-%d").to_string())
                    .unwrap_or_default();
            }
        } else if let Some(val) = raw_line.strip_prefix("summary ") {
            if let Some(meta) = current_sha.as_deref().and_then(|s| commits.get_mut(s)) {
                meta.summary = val.to_string();
            }
        } else if raw_line.starts_with('\t') {
            let Some(meta) = current_sha.as_deref().and_then(|s| commits.get(s)) else {
                continue;
            };
            results.push(BlameLine {
                line: line_num,
                author: meta.author.clone(),
                date: meta.date.clone(),
                summary: meta.summary.clone(),
            });
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tokio::process::Command;

    /// Initialise a throwaway git repo for `is_path_tracked` tests. Uses a
    /// per-test subdirectory under `tempfile::tempdir` so concurrent test
    /// threads don't fight over `.git`. Returns the canonical repo path so
    /// macOS `/var` → `/private/var` symlinks don't trip later comparisons.
    async fn init_test_repo(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join(name);
        std::fs::create_dir_all(&repo).unwrap();
        let canonical = std::fs::canonicalize(&repo).unwrap();
        // `git init` requires the dir to exist; we then set user.* locally
        // so `commit` doesn't blow up on minimal CI images with no global
        // identity configured.
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "tag.gpgsign", "false"],
        ] {
            let status = Command::new("git")
                .args(&args)
                .current_dir(&canonical)
                .status()
                .await
                .expect("spawn git");
            assert!(status.success(), "git {args:?} failed");
        }
        (dir, canonical)
    }

    #[tokio::test]
    async fn is_path_tracked_returns_true_for_committed_file() {
        let (_dir, repo) = init_test_repo("repo").await;
        std::fs::write(repo.join("a.txt"), "hi").unwrap();
        for args in [vec!["add", "a.txt"], vec!["commit", "-q", "-m", "a"]] {
            let s = Command::new("git")
                .args(&args)
                .current_dir(&repo)
                .status()
                .await
                .unwrap();
            assert!(s.success());
        }
        assert!(is_path_tracked(&repo, "a.txt").await);
    }

    #[tokio::test]
    async fn is_path_tracked_returns_false_for_untracked_file() {
        let (_dir, repo) = init_test_repo("repo").await;
        std::fs::write(repo.join("ignored.txt"), "hi").unwrap();
        // Untracked on disk but never `git add`ed — this is the node_modules
        // case in production.
        assert!(!is_path_tracked(&repo, "ignored.txt").await);
    }

    #[tokio::test]
    async fn is_path_tracked_returns_false_outside_repo() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = std::fs::canonicalize(dir.path()).unwrap();
        // No `git init`. `git ls-files` errors out; we map that to "not
        // tracked" so the renderer just gets an empty blame instead of a
        // toast.
        assert!(!is_path_tracked(&cwd, "whatever.txt").await);
    }

    #[test]
    fn test_parse_blame_porcelain_single_line() {
        let output = "\
abcdef1234567890abcdef1234567890abcdef12 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1700000000
author-tz +0000
committer Alice
committer-mail <alice@example.com>
committer-time 1700000000
committer-tz +0000
summary initial commit
filename src/main.rs
\thello world
";
        let lines = parse_blame_porcelain(output);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].line, 1);
        assert_eq!(lines[0].author, "Alice");
        assert_eq!(lines[0].date, "2023-11-14");
        assert_eq!(lines[0].summary, "initial commit");
    }

    #[test]
    fn test_parse_blame_porcelain_multiple_lines() {
        let output = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1
author Alice
author-time 1700000000
summary first commit
filename f.rs
\tline one
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2 1
author Bob
author-time 1700100000
summary second commit
filename f.rs
\tline two
";
        let lines = parse_blame_porcelain(output);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].author, "Alice");
        assert_eq!(lines[0].line, 1);
        assert_eq!(lines[1].author, "Bob");
        assert_eq!(lines[1].line, 2);
        assert_eq!(lines[1].summary, "second commit");
    }

    #[test]
    fn test_parse_blame_porcelain_empty_input() {
        let lines = parse_blame_porcelain("");
        assert!(lines.is_empty());
    }

    #[test]
    fn test_parse_blame_porcelain_repeated_commit_metadata() {
        // A single commit covering multiple consecutive lines: porcelain only
        // emits the author/summary block on the first occurrence. Subsequent
        // lines of the same commit must inherit the cached metadata.
        let output = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2
author Alice
author-mail <alice@example.com>
author-time 1700000000
author-tz +0000
summary first commit
filename f.rs
\tline one
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2
\tline two
";
        let lines = parse_blame_porcelain(output);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].author, "Alice");
        assert_eq!(lines[0].summary, "first commit");
        assert_eq!(lines[0].line, 1);
        // The second line of the same commit must still expose author and summary.
        assert_eq!(lines[1].author, "Alice");
        assert_eq!(lines[1].summary, "first commit");
        assert_eq!(lines[1].line, 2);
        assert_eq!(lines[1].date, lines[0].date);
    }

    #[test]
    fn test_parse_blame_porcelain_interleaved_commits() {
        // Commit A appears, then commit B, then commit A reappears later.
        // The reappearance must resolve metadata from the cache.
        let output = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1
author Alice
author-time 1700000000
summary first commit
filename f.rs
\tline one
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2 1
author Bob
author-time 1700100000
summary second commit
filename f.rs
\tline two
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 3
\tline three
";
        let lines = parse_blame_porcelain(output);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2].author, "Alice");
        assert_eq!(lines[2].summary, "first commit");
        assert_eq!(lines[2].line, 3);
        assert_eq!(lines[2].date, lines[0].date);
    }
}
