//! What the forge poller publishes per conversation.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::provider::{CiRollup, PrSummary};

/// The proposal of one of a conversation's non-current branches, with the
/// same health signals the snapshot carries for the current one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct BranchPr {
    pub branch: String,
    pub pr: PrSummary,
    pub ci: Option<CiRollup>,
    /// Same contract as [`PrStatusSnapshot::unresolved_threads`].
    #[serde(default)]
    pub unresolved_threads: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PrStatusSnapshot {
    pub feature_id: i64,
    pub pr: Option<PrSummary>,
    pub ci: Option<CiRollup>,
    pub fetched_at: i64,
    pub error: Option<String>,
    /// The forge cannot be reached until the user finishes connecting it — no
    /// token, no provider kind, no API base URL, or a token the forge rejected.
    ///
    /// `error` carries the specific reason. Kept separate from a transient
    /// failure (rate limit, network, unexpected response) because only this
    /// state is worth turning into an onboarding prompt: retrying will never
    /// clear it, and offering "connect a provider" for a 500 would be wrong.
    pub setup_required: bool,
    /// How many review threads the forge still reports as open.
    ///
    /// `None` means "not looked up", not "zero" — the poller only pays for the
    /// extra round trip when the checks are green, because that is the only
    /// state where the count changes what the sidebar shows. Consumers must
    /// treat `None` as unknown and fall back to the check-driven tone.
    #[serde(default)]
    pub unresolved_threads: Option<u32>,
    /// The proposals of the conversation's other branches — everything above
    /// describes the current branch's. Only branches that have one.
    #[serde(default)]
    pub other_prs: Vec<BranchPr>,
}

impl PrStatusSnapshot {
    /// A snapshot for a feature the poller could not ask a forge about — no
    /// remote, no branch, or the request never got off the ground.
    pub fn unpolled(feature_id: i64, error: Option<String>, setup_required: bool) -> Self {
        Self {
            feature_id,
            pr: None,
            ci: None,
            fetched_at: chrono::Utc::now().timestamp_millis(),
            error,
            setup_required,
            unresolved_threads: None,
            other_prs: Vec::new(),
        }
    }

    /// Whether a freshly polled snapshot says anything new. Gates the WebSocket
    /// broadcast, so a field missing here is an update the UI never sees.
    ///
    /// Destructured rather than written as a field list: adding a field to
    /// `PrStatusSnapshot` then fails to compile here, which is how the
    /// `unresolved_threads` omission should have been caught. Mirrored by
    /// `prStatusSnapshotsEqual` in `usePrStatusStore.ts`.
    pub fn semantic_eq(&self, other: &Self) -> bool {
        let Self {
            feature_id,
            pr,
            ci,
            // Advances on every poll whether or not anything changed; comparing
            // it would rebroadcast the whole sidebar once a minute, forever.
            fetched_at: _,
            error,
            setup_required,
            unresolved_threads,
            other_prs,
        } = self;
        *feature_id == other.feature_id
            && *pr == other.pr
            && *ci == other.ci
            && *error == other.error
            && *setup_required == other.setup_required
            && *unresolved_threads == other.unresolved_threads
            && *other_prs == other.other_prs
    }
}
