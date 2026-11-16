use std::time::Instant;

use chrono::{DateTime, Utc};
use sha2::{Digest as _, Sha256};

use super::{PolicyOutcome, PolicyReceipt, PreparedPolicy};
use crate::convergence::ReadBack;
use crate::download::DiscoveryReader;
use crate::github::discovery::write;
use crate::github::discovery::{DiscoveryHead, PolicyClient, SetPolicyRequest};
use crate::PublisherError;

/// The wall clock and the read-back pacing; tests substitute their own.
#[derive(bon::Builder)]
pub(super) struct Timing {
    #[builder(with = |now: impl Fn() -> DateTime<Utc> + 'static| Box::new(now))]
    pub(super) now: Box<dyn Fn() -> DateTime<Utc>>,
    pub(super) read_back: ReadBack,
    /// Pacing of the read-back of the public stable URL, which sits behind a
    /// CDN cache.
    pub(super) public_read: ReadBack,
}

impl Timing {
    pub(super) fn production() -> Self {
        Self::builder()
            .now(Utc::now)
            .read_back(ReadBack::production())
            .public_read(ReadBack::public_feed())
            .build()
    }
}

/// What the branch holds relative to the candidate.
enum Assessment {
    /// The file is absent and the operator asked for the first publication.
    Bootstrap,
    /// An authenticated, strictly older policy is published.
    Advance { previous_sha256: String },
    /// The branch already holds exactly the candidate.
    Replay,
}

pub(super) fn publish(
    prepared: &PreparedPolicy,
    client: &impl PolicyClient,
    reader: &impl DiscoveryReader,
    timing: &Timing,
) -> Result<PolicyReceipt, PublisherError> {
    let file = prepared.kind.file_name();
    let branch = prepared.branch.as_str();
    let read = |deadline| client.get_policy_before(branch, file, deadline);
    let original = read(None)?;
    let assessment = assess(prepared, original.as_ref(), timing)?;
    let current = read(None)?;
    write::require_same_head(
        original.as_ref(),
        current.as_ref(),
        "policy changed before publication",
    )?;
    require_fresh(prepared, timing)?;
    let written = match assessment {
        Assessment::Replay => {
            current.ok_or_else(|| PublisherError::new("policy does not contain the candidate"))?
        }
        _ => set_or_reconcile(prepared, client, original.as_ref(), timing)?,
    };
    require_candidate(prepared, Some(&written))?;
    verify_public(prepared, &assessment, &written, client, reader, timing)?;
    let after = read(None)?;
    require_candidate(prepared, after.as_ref())?;
    if after.as_ref().map(|head| &head.sha) != Some(&written.sha) {
        return Err(PublisherError::new(
            "policy changed during public verification",
        ));
    }
    require_fresh(prepared, timing)?;
    receipt(prepared, &assessment, &written.sha)
}

/// Judge the published file: absent needs `bootstrap`; present must
/// authenticate, be strictly older than the candidate and, for a renewal,
/// carry exactly the candidate's entries.
fn assess(
    prepared: &PreparedPolicy,
    head: Option<&DiscoveryHead>,
    timing: &Timing,
) -> Result<Assessment, PublisherError> {
    let file = prepared.kind.file_name();
    let Some(head) = head else {
        return if prepared.bootstrap {
            Ok(Assessment::Bootstrap)
        } else if prepared.renewal {
            Err(PublisherError::new(format!(
                "renewal refused: {file} does not exist on {}",
                prepared.branch
            )))
        } else {
            Err(PublisherError::new(format!(
                "{file} does not exist on {}; the first publication requires --bootstrap",
                prepared.branch
            )))
        };
    };
    if head.bytes == prepared.bytes {
        return Ok(Assessment::Replay);
    }
    if prepared.bootstrap {
        return Err(PublisherError::new(format!(
            "--bootstrap refused: {file} already exists on {}",
            prepared.branch
        )));
    }
    // An expired published policy is still a valid baseline if it is ours.
    let published = cadencr_registry_core::authenticate_policy(
        prepared.kind,
        &head.bytes,
        &prepared.public_key_pem,
        &prepared.key_id,
        true,
        (timing.now)(),
    )
    .map_err(|error| {
        PublisherError::new(format!(
            "the published {file} does not authenticate; refusing to replace it: {error}"
        ))
    })?;
    if prepared.candidate.generated_at() <= published.generated_at() {
        return Err(PublisherError::new(format!(
            "rollback refused: the candidate {file} is not generated after the published one"
        )));
    }
    if prepared.renewal
        && prepared.candidate.signed().get("entries") != published.signed().get("entries")
    {
        return Err(PublisherError::new(format!(
            "renewal refused: the entries of the published {file} differ from the candidate's; \
             a revocation may have been published since the renewal baseline was read, so \
             renew again from the published policy"
        )));
    }
    Ok(Assessment::Advance {
        previous_sha256: crate::hex(&Sha256::digest(&head.bytes)),
    })
}

/// The candidate is still current: it can expire while publication runs.
fn require_fresh(prepared: &PreparedPolicy, timing: &Timing) -> Result<(), PublisherError> {
    if prepared.candidate.expires_at() <= (timing.now)() {
        return Err(PublisherError::new(format!(
            "the candidate {} expired during publication",
            prepared.kind.file_name()
        )));
    }
    Ok(())
}

fn require_candidate(
    prepared: &PreparedPolicy,
    head: Option<&DiscoveryHead>,
) -> Result<(), PublisherError> {
    write::require_candidate(head, &prepared.bytes, "policy")
}

/// One conditional write of the single fixed path, on the blob that was read.
fn set_or_reconcile(
    prepared: &PreparedPolicy,
    client: &impl PolicyClient,
    original: Option<&DiscoveryHead>,
    timing: &Timing,
) -> Result<DiscoveryHead, PublisherError> {
    let file = prepared.kind.file_name();
    let message = format!("Update managed {} revocation policy", prepared.kind.name());
    write::set_or_reconcile()
        .candidate(&prepared.bytes)
        .subject("policy")
        .original(original)
        .pacing(&timing.read_back)
        .set(|| {
            client.set_policy(
                SetPolicyRequest::builder()
                    .branch(&prepared.branch)
                    .file(file)
                    .message(&message)
                    .bytes(&prepared.bytes)
                    .maybe_expected_sha(original.map(|head| head.sha.as_str()))
                    .build(),
            )
        })
        .read(|deadline| client.probe_policy(&prepared.branch, file, deadline, original))
        .call()
}

fn verify_public(
    prepared: &PreparedPolicy,
    assessment: &Assessment,
    written: &DiscoveryHead,
    client: &impl PolicyClient,
    reader: &impl DiscoveryReader,
    timing: &Timing,
) -> Result<(), PublisherError> {
    let file = prepared.kind.file_name();
    let url =
        cadencr_registry_core::discovery_object_url(&prepared.repository, &prepared.branch, file)?;
    let previous = match assessment {
        Assessment::Advance { previous_sha256 } => Some(previous_sha256.as_str()),
        _ => None,
    };
    let scratch = tempfile::tempdir()
        .map_err(|error| PublisherError::io("create policy verification directory", error))?;
    let revalidate = |deadline: Instant| {
        require_fresh(prepared, timing)?;
        let current = client.get_policy_before(&prepared.branch, file, Some(deadline))?;
        require_candidate(prepared, current.as_ref())?;
        if current.as_ref().map(|head| &head.sha) != Some(&written.sha) {
            return Err(PublisherError::new(
                "policy changed during public verification",
            ));
        }
        require_fresh(prepared, timing)
    };
    crate::public_read::verify_public_object()
        .url(&url)
        .file_name(file)
        .sha256(&prepared.sha256)
        .size(prepared.bytes.len() as u64)
        .max_bytes(prepared.kind.max_signed_bytes() as u64)
        .maybe_previous_sha256(previous)
        .directory(scratch.path())
        .downloader(reader)
        .revalidate(&revalidate)
        .pacing(&timing.public_read)
        .call()
}

fn receipt(
    prepared: &PreparedPolicy,
    assessment: &Assessment,
    blob_sha: &str,
) -> Result<PolicyReceipt, PublisherError> {
    let file = prepared.kind.file_name();
    let timestamp = |value: DateTime<Utc>| value.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    Ok(PolicyReceipt {
        schema_version: 1,
        status: "policy_verified".into(),
        outcome: match assessment {
            Assessment::Bootstrap => PolicyOutcome::Bootstrapped,
            Assessment::Advance { .. } => PolicyOutcome::Advanced,
            Assessment::Replay => PolicyOutcome::Unchanged,
        },
        kind: prepared.kind.name().into(),
        repository: prepared.repository.clone(),
        branch: prepared.branch.clone(),
        url: cadencr_registry_core::discovery_object_url(
            &prepared.repository,
            &prepared.branch,
            file,
        )?,
        sha256: prepared.sha256.clone(),
        size: prepared.bytes.len() as u64,
        blob_sha: blob_sha.into(),
        generated_at: timestamp(prepared.candidate.generated_at()),
        expires_at: timestamp(prepared.candidate.expires_at()),
        previous_sha256: match assessment {
            Assessment::Advance { previous_sha256 } => Some(previous_sha256.clone()),
            _ => None,
        },
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::super::fixture::{
        blob_sha, sha256, timing, timing_at, timing_with, MockGitHub, ScriptedFeed, Workspace,
        BRANCH, KINDS, REPOSITORY,
    };
    use super::super::PreparePolicyRequest;
    use super::*;
    use crate::convergence::VirtualClock;
    use cadencr_registry_core::PolicyKind;

    const HOUR: Duration = Duration::from_secs(3600);
    const WINDOW: Duration = Duration::from_secs(13 * 24 * 3600);

    fn error_of<T>(result: Result<T, PublisherError>) -> String {
        result.err().expect("expected a refusal").to_string()
    }

    #[test]
    fn bootstrap_creates_each_policy_at_its_fixed_path_and_verifies_the_public_feed() {
        for kind in KINDS {
            let work = Workspace::new();
            let candidate = work.signed(kind, HOUR, WINDOW, "first");
            let prepared = work.prepared(kind, &candidate, true).unwrap();
            let github = MockGitHub::with_head(None);
            let feed = ScriptedFeed::new(vec![candidate.clone()]);
            let receipt = publish(&prepared, &github, &feed, &timing(&work)).unwrap();
            let sets = github.sets.borrow();
            assert_eq!(sets.len(), 1);
            assert_eq!(sets[0].file, kind.file_name());
            assert_eq!(sets[0].expected_sha, None);
            assert_eq!(sets[0].bytes, candidate);
            assert!(sets[0].message.contains(kind.name()));
            assert_eq!(receipt.outcome, PolicyOutcome::Bootstrapped);
            assert_eq!(receipt.sha256, sha256(&candidate));
            assert_eq!(receipt.blob_sha, blob_sha(&candidate));
            assert_eq!(receipt.previous_sha256, None);
            assert_eq!(
                receipt.url,
                format!(
                    "https://raw.githubusercontent.com/{REPOSITORY}/refs/heads/{BRANCH}/{}",
                    kind.file_name()
                )
            );
            assert_eq!(feed.calls.get(), 1);
        }
    }

    #[test]
    fn first_publication_requires_an_explicit_bootstrap() {
        let work = Workspace::new();
        let candidate = work.signed(PolicyKind::Theme, HOUR, WINDOW, "first");
        let prepared = work.prepared(PolicyKind::Theme, &candidate, false).unwrap();
        let github = MockGitHub::with_head(None);
        let feed = ScriptedFeed::new(vec![candidate]);
        let message = error_of(publish(&prepared, &github, &feed, &timing(&work)));
        assert!(message.contains("--bootstrap"), "{message}");
        assert!(github.sets.borrow().is_empty());
        assert_eq!(feed.calls.get(), 0);
    }

    #[test]
    fn bootstrap_never_replaces_an_existing_policy() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Tab, 2 * HOUR, WINDOW, "old");
        let candidate = work.signed(PolicyKind::Tab, HOUR, WINDOW, "new");
        let prepared = work.prepared(PolicyKind::Tab, &candidate, true).unwrap();
        let github = MockGitHub::with_head(Some(&published));
        let message = error_of(publish(
            &prepared,
            &github,
            &ScriptedFeed::new(vec![candidate]),
            &timing(&work),
        ));
        assert!(message.contains("--bootstrap refused"), "{message}");
        assert!(github.sets.borrow().is_empty());
    }

    #[test]
    fn advances_with_a_conditional_update_of_the_exact_published_blob() {
        for kind in KINDS {
            let work = Workspace::new();
            let published = work.signed(kind, 2 * HOUR, WINDOW, "old");
            let candidate = work.signed(kind, HOUR, WINDOW, "new");
            let prepared = work.prepared(kind, &candidate, false).unwrap();
            let github = MockGitHub::with_head(Some(&published));
            // The public CDN lags: it serves the previous body first.
            let feed = ScriptedFeed::new(vec![
                published.clone(),
                published.clone(),
                candidate.clone(),
            ]);
            let receipt = publish(&prepared, &github, &feed, &timing(&work)).unwrap();
            let sets = github.sets.borrow();
            assert_eq!(sets.len(), 1, "{kind:?}");
            assert_eq!(sets[0].expected_sha, Some(blob_sha(&published)));
            assert_eq!(receipt.outcome, PolicyOutcome::Advanced);
            assert_eq!(receipt.previous_sha256, Some(sha256(&published)));
            assert_eq!(feed.calls.get(), 3);
            assert_eq!(github.head_bytes().unwrap(), candidate);
        }
    }

    #[test]
    fn rollback_and_same_generation_are_refused_without_writing() {
        for kind in KINDS {
            let work = Workspace::new();
            let newer = work.signed(kind, HOUR, WINDOW, "newer");
            let older = work.signed(kind, 3 * HOUR, WINDOW, "older");
            let prepared = work.prepared(kind, &older, false).unwrap();
            let github = MockGitHub::with_head(Some(&newer));
            let message = error_of(publish(
                &prepared,
                &github,
                &ScriptedFeed::new(vec![older.clone()]),
                &timing(&work),
            ));
            assert!(message.contains("rollback refused"), "{message}");
            // The same generation second with different entries is no advance.
            let sibling = work.signed(kind, HOUR, WINDOW, "sibling");
            let prepared = work.prepared(kind, &sibling, false).unwrap();
            let message = error_of(publish(
                &prepared,
                &github,
                &ScriptedFeed::new(vec![sibling]),
                &timing(&work),
            ));
            assert!(message.contains("rollback refused"), "{message}");
            assert!(github.sets.borrow().is_empty());
            assert_eq!(github.head_bytes().unwrap(), newer);
        }
    }

    #[test]
    fn a_renewal_advances_only_the_window_of_the_entries_on_the_branch() {
        for kind in KINDS {
            let work = Workspace::new();
            let published = work.signed(kind, 2 * HOUR, WINDOW, "same");
            let candidate = work.signed(kind, HOUR, WINDOW, "same");
            let prepared = work.renewal(kind, &candidate).unwrap();
            let github = MockGitHub::with_head(Some(&published));
            let feed = ScriptedFeed::new(vec![candidate.clone()]);
            let receipt = publish(&prepared, &github, &feed, &timing(&work)).unwrap();
            assert_eq!(receipt.outcome, PolicyOutcome::Advanced, "{kind:?}");
            assert_eq!(github.head_bytes().unwrap(), candidate);
        }
    }

    #[test]
    fn a_renewal_never_drops_a_revocation_published_since_its_baseline() {
        for kind in KINDS {
            let work = Workspace::new();
            // The operator published a newer revocation after the (stale)
            // renewal baseline was read: other entries, older generation than
            // the renewal.
            let published = work.signed(kind, 2 * HOUR, WINDOW, "new-revocation");
            let renewal = work.signed(kind, HOUR, WINDOW, "stale-baseline");
            let github = MockGitHub::with_head(Some(&published));
            let feed = ScriptedFeed::new(vec![renewal.clone()]);
            let prepared = work.renewal(kind, &renewal).unwrap();
            let message = error_of(publish(&prepared, &github, &feed, &timing(&work)));
            assert!(message.contains("renewal refused"), "{message}");
            assert!(message.contains("differ"), "{message}");
            assert!(github.sets.borrow().is_empty());
            assert_eq!(github.head_bytes().unwrap(), published);
            // The same pair is an ordinary reviewed publication without the
            // renewal flag, which is how an operator replaces entries.
            let prepared = work.prepared(kind, &renewal, false).unwrap();
            publish(&prepared, &github, &feed, &timing(&work)).unwrap();
        }
    }

    #[test]
    fn a_renewal_needs_a_published_policy_and_cannot_bootstrap() {
        let work = Workspace::new();
        let kind = PolicyKind::Provider;
        let candidate = work.signed(kind, HOUR, WINDOW, "first");
        let prepared = work.renewal(kind, &candidate).unwrap();
        let github = MockGitHub::with_head(None);
        let feed = ScriptedFeed::new(vec![candidate.clone()]);
        let message = error_of(publish(&prepared, &github, &feed, &timing(&work)));
        assert!(message.contains("renewal refused"), "{message}");
        assert!(github.sets.borrow().is_empty());
        let both = work.prepared_at(kind, &candidate, true, true, work.start);
        assert!(error_of(both).contains("cannot bootstrap"));
    }

    #[test]
    fn a_candidate_that_expires_while_publishing_is_never_written() {
        let work = Workspace::new();
        let kind = PolicyKind::Tab;
        let candidate = work.signed(kind, HOUR, 2 * HOUR, "short");
        let prepared = work.prepared(kind, &candidate, true).unwrap();
        let github = MockGitHub::with_head(None);
        let clock = work.start + chrono::Duration::hours(2);
        let feed = ScriptedFeed::new(vec![candidate]);
        let message = error_of(publish(&prepared, &github, &feed, &timing_at(clock)));
        assert!(message.contains("expired during publication"), "{message}");
        assert!(github.sets.borrow().is_empty());
    }

    #[test]
    fn an_unauthenticated_published_policy_is_never_replaced() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Provider, 2 * HOUR, WINDOW, "old");
        let mut envelope: serde_json::Value = serde_json::from_slice(&published).unwrap();
        envelope["signed"]["entries"] = serde_json::json!([]);
        let tampered = serde_json::to_vec(&envelope).unwrap();
        let candidate = work.signed(PolicyKind::Provider, HOUR, WINDOW, "new");
        let prepared = work
            .prepared(PolicyKind::Provider, &candidate, false)
            .unwrap();
        for head in [tampered, b"not json".to_vec()] {
            let github = MockGitHub::with_head(Some(&head));
            let message = error_of(publish(
                &prepared,
                &github,
                &ScriptedFeed::new(vec![candidate.clone()]),
                &timing(&work),
            ));
            assert!(message.contains("does not authenticate"), "{message}");
            assert!(github.sets.borrow().is_empty());
        }
    }

    #[test]
    fn an_expired_but_authentic_published_policy_is_a_valid_baseline() {
        let work = Workspace::new();
        // Published an hour before `start`, valid for two: expired at the
        // clock below, which is three hours later.
        let published = work.signed(PolicyKind::Theme, HOUR, 2 * HOUR, "expired");
        let candidate = work.signed(PolicyKind::Theme, Duration::ZERO, WINDOW, "renewed");
        let clock = work.start + chrono::Duration::hours(3);
        let prepared = work
            .prepared_at(PolicyKind::Theme, &candidate, false, false, clock)
            .unwrap();
        let github = MockGitHub::with_head(Some(&published));
        let feed = ScriptedFeed::new(vec![candidate]);
        publish(&prepared, &github, &feed, &timing_at(clock)).unwrap();
        assert_eq!(github.sets.borrow().len(), 1);
    }

    #[test]
    fn publishing_the_candidate_again_is_an_unchanged_replay() {
        let work = Workspace::new();
        let candidate = work.signed(PolicyKind::Tab, HOUR, WINDOW, "same");
        let prepared = work.prepared(PolicyKind::Tab, &candidate, false).unwrap();
        let github = MockGitHub::with_head(Some(&candidate));
        let receipt = publish(
            &prepared,
            &github,
            &ScriptedFeed::new(vec![candidate]),
            &timing(&work),
        )
        .unwrap();
        assert_eq!(receipt.outcome, PolicyOutcome::Unchanged);
        assert!(github.sets.borrow().is_empty());
    }

    #[test]
    fn a_lost_response_is_reconciled_by_reading_the_branch_back() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Provider, 2 * HOUR, WINDOW, "old");
        let candidate = work.signed(PolicyKind::Provider, HOUR, WINDOW, "new");
        let prepared = work
            .prepared(PolicyKind::Provider, &candidate, false)
            .unwrap();
        let github = MockGitHub::with_head(Some(&published));
        github.lose_response();
        let feed = ScriptedFeed::new(vec![published, candidate]);
        let receipt = publish(&prepared, &github, &feed, &timing(&work)).unwrap();
        assert_eq!(receipt.outcome, PolicyOutcome::Advanced);
        assert_eq!(github.sets.borrow().len(), 1);
    }

    #[test]
    fn a_conflicting_writer_fails_the_conditional_update_and_is_never_overwritten() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Theme, 3 * HOUR, WINDOW, "old");
        let foreign = work.signed(PolicyKind::Theme, 2 * HOUR, WINDOW, "foreign");
        let candidate = work.signed(PolicyKind::Theme, HOUR, WINDOW, "new");
        let prepared = work.prepared(PolicyKind::Theme, &candidate, false).unwrap();
        let github = MockGitHub::with_head(Some(&published));
        github.race_with(&foreign);
        let feed = ScriptedFeed::new(vec![candidate]);
        let message = error_of(publish(&prepared, &github, &feed, &timing(&work)));
        assert!(message.contains("conflict"), "{message}");
        assert_eq!(github.sets.borrow().len(), 1, "no retry of the write");
        assert_eq!(github.head_bytes().unwrap(), foreign);
        assert_eq!(feed.calls.get(), 0);
    }

    #[test]
    fn the_branch_moving_between_reads_stops_before_any_write() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Tab, 3 * HOUR, WINDOW, "old");
        let foreign = work.signed(PolicyKind::Tab, 2 * HOUR, WINDOW, "foreign");
        let candidate = work.signed(PolicyKind::Tab, HOUR, WINDOW, "new");
        let prepared = work.prepared(PolicyKind::Tab, &candidate, false).unwrap();
        let github = MockGitHub::with_head(Some(&published));
        github.foreign_head_at_get(2, &foreign);
        let message = error_of(publish(
            &prepared,
            &github,
            &ScriptedFeed::new(vec![candidate]),
            &timing(&work),
        ));
        assert!(message.contains("changed before publication"), "{message}");
        assert!(github.sets.borrow().is_empty());
    }

    #[test]
    fn the_branch_moving_during_read_back_fails_verification() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Provider, 3 * HOUR, WINDOW, "old");
        let foreign = work.signed(PolicyKind::Provider, 2 * HOUR, WINDOW, "foreign");
        let candidate = work.signed(PolicyKind::Provider, HOUR, WINDOW, "new");
        let prepared = work
            .prepared(PolicyKind::Provider, &candidate, false)
            .unwrap();
        let github = MockGitHub::with_head(Some(&published));
        // Reads: 1-2 assessment, 3 after the write, 4 inside the convergence loop.
        github.foreign_head_at_get(4, &foreign);
        let feed = ScriptedFeed::new(vec![published, candidate]);
        let message = error_of(publish(&prepared, &github, &feed, &timing(&work)));
        assert!(
            message.contains("does not contain the candidate")
                || message.contains("changed during public verification"),
            "{message}"
        );
    }

    #[test]
    fn public_read_back_accepts_only_the_candidate_or_a_bounded_previous_body() {
        let work = Workspace::new();
        let kind = PolicyKind::Theme;
        let published = work.signed(kind, 2 * HOUR, WINDOW, "old");
        let candidate = work.signed(kind, HOUR, WINDOW, "new");
        let prepared = work.prepared(kind, &candidate, false).unwrap();
        for (bodies, expected) in [
            (vec![b"tampered".to_vec()], "unrecognized content digest"),
            (vec![published.clone()], "convergence read budget exhausted"),
        ] {
            let github = MockGitHub::with_head(Some(&published));
            let message = error_of(publish(
                &prepared,
                &github,
                &ScriptedFeed::new(bodies),
                &timing(&work),
            ));
            assert!(message.contains(expected), "{message}");
        }
        // A bootstrap has no previous body to wait out.
        let prepared = work.prepared(kind, &candidate, true).unwrap();
        let github = MockGitHub::with_head(None);
        let message = error_of(publish(
            &prepared,
            &github,
            &ScriptedFeed::new(vec![published]),
            &timing(&work),
        ));
        assert!(message.contains("unrecognized content digest"), "{message}");
    }

    /// Publish an update whose public URL serves `stale` previous bodies
    /// before the candidate, on public pacing `public` of `clock`.
    fn publish_behind_cdn(
        stale: usize,
        clock: &VirtualClock,
        public: ReadBack,
    ) -> (Result<PolicyReceipt, PublisherError>, Duration) {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Theme, 2 * HOUR, WINDOW, "old");
        let candidate = work.signed(PolicyKind::Theme, HOUR, WINDOW, "new");
        let prepared = work.prepared(PolicyKind::Theme, &candidate, false).unwrap();
        let github = MockGitHub::with_head(Some(&published));
        let mut bodies = vec![published; stale];
        bodies.push(candidate);
        let timing = timing_with(work.start, clock.read_back(), public);
        let result = publish(&prepared, &github, &ScriptedFeed::new(bodies), &timing);
        let waited = clock.waits.borrow().iter().sum();
        (result, waited)
    }

    #[test]
    fn the_public_read_back_outwaits_a_five_minute_cdn_cache_of_the_previous_body() {
        // About forty reads at the doubling-to-eight-seconds pacing is just
        // past the 300 s `max-age` of raw.githubusercontent.com.
        let clock = VirtualClock::new();
        let (result, waited) = publish_behind_cdn(40, &clock, clock.public_read_back());
        assert_eq!(result.unwrap().outcome, PolicyOutcome::Advanced);
        assert!(waited >= Duration::from_secs(300), "{waited:?}");
        assert!(waited <= Duration::from_secs(360), "{waited:?}");
    }

    #[test]
    fn a_public_body_that_stays_previous_fails_closed_within_the_public_budget() {
        // The attempt cap ends a run of fast reads, still past the max-age.
        let clock = VirtualClock::new();
        let (result, waited) = publish_behind_cdn(1000, &clock, clock.public_read_back());
        assert!(error_of(result).contains("convergence read budget exhausted"));
        assert!(waited > Duration::from_secs(300), "{waited:?}");
        assert!(waited <= Duration::from_secs(360), "{waited:?}");
        // Without the cap the 360 s deadline ends it, never later.
        let clock = VirtualClock::new();
        let (result, waited) =
            publish_behind_cdn(1000, &clock, clock.public_read_back_capped(1000));
        assert!(error_of(result).contains("convergence read budget exhausted"));
        assert!(waited > Duration::from_secs(340), "{waited:?}");
        assert!(waited <= Duration::from_secs(360), "{waited:?}");
        // A candidate arriving after the deadline is too late.
        let clock = VirtualClock::new();
        let (result, _) = publish_behind_cdn(100, &clock, clock.public_read_back_capped(1000));
        assert!(error_of(result).contains("convergence read budget exhausted"));
    }

    #[test]
    fn the_authenticated_read_back_stays_at_thirty_seconds() {
        let clock = VirtualClock::new();
        // Reads that stay stale on the API side give up inside 30 s even
        // though the public pacing would have allowed six minutes.
        let (work, github, prepared, _) = lagging(None, u64::MAX);
        let timing = timing_with(work.start, clock.read_back(), clock.public_read_back());
        assert!(error_of(publish(
            &prepared,
            &github,
            &ScriptedFeed::new(vec![]),
            &timing
        ))
        .contains("stale pre-write state"));
        let waited: Duration = clock.waits.borrow().iter().sum();
        assert!(waited <= Duration::from_secs(30), "{waited:?}");
    }

    #[test]
    fn candidates_must_authenticate_be_current_and_target_a_valid_branch() {
        let work = Workspace::new();
        let kind = PolicyKind::Tab;
        let candidate = work.signed(kind, HOUR, WINDOW, "new");
        assert!(work.prepared(kind, &candidate, false).is_ok());
        // A tab policy is not a theme or provider policy.
        for other in [PolicyKind::Theme, PolicyKind::Provider] {
            assert!(work.prepared(other, &candidate, false).is_err());
        }
        let mut envelope: serde_json::Value = serde_json::from_slice(&candidate).unwrap();
        envelope["signature"]["key_id"] = serde_json::json!("other-key");
        assert!(work
            .prepared(kind, &serde_json::to_vec(&envelope).unwrap(), false)
            .is_err());
        // Valid for two hours from an hour before `start`; gone three hours on.
        let expired = work.signed(kind, HOUR, 2 * HOUR, "gone");
        assert!(work.prepared(kind, &expired, false).is_ok());
        let later = work.start + chrono::Duration::hours(3);
        assert!(work
            .prepared_at(kind, &expired, false, false, later)
            .is_err());
        let signed = work.directory.path().join("candidate.json");
        for (repository, branch) in [("acme", BRANCH), (REPOSITORY, "../main")] {
            std::fs::write(&signed, &candidate).unwrap();
            let request = PreparePolicyRequest::builder()
                .kind(kind)
                .signed(&signed)
                .repository(repository)
                .discovery_branch(branch)
                .public_key(&work.public)
                .key_id("release-2026")
                .build();
            assert!(super::super::prepare_at(request, work.start).is_err());
        }
    }

    /// Publish `candidate` over `published` (or a bootstrap) against a GitHub
    /// whose authenticated reads lag `lag` reads behind the write.
    fn lagging(
        published: Option<&[u8]>,
        lag: u64,
    ) -> (Workspace, MockGitHub, super::super::PreparedPolicy, Vec<u8>) {
        let work = Workspace::new();
        let candidate = work.signed(PolicyKind::Theme, HOUR, WINDOW, "new");
        let prepared = work
            .prepared(PolicyKind::Theme, &candidate, published.is_none())
            .unwrap();
        let github = MockGitHub::with_head(published);
        github.lag_reads(lag);
        (work, github, prepared, candidate)
    }

    /// Timing whose read-back waits are recorded by `clock`.
    fn timed(work: &Workspace, clock: &VirtualClock) -> Timing {
        timing_with(work.start, clock.read_back(), clock.public_read_back())
    }

    #[test]
    fn a_bootstrap_waits_out_an_authenticated_read_that_still_shows_the_file_absent() {
        let (work, github, prepared, candidate) = lagging(None, 3);
        let feed = ScriptedFeed::new(vec![candidate.clone()]);
        let clock = VirtualClock::new();
        let receipt = publish(&prepared, &github, &feed, &timed(&work, &clock)).unwrap();
        assert_eq!(receipt.outcome, PolicyOutcome::Bootstrapped);
        assert_eq!(github.sets.borrow().len(), 1, "the write is never repeated");
        // Two assessment reads, three stale reads, the converged read, then
        // the final authenticated read after the public verification.
        assert_eq!(github.gets(), 7);
        let backoff: Vec<_> = [250, 500, 1000].map(Duration::from_millis).into();
        assert_eq!(*clock.waits.borrow(), backoff);
        assert_eq!(github.head_bytes().unwrap(), candidate);
    }

    #[test]
    fn an_update_waits_out_an_authenticated_read_that_still_shows_the_old_blob() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Theme, 2 * HOUR, WINDOW, "old");
        let (_, github, prepared, candidate) = lagging(Some(&published), 2);
        let feed = ScriptedFeed::new(vec![published, candidate]);
        let clock = VirtualClock::new();
        let receipt = publish(&prepared, &github, &feed, &timed(&work, &clock)).unwrap();
        assert_eq!(receipt.outcome, PolicyOutcome::Advanced);
        assert_eq!(
            clock.waits.borrow().len(),
            2 + 1,
            "two reads, one public retry"
        );
        assert_eq!(github.sets.borrow().len(), 1);
    }

    #[test]
    fn a_read_that_stays_stale_for_the_whole_budget_fails_and_names_the_stale_read() {
        let (work, github, prepared, _) = lagging(None, u64::MAX);
        let feed = ScriptedFeed::new(vec![]);
        let clock = VirtualClock::new();
        let message = error_of(publish(&prepared, &github, &feed, &timed(&work, &clock)));
        assert!(message.contains("stale pre-write state"), "{message}");
        assert!(message.contains("file absent"), "{message}");
        assert!(message.contains("re-run"), "{message}");
        assert_eq!(github.sets.borrow().len(), 1);
        let waited: Duration = clock.waits.borrow().iter().sum();
        assert!(waited <= Duration::from_secs(30), "{waited:?}");
        assert!(waited > Duration::from_secs(15), "{waited:?}");
        assert_eq!(feed.calls.get(), 0, "never reaches the public read");
    }

    #[test]
    fn the_attempt_budget_bounds_the_stale_reads_whatever_time_is_left() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Theme, 2 * HOUR, WINDOW, "old");
        let (_, github, prepared, _) = lagging(Some(&published), u64::MAX);
        let clock = VirtualClock::new();
        let timing = timing_with(
            work.start,
            clock.read_back_capped(3),
            clock.public_read_back(),
        );
        let message = error_of(publish(
            &prepared,
            &github,
            &ScriptedFeed::new(vec![]),
            &timing,
        ));
        assert!(message.contains("3 authenticated reads"), "{message}");
        assert!(message.contains("blob"), "{message}");
        assert_eq!(github.gets(), 2 + 3);
        assert_eq!(clock.waits.borrow().len(), 2);
    }

    #[test]
    fn a_foreign_head_after_the_write_is_refused_at_once_without_another_write() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Theme, 3 * HOUR, WINDOW, "old");
        let foreign = work.signed(PolicyKind::Theme, 2 * HOUR, WINDOW, "foreign");
        let (_, github, prepared, _) = lagging(Some(&published), 1);
        // Reads: 1-2 assessment, 3 stale, 4 shows someone else's policy.
        github.foreign_head_at_get(4, &foreign);
        let feed = ScriptedFeed::new(vec![]);
        let clock = VirtualClock::new();
        let message = error_of(publish(&prepared, &github, &feed, &timed(&work, &clock)));
        assert!(message.contains("neither the candidate"), "{message}");
        assert_eq!(github.sets.borrow().len(), 1);
        assert_eq!(
            clock.waits.borrow().len(),
            1,
            "no waiting once the head is foreign"
        );
        assert_eq!(github.gets(), 4);
        assert_eq!(github.head_bytes().unwrap(), foreign);
        assert_eq!(feed.calls.get(), 0);
    }

    #[test]
    fn a_failed_write_gets_one_probe_and_never_a_wait() {
        let work = Workspace::new();
        let published = work.signed(PolicyKind::Theme, 2 * HOUR, WINDOW, "old");
        // The write lands but its response is lost, and the probe sees it.
        let (_, github, prepared, candidate) = lagging(Some(&published), 0);
        github.lose_response();
        let feed = ScriptedFeed::new(vec![candidate]);
        let clock = VirtualClock::new();
        let receipt = publish(&prepared, &github, &feed, &timed(&work, &clock)).unwrap();
        assert_eq!(receipt.outcome, PolicyOutcome::Advanced);
        // Lagging, the probe still sees the old state: the write's own error.
        let (_, github, prepared, _) = lagging(Some(&published), 2);
        github.lose_response();
        let message = error_of(publish(
            &prepared,
            &github,
            &ScriptedFeed::new(vec![]),
            &timed(&work, &clock),
        ));
        assert!(message.contains("timeout"), "{message}");
        assert_eq!(github.gets(), 3, "two assessment reads and one probe");
        // A refused write that never lands is the same.
        let (_, github, prepared, _) = lagging(None, 0);
        github.refuse_write();
        let message = error_of(publish(
            &prepared,
            &github,
            &ScriptedFeed::new(vec![]),
            &timed(&work, &clock),
        ));
        assert!(message.contains("unavailable"), "{message}");
        assert_eq!(github.sets.borrow().len(), 1);
        assert_eq!(github.head_bytes(), None);
        assert!(clock.waits.borrow().is_empty());
    }
}
