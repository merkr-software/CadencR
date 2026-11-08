use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Response for `GET /api/git/commit-url`. `available = false` (with an empty
/// `url`) means the host couldn't be classified or there's no remote, so the
/// frontend hides the "open commit online" action.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CommitUrlResponse {
    pub url: String,
    pub available: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CommitLogEntry {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub body: String,
    pub author: String,
    pub date: String,
    pub is_pushed: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CommitLogResponse {
    pub commits: Vec<CommitLogEntry>,
    pub is_on_base_branch: bool,
}

/// What a decorating ref points from: the branch checked out (`HEAD ->`), any
/// other local branch, a remote-tracking branch, or a tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CommitRefKind {
    Head,
    Local,
    Remote,
    Tag,
}

/// One decorating ref on a graph commit, by its short name (`main`,
/// `origin/main`, `v1.0`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CommitRef {
    pub name: String,
    pub kind: CommitRefKind,
}

/// One commit row in the graph view. Carries `parents` so the frontend can
/// compute lane positions, `decorations` (typed branch/tag labels), and the
/// `--shortstat` summary (`files_changed` / `additions` / `deletions`).
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CommitGraphEntry {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub body: String,
    pub author: String,
    pub date: String,
    pub parents: Vec<String>,
    /// Short names of `decorations`. The desktop reads `decorations`; this
    /// stays for custom tabs, which reach this route through the tab SDK.
    pub refs: Vec<String>,
    /// The decorating refs with their kind, so the UI can tell the checked-out branch, a
    /// local branch, a remote-tracking branch and a tag apart — the names
    /// alone cannot (`feature/x` and `origin/x` both contain a slash).
    pub decorations: Vec<CommitRef>,
    pub files_changed: i32,
    pub additions: i32,
    pub deletions: i32,
    pub is_pushed: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CommitGraphResponse {
    pub commits: Vec<CommitGraphEntry>,
    /// `true` when the requested page was full, i.e. more commits may exist
    /// past `skip + limit`. Drives the frontend's infinite-scroll fetch.
    pub has_more: bool,
    pub current_branch: Option<String>,
    /// The *local* target branch the graph is unioned with (`None` when the
    /// feature sits on its target). Remote-tracking targets are mapped to
    /// their local branch when one exists.
    pub target_branch: Option<String>,
}

/// One row in the Git-tab Stashes view. `ref_name` is git's reflog selector
/// (`stash@{0}`); `sha` is the full commit SHA of the stash snapshot, so the
/// frontend opens the stash diff through the existing `commit_sha` path
/// (`git diff <sha>^..<sha>`, the range summarized below). `message` is the
/// stash description (git's reflog subject), `date` its ISO-8601 creation
/// time, and the `files_changed` / `additions` / `deletions` numstat matches
/// the diff a row expands to.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StashEntry {
    pub ref_name: String,
    pub sha: String,
    pub message: String,
    pub date: String,
    pub files_changed: i32,
    pub additions: i32,
    pub deletions: i32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FileBlobSha {
    pub file_path: String,
    pub sha: String,
}

/// Where the feature's directory sits in its checkout. Git tab paths are
/// relative to the checkout root; editor paths are relative to the feature's
/// directory, so the two differ by this prefix.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct GitPathPrefixResponse {
    /// The feature's directory relative to the checkout root, with `/`
    /// separators: empty at the root, `packages/app` for a monorepo project.
    /// `None` when the directory has no Git metadata.
    pub prefix: Option<String>,
    /// Absolute path of the checkout root, where Git runs. Names a Git path
    /// outside the feature's directory without ambiguity. `None` when the
    /// directory has no Git metadata.
    pub root: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_bare: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ProjectWorktreeInfo {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub feature_id: Option<i64>,
    pub feature_title: Option<String>,
    pub feature_status: Option<String>,
}

/// Per-feature worktree metadata sourced from `feature_settings`.
/// Includes features whose worktree directory has been deleted; callers can
/// distinguish a live Git worktree from residual files left on disk.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FeatureWorktreeInfo {
    pub feature_id: i64,
    pub worktree_path: String,
    pub worktree_branch: Option<String>,
    pub is_default_branch: bool,
    pub is_main_worktree: bool,
    /// Whether anything still exists at the recorded worktree path.
    pub directory_exists: bool,
    /// Whether the recorded local feature branch still exists.
    pub branch_exists: Option<bool>,
    /// Whether the path is a usable Git working tree, not merely a directory.
    pub live: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct MergeConflictResult {
    pub has_conflicts: bool,
    pub conflict_files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct MergeResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Set when the merge failed because of a content conflict. Lists the
    /// files git reported as conflicted so the UI can show them verbatim
    /// instead of an opaque "merge failed" string. `None` when the failure
    /// was something else (dirty target worktree, fast-forward refused, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_files: Option<Vec<String>>,
    /// Set on a *successful* merge whose cleanup did not complete — e.g. the
    /// target worktree could not be switched back to the branch it had
    /// checked out before. The merge itself is committed; the UI must still
    /// tell the user the worktree was left on another branch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct OriginalBranchResponse {
    pub original_branch: String,
    pub worktree_branch: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct HasUncommittedChangesResponse {
    pub has_changes: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[schema(as = GitSuccessResponse)]
pub struct SuccessResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
}

impl SuccessResponse {
    pub fn ok() -> Self {
        Self {
            success: true,
            error: None,
            blocked_reason: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CreateWorktreeResponse {
    pub worktree_path: String,
    pub branch: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct BranchDeleteCheckResponse {
    pub branch: String,
    pub branch_exists: bool,
    pub current_branch: Option<String>,
    pub target_branch: String,
    pub default_branch: String,
    pub is_default_branch: bool,
    pub merged: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct BlameLine {
    pub line: u32,
    pub author: String,
    pub date: String,
    pub summary: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct BlameResponse {
    pub lines: Vec<BlameLine>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_commit_log_entry_serde_roundtrip() {
        let entry = CommitLogEntry {
            sha: "abc123".into(),
            short_sha: "abc".into(),
            message: "fix bug".into(),
            body: "details".into(),
            author: "dev".into(),
            date: "2024-01-01".into(),
            is_pushed: true,
        };
        let json = serde_json::to_string(&entry).unwrap();
        let back: CommitLogEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back.sha, "abc123");
        assert!(back.is_pushed);
    }

    #[test]
    fn test_worktree_info_serde_roundtrip() {
        let wt = WorktreeInfo {
            path: "/tmp/wt".into(),
            branch: "feature/test".into(),
            head: "deadbeef".into(),
            is_bare: false,
        };
        let json = serde_json::to_string(&wt).unwrap();
        let back: WorktreeInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.path, "/tmp/wt");
        assert!(!back.is_bare);
    }

    #[test]
    fn test_merge_conflict_result_serde_roundtrip() {
        let mc = MergeConflictResult {
            has_conflicts: true,
            conflict_files: vec!["a.rs".into(), "b.rs".into()],
        };
        let json = serde_json::to_string(&mc).unwrap();
        let back: MergeConflictResult = serde_json::from_str(&json).unwrap();
        assert!(back.has_conflicts);
        assert_eq!(back.conflict_files.len(), 2);
    }

    #[test]
    fn test_success_response_skips_none_error() {
        let resp = SuccessResponse {
            success: true,
            error: None,
            blocked_reason: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(!json.contains("error"));

        let resp = SuccessResponse {
            success: false,
            error: Some("oops".into()),
            blocked_reason: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("oops"));
    }
}
