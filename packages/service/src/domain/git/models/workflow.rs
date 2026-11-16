use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

// ---------------------------------------------------------------------------
// Branches / status / compare-url / target-branch (Git workflow overhaul)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct ListBranchesParams {
    pub project_id: i64,
}

/// One row per branch known to the project repo. Local + remote-tracking
/// entries are merged: an `origin/foo` that has a matching local `foo` shows
/// once with `is_local = true`. `attached_*` are populated from the worktree
/// registry so the UI can warn when reusing a branch already in use.
#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
pub struct BranchInfo {
    pub name: String,
    pub is_local: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attached_worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attached_feature_id: Option<i64>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetGitStatusParams {
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetCompareUrlParams {
    pub feature_id: i64,
}

/// Response for `GET /api/git/compare-url`. `available = false` lets the
/// frontend disable the action without inspecting the host. `label` is always
/// present so the UI has copy to render.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CompareUrlResponse {
    pub url: String,
    pub label: String,
    pub available: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateTargetBranchBody {
    pub target_branch: String,
    /// The conversation branch this target is for. Defaults to the current
    /// one: targets are per branch, so a stacked branch can target the branch
    /// it was cut from while the others keep theirs.
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CheckoutBody {
    pub project_id: i64,
    pub branch: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CheckoutValidateBody {
    pub project_id: i64,
    pub branch: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CommitBody {
    pub feature_id: i64,
    pub message: String,
    pub file_paths: Vec<String>,
}

/// How hard the push may overwrite the remote branch.
///
/// `ForceWithLease` is the safe force: git refuses when the remote moved
/// since our last fetch. `Force` overwrites unconditionally and is the
/// destructive escape hatch. Absent field ⇒ [`PushForceMode::None`], so
/// existing clients keep the plain `git push` behavior.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PushForceMode {
    #[default]
    None,
    Force,
    ForceWithLease,
}

impl PushForceMode {
    /// The extra `git push` flag this mode contributes, if any.
    pub fn flag(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Force => Some("--force"),
            Self::ForceWithLease => Some("--force-with-lease"),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PushBody {
    pub feature_id: i64,
    /// Optional force mode; omitted or `"none"` performs a plain push.
    #[serde(default)]
    pub force: PushForceMode,
}

/// User-typed bytes for an interactive `git push` prompt. The backend
/// appends a `\n` if the caller didn't, since every prompt we care about
/// (passphrase, `yes/no`, HTTPS password) reads a line.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PushInputBody {
    pub feature_id: i64,
    pub text: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetUncommittedFilesParams {
    pub feature_id: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_body_defaults_to_a_plain_push() {
        let body: PushBody =
            serde_json::from_value(serde_json::json!({ "feature_id": 7 })).unwrap();
        assert_eq!(body.force, PushForceMode::None);
        assert_eq!(body.force.flag(), None);
    }

    #[test]
    fn push_body_accepts_kebab_case_force_modes() {
        let lease: PushBody = serde_json::from_value(
            serde_json::json!({ "feature_id": 7, "force": "force-with-lease" }),
        )
        .unwrap();
        assert_eq!(lease.force, PushForceMode::ForceWithLease);
        assert_eq!(lease.force.flag(), Some("--force-with-lease"));

        let hard: PushBody =
            serde_json::from_value(serde_json::json!({ "feature_id": 7, "force": "force" }))
                .unwrap();
        assert_eq!(hard.force.flag(), Some("--force"));
    }
}
