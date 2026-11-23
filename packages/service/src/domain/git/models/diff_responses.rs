use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{ConflictKind, FileStageState};

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct BranchResponse {
    pub branch: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct GitStats {
    pub files_changed: i32,
    pub insertions: i32,
    pub deletions: i32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DiffResponse {
    pub diff: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub struct ChangedFile {
    pub file: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_file: Option<String>,
    pub additions: i32,
    pub deletions: i32,
    /// `true` when the file has staged changes (i.e. shows up in
    /// `git diff --cached`). Always `false` in branch-comparison mode.
    /// The frontend uses this to render a "staged" badge next to the file.
    #[serde(default)]
    pub is_staged: bool,
    /// Typed index/worktree state. `is_staged` remains during the frontend
    /// migration but new consumers should use this field.
    #[serde(default)]
    pub stage_state: FileStageState,
    /// Present only for an unmerged working-tree row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_kind: Option<ConflictKind>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FileContent {
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    /// Byte size of the file at the old ref (0 if absent).
    pub old_size: u64,
    /// Byte size of the file at the new ref / working tree (0 if absent).
    pub new_size: u64,
    /// True if either side holds a NUL byte in its first 8 KB or is not valid
    /// UTF-8 — the same verdict `GET /api/git/file-content` reaches. A side
    /// over 16 MiB, which that endpoint refuses, is judged on its first 8 KB.
    pub is_binary: bool,
    /// True if the file is too large to render automatically. When true the
    /// frontend shows a placeholder and the content fields may be `None` in
    /// batch responses (the single-file endpoint always returns content).
    pub is_large: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FileContentBatchItem {
    pub file_path: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub old_size: u64,
    pub new_size: u64,
    pub is_binary: bool,
    pub is_large: bool,
}

impl From<FileContentBatchItem> for FileContent {
    fn from(item: FileContentBatchItem) -> Self {
        Self {
            old_content: item.old_content,
            new_content: item.new_content,
            old_size: item.old_size,
            new_size: item.new_size,
            is_binary: item.is_binary,
            is_large: item.is_large,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_branch_response_serde_roundtrip() {
        let resp = BranchResponse {
            branch: Some("main".into()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let back: BranchResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(back.branch, Some("main".into()));

        let resp_none = BranchResponse { branch: None };
        let json = serde_json::to_string(&resp_none).unwrap();
        let back: BranchResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(back.branch, None);
        assert!(json.contains("null"));
    }

    #[test]
    fn test_git_stats_serde_roundtrip() {
        let stats = GitStats {
            files_changed: 3,
            insertions: 10,
            deletions: 5,
        };
        let json = serde_json::to_string(&stats).unwrap();
        let back: GitStats = serde_json::from_str(&json).unwrap();
        assert_eq!(back.files_changed, 3);
        assert_eq!(back.insertions, 10);
        assert_eq!(back.deletions, 5);
    }

    #[test]
    fn test_changed_file_serde_with_optional_old_file() {
        let cf = ChangedFile {
            file: "src/main.rs".into(),
            status: "M".into(),
            old_file: None,
            additions: 5,
            deletions: 3,
            is_staged: false,
            stage_state: FileStageState::NotApplicable,
            conflict_kind: None,
        };
        let json = serde_json::to_string(&cf).unwrap();
        assert!(!json.contains("old_file"), "None should be skipped");
        assert!(json.contains("\"is_staged\":false"));

        let cf_rename = ChangedFile {
            file: "new.rs".into(),
            status: "R".into(),
            old_file: Some("old.rs".into()),
            additions: 0,
            deletions: 0,
            is_staged: true,
            stage_state: FileStageState::Staged,
            conflict_kind: None,
        };
        let json = serde_json::to_string(&cf_rename).unwrap();
        assert!(json.contains("old_file"));
        assert!(json.contains("\"is_staged\":true"));
        let back: ChangedFile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.old_file, Some("old.rs".into()));
        assert!(back.is_staged);

        // Backwards compat: payloads from older API versions without
        // `is_staged` should still deserialize and default to `false`.
        let legacy = "{\"file\":\"x\",\"status\":\"M\",\"additions\":0,\"deletions\":0}";
        let back: ChangedFile = serde_json::from_str(legacy).unwrap();
        assert!(!back.is_staged);
        assert_eq!(back.stage_state, FileStageState::NotApplicable);
        assert!(back.conflict_kind.is_none());
    }

    #[test]
    fn test_file_content_batch_item_has_file_path() {
        let item = FileContentBatchItem {
            file_path: "src/lib.rs".into(),
            old_content: Some("old".into()),
            new_content: None,
            old_size: 3,
            new_size: 0,
            is_binary: false,
            is_large: false,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("file_path"));
        assert!(json.contains("src/lib.rs"));
        assert!(json.contains("\"old_size\":3"));
        assert!(json.contains("\"is_binary\":false"));
        assert!(json.contains("\"is_large\":false"));
        let back: FileContentBatchItem = serde_json::from_str(&json).unwrap();
        assert_eq!(back.file_path, "src/lib.rs");
        assert_eq!(back.old_content, Some("old".into()));
        assert_eq!(back.new_content, None);
        assert_eq!(back.old_size, 3);
        assert_eq!(back.new_size, 0);
        assert!(!back.is_binary);
        assert!(!back.is_large);
    }

    #[test]
    fn test_file_content_serde_roundtrip_with_metadata() {
        let fc = FileContent {
            old_content: None,
            new_content: None,
            old_size: 1_000_000,
            new_size: 2_000_000,
            is_binary: false,
            is_large: true,
        };
        let json = serde_json::to_string(&fc).unwrap();
        let back: FileContent = serde_json::from_str(&json).unwrap();
        assert!(back.is_large);
        assert_eq!(back.new_size, 2_000_000);
        assert!(back.old_content.is_none());
    }

    #[test]
    fn file_content_from_batch_item_drops_path_and_keeps_metadata() {
        let item = FileContentBatchItem {
            file_path: "src/big.rs".into(),
            old_content: None,
            new_content: Some("hi".into()),
            old_size: 0,
            new_size: 2,
            is_binary: false,
            is_large: true,
        };
        let fc: FileContent = item.into();
        assert_eq!(fc.new_content.as_deref(), Some("hi"));
        assert_eq!(fc.new_size, 2);
        assert!(fc.is_large);
    }
}
