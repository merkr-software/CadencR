//! Provider-neutral approval and merge state for one proposal, and the
//! requests that act on it.
//!
//! Read on demand by the PR pane rather than by the status poller: answering
//! "who approved, can I merge, is it on a merge train" costs two to four extra
//! forge calls per proposal, which is fine for the one being looked at and
//! wasteful for every proposal of every conversation once a minute.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::provider::ForgeUser;

/// How a proposal's commits land on the target branch. Each forge offers a
/// subset, and which one is allowed is a repository (or branch) setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MergeMethod {
    /// A merge commit joining the two histories.
    Merge,
    /// Every commit squashed into one, committed onto the target.
    Squash,
    /// Commits replayed onto the target, no merge commit.
    Rebase,
    /// Commits rebased onto the target, then joined with a merge commit.
    RebaseMerge,
    /// The target is moved forward to the source; fails if it diverged.
    FastForward,
    /// Squashed into one commit, then fast-forwarded.
    SquashFastForward,
}

impl MergeMethod {
    pub fn squashes(self) -> bool {
        matches!(self, Self::Squash | Self::SquashFastForward)
    }
}

/// One reviewer's latest position on the proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReviewerDecision {
    Approved,
    ChangesRequested,
    Commented,
    /// Asked to review, has not yet.
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PrReviewer {
    pub user: ForgeUser,
    pub decision: ReviewerDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PrApprovals {
    /// Approvers first, then requested changes, then everyone else.
    pub reviewers: Vec<PrReviewer>,
    pub approved_count: u32,
    /// Approvals the forge's rules demand before merging. `None` when the forge
    /// does not say (no rule, or the token cannot read the rule).
    pub required: Option<u32>,
    /// Whether the forge considers the approval requirement met. `None` when it
    /// has no opinion — no rule applies, or it cannot be read.
    pub satisfied: Option<bool>,
}

impl PrApprovals {
    /// Assembles the counts from the reviewer list, ordering it for display.
    pub fn from_reviewers(
        mut reviewers: Vec<PrReviewer>,
        required: Option<u32>,
        satisfied: Option<bool>,
    ) -> Self {
        reviewers.sort_by_key(|reviewer| match reviewer.decision {
            ReviewerDecision::Approved => 0,
            ReviewerDecision::ChangesRequested => 1,
            ReviewerDecision::Commented => 2,
            ReviewerDecision::Pending => 3,
        });
        let approved_count = reviewers
            .iter()
            .filter(|reviewer| reviewer.decision == ReviewerDecision::Approved)
            .count();
        let approved_count = u32::try_from(approved_count).unwrap_or(u32::MAX);
        Self {
            satisfied: satisfied.or_else(|| required.map(|required| approved_count >= required)),
            reviewers,
            approved_count,
            required,
        }
    }

    /// "2 more approvals required", or plain "Approval required" when the
    /// forge does not say how many.
    pub fn missing_reason(&self) -> String {
        match self.required {
            Some(required) if required > self.approved_count => {
                let left = required - self.approved_count;
                format!(
                    "{left} more approval{} required",
                    if left == 1 { "" } else { "s" }
                )
            }
            _ => "Approval required".into(),
        }
    }
}

/// Reasons every forge words the same way.
pub const CONFLICTS_REASON: &str = "Conflicts with the target branch must be resolved";
pub const DRAFT_REASON: &str = "Draft — mark it ready for review first";

/// Where the proposal stands against the target branch's rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MergeReadiness {
    /// Nothing the forge enforces stands in the way.
    Ready,
    /// Something enforced is unmet — see `reasons`.
    Blocked,
    /// The forge is still computing mergeability.
    Checking,
    Conflicts,
    /// The target moved on and the rules require the source to catch up.
    Behind,
    Draft,
    /// Merged or closed; nothing left to do.
    Closed,
}

/// A serialized landing lane the forge runs in front of the target branch:
/// GitHub's merge queue, GitLab's merge trains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MergeQueueKind {
    MergeQueue,
    MergeTrain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct MergeQueueEntry {
    /// Entries that will land before this one; `None` when the forge does not
    /// report a position.
    pub ahead: Option<u32>,
    pub enqueued_by: Option<ForgeUser>,
}

/// The proposal will merge itself once its checks (and, where the forge
/// supports it, its approvals) pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct AutoMergeState {
    pub enabled_by: Option<ForgeUser>,
    pub method: Option<MergeMethod>,
}

/// What the viewer can do to land the proposal, in the order the pane offers
/// them — the first one is the primary button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MergeAction {
    /// Merge right now.
    Merge,
    /// Merge as soon as the remaining checks pass.
    AutoMerge,
    /// Join the merge queue / train now.
    Enqueue,
    /// Join the merge queue / train once the remaining checks pass.
    EnqueueWhenReady,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct DeleteSourceBranch {
    /// What the forge (or repository setting) would do by default.
    pub default: bool,
    /// Whether the viewer may choose. False when the repository always deletes
    /// it, or when the source branch lives in another repository (a fork).
    pub configurable: bool,
    /// Whether the choice also holds when the merge is deferred (auto-merge, a
    /// queue). False when the forge only deletes on an immediate merge: the
    /// repository setting then decides.
    pub deferred: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PrMergeStatus {
    pub pr_number: u64,
    /// The head the forge evaluated. Sent back with a merge so the forge
    /// refuses if someone pushed in between.
    pub head_sha: String,
    pub approvals: PrApprovals,
    pub readiness: MergeReadiness,
    /// Why the proposal is not ready, in the forge's terms. Empty when ready.
    pub reasons: Vec<String>,
    /// Whether the viewer is allowed to merge into the target branch. `None`
    /// when the forge would not say; the merge is then offered and the forge
    /// decides.
    pub can_merge: Option<bool>,
    pub methods: Vec<MergeMethod>,
    pub default_method: Option<MergeMethod>,
    /// Set when the target branch only accepts merges through a queue.
    pub queue: Option<MergeQueueKind>,
    pub queue_entry: Option<MergeQueueEntry>,
    pub auto_merge: Option<AutoMergeState>,
    pub actions: Vec<MergeAction>,
    /// Whether the viewer can take it off auto-merge or out of the queue.
    pub cancellable: bool,
    pub delete_source_branch: DeleteSourceBranch,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PrMergeRequest {
    pub feature_id: i64,
    pub pr_number: u64,
    pub action: MergeAction,
    /// Required for `merge` and `auto_merge` unless the forge has one method;
    /// ignored for queue actions where the queue decides.
    pub method: Option<MergeMethod>,
    #[serde(default)]
    pub delete_source_branch: bool,
    /// The head the user confirmed (`PrMergeStatus::head_sha`). Cadencr
    /// refuses if the forge now reports another head; GitHub and GitLab also
    /// enforce it on their side, Bitbucket's merge API cannot.
    pub expected_head_sha: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MergeOutcome {
    Merged,
    /// Accepted; the forge is merging asynchronously.
    Merging,
    AutoMergeEnabled,
    Queued,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PrMergeResponse {
    pub outcome: MergeOutcome,
    /// Something the user should know even though the merge went through — a
    /// source branch that could not be deleted, say.
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PrMergeCancelResponse {
    pub cancelled: bool,
}

/// What a provider needs to carry out a [`PrMergeRequest`], already checked
/// against the proposal's current status.
#[derive(Debug, Clone)]
pub struct MergeCommand {
    pub action: MergeAction,
    pub method: Option<MergeMethod>,
    pub delete_source_branch: bool,
    pub expected_head_sha: String,
}

/// Checks a request against the status the forge just reported, so a stale
/// pane cannot ask for something the forge no longer offers.
pub fn validate_merge(
    status: &PrMergeStatus,
    request: &PrMergeRequest,
) -> Result<MergeCommand, String> {
    if status.can_merge == Some(false) {
        return Err("You don't have permission to merge into the target branch".into());
    }
    if !status.actions.contains(&request.action) {
        return Err("The forge no longer offers this merge action — refresh and try again".into());
    }
    if !same_commit(&status.head_sha, &request.expected_head_sha) {
        return Err(
            "The source branch moved since you looked — review the new commits and try again"
                .into(),
        );
    }
    let queued = matches!(
        request.action,
        MergeAction::Enqueue | MergeAction::EnqueueWhenReady
    );
    let deferred = request.action != MergeAction::Merge;
    let choosable = status.delete_source_branch.configurable
        && (!deferred || status.delete_source_branch.deferred);
    let method = match request.method {
        Some(method) if !status.methods.contains(&method) => {
            return Err("This merge method is not allowed for the target branch".into());
        }
        Some(method) => Some(method),
        None if queued => None,
        None => status
            .default_method
            .or_else(|| status.methods.first().copied()),
    };
    if !queued && method.is_none() {
        return Err("The forge allows no merge method for this target branch".into());
    }
    Ok(MergeCommand {
        action: request.action,
        method,
        delete_source_branch: if choosable {
            request.delete_source_branch
        } else {
            status.delete_source_branch.default
        },
        expected_head_sha: status.head_sha.clone(),
    })
}

/// Shortest abbreviation accepted as naming a commit — git's own default.
const MIN_ABBREVIATED_SHA: usize = 7;

/// Bitbucket reports abbreviated hashes, so a full one and a 12-character
/// prefix of it name the same commit.
fn same_commit(left: &str, right: &str) -> bool {
    let (short, long) = if left.len() <= right.len() {
        (left, right)
    } else {
        (right, left)
    };
    short.len() >= MIN_ABBREVIATED_SHA && long.starts_with(short)
}

/// Helpers shared by the adapters' readiness mapping.
pub fn humanize_status(raw: &str) -> String {
    let spaced = raw.replace('_', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(name: &str) -> ForgeUser {
        ForgeUser {
            username: name.into(),
            display_name: None,
            avatar_url: None,
        }
    }

    pub(crate) fn status(actions: Vec<MergeAction>) -> PrMergeStatus {
        PrMergeStatus {
            pr_number: 7,
            head_sha: "abcdef1234567890".into(),
            approvals: PrApprovals::from_reviewers(Vec::new(), None, None),
            readiness: MergeReadiness::Ready,
            reasons: Vec::new(),
            can_merge: Some(true),
            methods: vec![MergeMethod::Merge, MergeMethod::Squash],
            default_method: Some(MergeMethod::Squash),
            queue: None,
            queue_entry: None,
            auto_merge: None,
            actions,
            cancellable: false,
            delete_source_branch: DeleteSourceBranch {
                default: true,
                configurable: false,
                deferred: true,
            },
            fetched_at: 0,
        }
    }

    fn request(action: MergeAction, method: Option<MergeMethod>, sha: &str) -> PrMergeRequest {
        PrMergeRequest {
            feature_id: 1,
            pr_number: 7,
            action,
            method,
            delete_source_branch: false,
            expected_head_sha: sha.into(),
        }
    }

    #[test]
    fn approvals_count_and_order_reviewers() {
        let approvals = PrApprovals::from_reviewers(
            vec![
                PrReviewer {
                    user: user("pending"),
                    decision: ReviewerDecision::Pending,
                },
                PrReviewer {
                    user: user("ok"),
                    decision: ReviewerDecision::Approved,
                },
            ],
            Some(2),
            None,
        );
        assert_eq!(approvals.approved_count, 1);
        assert_eq!(approvals.reviewers[0].user.username, "ok");
        // A known rule with too few approvals is a "no", not "unknown".
        assert_eq!(approvals.satisfied, Some(false));
    }

    #[test]
    fn a_merge_uses_the_default_method_and_the_forges_branch_policy() {
        let command = validate_merge(
            &status(vec![MergeAction::Merge]),
            &request(MergeAction::Merge, None, "abcdef123456"),
        )
        .expect("valid merge");
        assert_eq!(command.method, Some(MergeMethod::Squash));
        // The repository always deletes the branch; the request can't opt out.
        assert!(command.delete_source_branch);
        assert_eq!(command.expected_head_sha, "abcdef1234567890");
    }

    #[test]
    fn stale_or_disallowed_requests_are_refused() {
        let ready = status(vec![MergeAction::Merge]);
        let seen = "abcdef1";
        assert!(validate_merge(&ready, &request(MergeAction::Merge, None, seen)).is_ok());
        assert!(validate_merge(&ready, &request(MergeAction::AutoMerge, None, seen)).is_err());
        assert!(validate_merge(&ready, &request(MergeAction::Merge, None, "0000000")).is_err());
        // Too short to name one commit.
        assert!(validate_merge(&ready, &request(MergeAction::Merge, None, "abc")).is_err());
        assert!(validate_merge(
            &ready,
            &request(MergeAction::Merge, Some(MergeMethod::Rebase), seen)
        )
        .is_err());
        let mut denied = ready.clone();
        denied.can_merge = Some(false);
        assert!(validate_merge(&denied, &request(MergeAction::Merge, None, seen)).is_err());
    }

    #[test]
    fn a_deferred_merge_only_deletes_the_branch_where_the_forge_can() {
        let mut ready = status(vec![MergeAction::Merge, MergeAction::AutoMerge]);
        ready.delete_source_branch = DeleteSourceBranch {
            default: false,
            configurable: true,
            deferred: false,
        };
        let mut asked = request(MergeAction::Merge, None, "abcdef1");
        asked.delete_source_branch = true;
        assert!(validate_merge(&ready, &asked).unwrap().delete_source_branch);
        asked.action = MergeAction::AutoMerge;
        assert!(!validate_merge(&ready, &asked).unwrap().delete_source_branch);
    }

    #[test]
    fn missing_approvals_are_counted_when_the_rule_says_how_many() {
        let none = PrApprovals::from_reviewers(Vec::new(), Some(2), None);
        assert_eq!(none.missing_reason(), "2 more approvals required");
        let unknown = PrApprovals::from_reviewers(Vec::new(), None, Some(false));
        assert_eq!(unknown.missing_reason(), "Approval required");
    }

    #[test]
    fn queue_actions_leave_the_method_to_the_queue() {
        let command = validate_merge(
            &status(vec![MergeAction::Enqueue]),
            &request(MergeAction::Enqueue, None, "abcdef1234567890"),
        )
        .expect("valid enqueue");
        assert_eq!(command.method, None);
    }

    #[test]
    fn humanizes_raw_forge_statuses() {
        assert_eq!(humanize_status("ci_must_pass"), "Ci must pass");
    }
}
