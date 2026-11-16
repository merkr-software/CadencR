//! Commit-graph queries: a paginated `git log` that carries each commit's
//! parents (so the frontend can draw the lane graph), its decorating refs,
//! and a `--shortstat` summary (files changed / insertions / deletions).
//!
//! Unlike [`super::log`], which compares `base..HEAD`, the graph view passes
//! the refs as *positive* tips (`git log HEAD <target> …`) so the union of
//! both branches is visible and the divergence point shows up — exactly what
//! `git log --graph HEAD <target>` renders in a terminal.

use std::path::Path;

use crate::domain::git::models::CommitGraphEntry;
use crate::error::AppError;
use crate::shared::git_cli::guard_positionals;

use super::graph_refs::parse_refs;
use super::log::get_unpushed_shas;
use super::util::{run_git_quiet, FIRST_PARENT_MERGES};
use crate::shared::git_cli::version::{self, GitFeature};

/// Record separator emitted before every commit; field separator between the
/// `--format` placeholders. Both are control bytes that can't appear in commit
/// metadata, so splitting on them is unambiguous. The trailing `%x1f` after the
/// body is what lets us peel the `--shortstat` line (which git appends *after*
/// the formatted output) off the body field.
const FORMAT: &str = "%x1e%H%x1f%h%x1f%s%x1f%an%x1f%ai%x1f%P%x1f%D%x1f%b%x1f";

/// Parse a git `--shortstat` summary line such as
/// `" 3 files changed, 10 insertions(+), 2 deletions(-)"` into
/// `(files_changed, insertions, deletions)`. An empty commit produces no
/// summary, yielding `(0, 0, 0)`.
fn parse_shortstat(tail: &str) -> (i32, i32, i32) {
    let (mut files, mut adds, mut dels) = (0, 0, 0);
    for segment in tail.split(',') {
        let n: i32 = segment
            .split_whitespace()
            .next()
            .and_then(|t| t.parse().ok())
            .unwrap_or(0);
        if segment.contains("changed") {
            files = n;
        } else if segment.contains("insertion") {
            adds = n;
        } else if segment.contains("deletion") {
            dels = n;
        }
    }
    (files, adds, dels)
}

fn parse_graph_log(output: &str) -> Vec<CommitGraphEntry> {
    let mut commits = vec![];
    for record in output.split('\x1e').filter(|s| !s.trim().is_empty()) {
        let fields: Vec<&str> = record.split('\x1f').collect();
        if fields.len() < 8 {
            continue;
        }
        let parents: Vec<String> = fields[5]
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        // Field 8 (after the body's closing separator) holds the trailing
        // `--shortstat` line. Absent for an empty commit → all zeros.
        let (files_changed, additions, deletions) = fields
            .get(8)
            .map(|t| parse_shortstat(t))
            .unwrap_or((0, 0, 0));
        let decorations = parse_refs(fields[6]);
        commits.push(CommitGraphEntry {
            sha: fields[0].to_string(),
            short_sha: fields[1].to_string(),
            message: fields[2].to_string(),
            author: fields[3].to_string(),
            date: fields[4].to_string(),
            parents,
            refs: decorations.iter().map(|r| r.name.clone()).collect(),
            decorations,
            body: fields[7].trim().to_string(),
            files_changed,
            additions,
            deletions,
            is_pushed: true,
        });
    }
    commits
}

/// Paginated commit graph over the union of `tips` (e.g. the feature's own
/// revision and the local target branch). Returns up to `limit` commits
/// starting at `skip`.
pub async fn get_commit_graph(
    repo_path: &Path,
    tips: &[String],
    skip: i64,
    limit: i64,
) -> Result<Vec<CommitGraphEntry>, AppError> {
    let format_arg = format!("--format={FORMAT}");
    let skip_arg = format!("--skip={}", skip.max(0));
    let max_arg = format!("--max-count={}", limit.max(1));
    // A merge summarizes to nothing unless git is told which parent to diff
    // against, so a merge row used to read "0 files" while the diff pane it
    // opens shows the first-parent changes. Both sides now follow parent 1.
    let mut args = vec![
        "log",
        "--topo-order",
        "--shortstat",
        // Full ref names, so `parse_refs` can tell local from remote branches.
        "--decorate=full",
        &format_arg,
        &skip_arg,
        &max_arg,
    ];
    // Older Git has no `diff-tree`-style fallback here: `-m --first-parent`
    // would also prune the graph to first parents. Merge rows then read
    // "0 files" while their diff still opens.
    if version::supports(GitFeature::DiffMerges) {
        args.push(FIRST_PARENT_MERGES);
    }
    let tip_refs: Vec<&str> = tips.iter().map(String::as_str).collect();
    guard_positionals(&tip_refs)?;
    args.extend(tip_refs.iter().copied());
    let stdout = run_git_quiet(&args, repo_path).await;
    let mut commits = parse_graph_log(&stdout);

    // Painted over every tip drawn, not just the feature's own: the graph shows
    // the target branch too, and a commit sitting unpushed on `main` must not
    // read as pushed merely because it isn't on this feature's branch.
    let unpushed = get_unpushed_shas(repo_path, &tip_refs).await;
    for c in commits.iter_mut() {
        c.is_pushed = match &unpushed {
            None => false,
            Some(set) => !set.contains(&c.sha),
        };
    }
    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::models::{CommitRef, CommitRefKind};

    #[test]
    fn parse_shortstat_full_line() {
        let (f, a, d) = parse_shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)");
        assert_eq!((f, a, d), (3, 10, 2));
    }

    #[test]
    fn parse_shortstat_insertions_only() {
        let (f, a, d) = parse_shortstat(" 1 file changed, 5 insertions(+)");
        assert_eq!((f, a, d), (1, 5, 0));
    }

    #[test]
    fn parse_shortstat_deletions_only() {
        let (f, a, d) = parse_shortstat(" 2 files changed, 4 deletions(-)");
        assert_eq!((f, a, d), (2, 0, 4));
    }

    #[test]
    fn parse_shortstat_empty_for_merge() {
        assert_eq!(parse_shortstat(""), (0, 0, 0));
        assert_eq!(parse_shortstat("   \n  "), (0, 0, 0));
    }

    #[test]
    fn parse_graph_log_single_commit_with_stats() {
        let output = "\x1eabc123full\x1fabc123\x1ffix bug\x1fJane\x1f2024-01-01 12:00:00 +0000\x1fparent1 parent2\x1fHEAD -> refs/heads/main\x1fbody text\x1f\n 3 files changed, 10 insertions(+), 2 deletions(-)\n";
        let commits = parse_graph_log(output);
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.sha, "abc123full");
        assert_eq!(c.short_sha, "abc123");
        assert_eq!(c.message, "fix bug");
        assert_eq!(c.author, "Jane");
        assert_eq!(c.parents, vec!["parent1", "parent2"]);
        assert_eq!(c.refs, vec!["main"]);
        assert_eq!(c.body, "body text");
        assert_eq!(c.files_changed, 3);
        assert_eq!(c.additions, 10);
        assert_eq!(c.deletions, 2);
    }

    #[test]
    fn parse_graph_log_root_commit_no_parents() {
        let output = "\x1eroot\x1froot\x1finit\x1fJane\x1f2024-01-01 12:00:00 +0000\x1f\x1f\x1f\x1f\n 1 file changed, 1 insertion(+)\n";
        let commits = parse_graph_log(output);
        assert_eq!(commits.len(), 1);
        assert!(commits[0].parents.is_empty());
        assert!(commits[0].refs.is_empty());
        assert_eq!(commits[0].files_changed, 1);
    }

    #[test]
    fn parse_graph_log_empty() {
        assert!(parse_graph_log("").is_empty());
    }

    /// `main` with a base commit, plus a `feature/x` branch one commit ahead
    /// (a 2-line `b.txt`). Both graph fixtures start from this shape.
    async fn repo_with_feature_branch() -> tempfile::TempDir {
        use crate::shared::git_cli::run_git;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run_git(args, path).await.unwrap();
        }
        tokio::fs::write(path.join("a.txt"), "1\n").await.unwrap();
        run_git(&["add", "."], path).await.unwrap();
        run_git(&["commit", "-q", "-m", "base"], path)
            .await
            .unwrap();

        run_git(&["checkout", "-q", "-b", "feature/x"], path)
            .await
            .unwrap();
        tokio::fs::write(path.join("b.txt"), "x\ny\n")
            .await
            .unwrap();
        run_git(&["add", "."], path).await.unwrap();
        run_git(&["commit", "-q", "-m", "feat"], path)
            .await
            .unwrap();
        dir
    }

    /// End-to-end against real git: a feature branch and `main` that diverge
    /// from a shared base. Logging both tips must surface the union of all
    /// three commits with correct parents, refs, and per-commit shortstat.
    #[tokio::test]
    async fn get_commit_graph_unions_diverged_branches() {
        use crate::shared::git_cli::run_git;

        let dir = repo_with_feature_branch().await;
        let path = dir.path();

        // main advances independently
        run_git(&["checkout", "-q", "main"], path).await.unwrap();
        tokio::fs::write(path.join("c.txt"), "z\n").await.unwrap();
        run_git(&["add", "."], path).await.unwrap();
        run_git(&["commit", "-q", "-m", "main work"], path)
            .await
            .unwrap();

        let tips = vec!["main".to_string(), "feature/x".to_string()];
        let commits = get_commit_graph(path, &tips, 0, 50).await.unwrap();

        // Union of base + feat + main work.
        assert_eq!(commits.len(), 3);
        let by_msg = |m: &str| commits.iter().find(|c| c.message == m).unwrap();

        let feat = by_msg("feat");
        assert_eq!(feat.parents.len(), 1, "feat has one parent (base)");
        assert_eq!(feat.files_changed, 1);
        assert_eq!(feat.additions, 2);
        assert!(feat.refs.iter().any(|r| r == "feature/x"));

        let base = by_msg("base");
        assert!(base.parents.is_empty(), "root commit has no parents");

        // Pagination: a 2-row page leaves more behind.
        let page = get_commit_graph(path, &tips, 0, 2).await.unwrap();
        assert_eq!(page.len(), 2);

        // A single selected tip is a dedicated branch graph: commits that
        // exist only on the other branch must not leak into it.
        let feature_only = get_commit_graph(path, &["feature/x".to_string()], 0, 50)
            .await
            .unwrap();
        assert!(feature_only.iter().any(|c| c.message == "feat"));
        assert!(!feature_only.iter().any(|c| c.message == "main work"));

        // Push only the feature branch. Every drawn tip is painted, so the
        // commit that exists only on `main` still reports as unpushed — it used
        // to read as pushed because the split was computed from one tip.
        run_git(
            &["update-ref", "refs/remotes/origin/feature/x", "feature/x"],
            path,
        )
        .await
        .unwrap();
        let painted = get_commit_graph(path, &tips, 0, 50).await.unwrap();
        let pushed = |m: &str| painted.iter().find(|c| c.message == m).unwrap().is_pushed;
        assert!(pushed("feat"), "the pushed feature tip");
        assert!(pushed("base"), "shared ancestor rode along");
        assert!(!pushed("main work"), "unpushed on the target tip");
        let feat = painted.iter().find(|c| c.message == "feat").unwrap();
        assert!(feat.decorations.contains(&CommitRef {
            name: "origin/feature/x".into(),
            kind: CommitRefKind::Remote,
        }));
    }

    /// A merge row must carry the same first-parent stat the diff pane shows
    /// when that merge is opened — git summarizes a merge to nothing unless
    /// told which parent to follow, which read as "0 files".
    #[tokio::test]
    async fn get_commit_graph_summarizes_merges_against_the_first_parent() {
        use crate::shared::git_cli::run_git;

        let dir = repo_with_feature_branch().await;
        let path = dir.path();
        run_git(&["checkout", "-q", "main"], path).await.unwrap();
        run_git(
            &["merge", "-q", "--no-ff", "-m", "merge feat", "feature/x"],
            path,
        )
        .await
        .unwrap();

        let commits = get_commit_graph(path, &["main".to_string()], 0, 50)
            .await
            .unwrap();
        let merge = commits.iter().find(|c| c.message == "merge feat").unwrap();
        assert_eq!(merge.parents.len(), 2);
        assert_eq!(merge.files_changed, 1);
        assert_eq!(merge.additions, 2);
    }

    #[tokio::test]
    async fn get_commit_graph_rejects_flag_prefixed_tips() {
        let error = get_commit_graph(Path::new("."), &["--all".to_string()], 0, 50)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)));
    }
}
