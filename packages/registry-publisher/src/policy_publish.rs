//! Publication of one signed revocation policy (provider, theme or tab) to
//! its fixed path on the discovery branch.
//!
//! The candidate must authenticate with the pinned key; the file already on
//! the branch must authenticate too and be strictly older (no rollback), or be
//! absent with an explicit bootstrap. A renewal must additionally carry
//! exactly the entries the branch holds now, so it can never drop a
//! revocation published since its baseline was read. The update is one
//! conditional write of that single path, followed by an unauthenticated
//! public read-back.
#[cfg(test)]
mod fixture;
mod flow;

use std::path::Path;

use cadencr_registry_core::{AuthenticatedPolicy, PolicyKind};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::PublisherError;

/// Local inputs of one policy publication; no network or token is consulted.
#[derive(bon::Builder)]
pub struct PreparePolicyRequest<'a> {
    pub kind: PolicyKind,
    pub signed: &'a Path,
    pub repository: &'a str,
    pub discovery_branch: &'a str,
    pub public_key: &'a Path,
    pub key_id: &'a str,
    /// Permit the first publication of this policy (the file is absent).
    #[builder(default)]
    pub bootstrap: bool,
    /// The candidate only re-signs the entries now on the branch with a new
    /// window: refuse it if the branch's entries differ at all.
    #[builder(default)]
    pub renewal: bool,
}

/// A candidate policy that authenticated locally and is current.
#[derive(Debug)]
pub struct PreparedPolicy {
    kind: PolicyKind,
    repository: String,
    branch: String,
    bytes: Vec<u8>,
    sha256: String,
    /// The candidate as authenticated when it was prepared: its window and
    /// entries are known without verifying the signature again.
    candidate: AuthenticatedPolicy,
    public_key_pem: Vec<u8>,
    key_id: String,
    bootstrap: bool,
    renewal: bool,
}

/// How a verified publication changed the branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyOutcome {
    Bootstrapped,
    Advanced,
    /// The branch already held exactly the candidate; nothing was written.
    Unchanged,
}

/// Proof that the public feed serves exactly the candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyReceipt {
    pub schema_version: u64,
    pub status: String,
    pub outcome: PolicyOutcome,
    pub kind: String,
    pub repository: String,
    pub branch: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub blob_sha: String,
    pub generated_at: String,
    pub expires_at: String,
    /// SHA-256 of the policy this one replaced, when there was one.
    pub previous_sha256: Option<String>,
}

/// Authenticate the candidate and validate the target before any credential
/// is read.
pub fn prepare_policy_publication(
    request: PreparePolicyRequest<'_>,
) -> Result<PreparedPolicy, PublisherError> {
    prepare_at(request, Utc::now())
}

fn prepare_at(
    request: PreparePolicyRequest<'_>,
    now: DateTime<Utc>,
) -> Result<PreparedPolicy, PublisherError> {
    if request.renewal && request.bootstrap {
        return Err(PublisherError::new(
            "a renewal re-signs a published policy and cannot bootstrap one",
        ));
    }
    if !cadencr_registry_core::valid_publication_repository(request.repository) {
        return Err(PublisherError::new("policy repository is invalid"));
    }
    cadencr_registry_core::validate_discovery_branch(request.discovery_branch)?;
    cadencr_registry_core::validate_signing_key_id(request.key_id)?;
    let bytes = crate::fs::read_bounded(
        request.signed,
        request.kind.max_signed_bytes() as u64,
        "signed policy",
    )?;
    let public_key_pem = crate::fs::read_bounded(request.public_key, 16 * 1024, "public key")?;
    // The candidate must be a current, correctly signed policy of its kind.
    let candidate = cadencr_registry_core::authenticate_policy(
        request.kind,
        &bytes,
        &public_key_pem,
        request.key_id,
        false,
        now,
    )?;
    Ok(PreparedPolicy {
        kind: request.kind,
        repository: request.repository.into(),
        branch: request.discovery_branch.into(),
        sha256: crate::hex(&Sha256::digest(&bytes)),
        bytes,
        candidate,
        public_key_pem,
        key_id: request.key_id.into(),
        bootstrap: request.bootstrap,
        renewal: request.renewal,
    })
}

/// Publish a prepared policy and verify the public feed serves it.
pub fn publish_policy(
    prepared: &PreparedPolicy,
    token: &str,
) -> Result<PolicyReceipt, PublisherError> {
    let client = crate::github::GitHubClient::new(&prepared.repository, token)?;
    flow::publish(
        prepared,
        &client,
        &crate::download::DiscoveryDownloader::default(),
        &flow::Timing::production(),
    )
}

/// The bytes of `kind`'s policy as the authenticated GitHub API serves them
/// from the discovery branch head, with no CDN in between. They are data until
/// the caller authenticates them against the pinned key.
pub fn read_published_policy(
    kind: PolicyKind,
    repository: &str,
    discovery_branch: &str,
    token: &str,
) -> Result<Vec<u8>, PublisherError> {
    use crate::github::discovery::PolicyClient as _;
    if !cadencr_registry_core::valid_publication_repository(repository) {
        return Err(PublisherError::new("policy repository is invalid"));
    }
    cadencr_registry_core::validate_discovery_branch(discovery_branch)?;
    let client = crate::github::GitHubClient::new(repository, token)?;
    let head = client
        .get_policy_before(discovery_branch, kind.file_name(), None)?
        .ok_or_else(|| {
            PublisherError::new(format!(
                "{} does not exist on {discovery_branch}",
                kind.file_name()
            ))
        })?;
    if head.bytes.len() > kind.max_signed_bytes() {
        return Err(PublisherError::new(format!(
            "the published {} exceeds its size limit",
            kind.file_name()
        )));
    }
    Ok(head.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_a_published_policy_validates_its_target_before_any_request() {
        for (repository, branch) in [("acme", "marketplace-v2"), ("acme/registry", "../main")] {
            let result = read_published_policy(PolicyKind::Tab, repository, branch, "token");
            assert!(result.is_err(), "{repository} {branch}");
        }
    }
}
