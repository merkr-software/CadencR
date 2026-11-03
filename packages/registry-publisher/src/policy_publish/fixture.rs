//! In-memory GitHub and public-feed doubles for policy publication tests.
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use cadencr_registry_core::PolicyKind;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha1::{Digest as _, Sha1};
use sha2::Sha256;
use tempfile::TempDir;

use super::{flow::Timing, prepare_at, PreparePolicyRequest, PreparedPolicy};
use crate::convergence::{ReadBack, VirtualClock};
use crate::github::discovery::{DiscoveryHead, PolicyClient, SetPolicyRequest};
use crate::test_support::{ReadLag, PRIVATE, PUBLIC};
use crate::PublisherError;

pub(super) use crate::test_support::ScriptedFeed;
pub(super) const KEY_ID: &str = "release-2026";
pub(super) const REPOSITORY: &str = "acme/registry";
pub(super) const BRANCH: &str = "marketplace-v2";
pub(super) const KINDS: [PolicyKind; 4] = [
    PolicyKind::Provider,
    PolicyKind::Theme,
    PolicyKind::Tab,
    PolicyKind::Lsp,
];

pub(super) fn blob_sha(bytes: &[u8]) -> String {
    let mut hash = Sha1::new();
    hash.update(format!("blob {}\0", bytes.len()));
    hash.update(bytes);
    crate::hex(&hash.finalize())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

/// Key files plus a signer for policies relative to one fixed instant, so
/// that policies signed one after another never straddle a clock tick.
pub(super) struct Workspace {
    pub(super) directory: TempDir,
    pub(super) public: PathBuf,
    private: PathBuf,
    /// Whole-second instant every policy is dated from; not in the future.
    pub(super) start: DateTime<Utc>,
}

impl Workspace {
    pub(super) fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let private = directory.path().join("private.pem");
        let public = directory.path().join("public.pem");
        std::fs::write(&private, PRIVATE).unwrap();
        std::fs::write(&public, PUBLIC).unwrap();
        Self {
            directory,
            public,
            private,
            start: whole(Utc::now()),
        }
    }

    /// A signed `kind` policy generated `generated_ago` before `start` and
    /// expiring `window` after it. `marker` varies the entries.
    pub(super) fn signed(
        &self,
        kind: PolicyKind,
        generated_ago: Duration,
        window: Duration,
        marker: &str,
    ) -> Vec<u8> {
        let generated = self.start - chrono::Duration::from_std(generated_ago).unwrap();
        let expires = generated + chrono::Duration::from_std(window).unwrap();
        let (id_field, tag) = match kind {
            PolicyKind::Provider => ("provider_id", None),
            PolicyKind::Theme => ("theme_id", Some("theme-blocklist")),
            PolicyKind::Tab => ("tab_id", Some("tab-blocklist")),
            PolicyKind::Lsp => ("lsp_id", Some("lsp-blocklist")),
        };
        let mut value = json!({
            "schema_version": 1,
            "generated_at": generated.to_rfc3339_opts(SecondsFormat::Secs, true),
            "expires_at": expires.to_rfc3339_opts(SecondsFormat::Secs, true),
            "entries": [{id_field: "alpha", "reason": marker}],
        });
        if let Some(tag) = tag {
            value["kind"] = Value::String(tag.into());
        }
        let payload = self.directory.path().join(format!("payload-{marker}.json"));
        std::fs::write(&payload, serde_json::to_vec(&value).unwrap()).unwrap();
        cadencr_registry_core::sign_policy(kind, &payload, &self.private, KEY_ID).unwrap()
    }

    pub(super) fn prepared(
        &self,
        kind: PolicyKind,
        bytes: &[u8],
        bootstrap: bool,
    ) -> Result<PreparedPolicy, PublisherError> {
        self.prepared_at(kind, bytes, bootstrap, false, self.start)
    }

    /// A renewal candidate: it may only re-sign the entries on the branch.
    pub(super) fn renewal(
        &self,
        kind: PolicyKind,
        bytes: &[u8],
    ) -> Result<PreparedPolicy, PublisherError> {
        self.prepared_at(kind, bytes, false, true, self.start)
    }

    /// Prepared as the clock reads `now`.
    pub(super) fn prepared_at(
        &self,
        kind: PolicyKind,
        bytes: &[u8],
        bootstrap: bool,
        renewal: bool,
        now: DateTime<Utc>,
    ) -> Result<PreparedPolicy, PublisherError> {
        let signed = self.directory.path().join("candidate.json");
        std::fs::write(&signed, bytes).unwrap();
        prepare_at(
            PreparePolicyRequest::builder()
                .kind(kind)
                .signed(&signed)
                .repository(REPOSITORY)
                .discovery_branch(BRANCH)
                .public_key(&self.public)
                .key_id(KEY_ID)
                .bootstrap(bootstrap)
                .renewal(renewal)
                .build(),
            now,
        )
    }
}

fn whole(time: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp(time.timestamp(), 0).unwrap()
}

/// Pacing for a clock that reads `now` throughout; read-back waits cost no
/// time.
pub(super) fn timing_at(now: DateTime<Utc>) -> Timing {
    let clock = VirtualClock::new();
    timing_with(now, clock.read_back(), clock.public_read_back())
}

pub(super) fn timing_with(
    now: DateTime<Utc>,
    read_back: ReadBack,
    public_read: ReadBack,
) -> Timing {
    Timing::builder()
        .now(move || now)
        .read_back(read_back)
        .public_read(public_read)
        .build()
}

pub(super) fn timing(work: &Workspace) -> Timing {
    timing_at(work.start)
}

/// One recorded conditional update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SetCall {
    pub(super) file: String,
    pub(super) message: String,
    pub(super) bytes: Vec<u8>,
    pub(super) expected_sha: Option<String>,
}

#[derive(Default)]
pub(super) struct MockGitHub {
    head: RefCell<Option<DiscoveryHead>>,
    pub(super) sets: RefCell<Vec<SetCall>>,
    gets: Cell<usize>,
    /// The write lands but its response is lost.
    lost_response: Cell<bool>,
    /// Another writer lands these bytes right before our write.
    racing_writer: RefCell<Option<Vec<u8>>>,
    /// Another writer lands these bytes when the nth read begins.
    drift: RefCell<Option<(usize, Vec<u8>)>>,
    /// Reads served the pre-write head after a write lands (API lag).
    lag: ReadLag<Option<DiscoveryHead>>,
    /// The write is refused and never lands.
    refuse_write: Cell<bool>,
}

impl MockGitHub {
    pub(super) fn with_head(bytes: Option<&[u8]>) -> Self {
        let mock = Self::default();
        mock.put(bytes);
        mock
    }
    fn put(&self, bytes: Option<&[u8]>) {
        *self.head.borrow_mut() = bytes.map(|bytes| DiscoveryHead {
            sha: blob_sha(bytes),
            bytes: bytes.to_vec(),
        });
    }
    pub(super) fn head_bytes(&self) -> Option<Vec<u8>> {
        self.head.borrow().as_ref().map(|head| head.bytes.clone())
    }
    pub(super) fn lose_response(&self) {
        self.lost_response.set(true);
    }
    /// After the write lands, the next `reads` reads still see the old head.
    pub(super) fn lag_reads(&self, reads: u64) {
        self.lag.set(reads);
    }
    pub(super) fn refuse_write(&self) {
        self.refuse_write.set(true);
    }
    pub(super) fn gets(&self) -> usize {
        self.gets.get()
    }
    pub(super) fn race_with(&self, bytes: &[u8]) {
        *self.racing_writer.borrow_mut() = Some(bytes.to_vec());
    }
    pub(super) fn foreign_head_at_get(&self, nth: usize, bytes: &[u8]) {
        *self.drift.borrow_mut() = Some((nth, bytes.to_vec()));
    }
}

impl PolicyClient for MockGitHub {
    fn get_policy_before(
        &self,
        branch: &str,
        file: &str,
        _deadline: Option<Instant>,
    ) -> Result<Option<DiscoveryHead>, PublisherError> {
        assert_eq!(branch, BRANCH);
        assert!(file.starts_with("managed-") && file.ends_with("blocklist.json"));
        self.gets.set(self.gets.get() + 1);
        let drift = self.drift.borrow().clone();
        if let Some((nth, bytes)) = drift {
            if nth == self.gets.get() {
                self.put(Some(&bytes));
            }
        }
        if let Some(stale) = self.lag.serve() {
            return Ok(stale);
        }
        Ok(self.head.borrow().clone())
    }

    fn set_policy(&self, request: SetPolicyRequest<'_>) -> Result<(), PublisherError> {
        assert_eq!(request.branch, BRANCH);
        self.sets.borrow_mut().push(SetCall {
            file: request.file.into(),
            message: request.message.into(),
            bytes: request.bytes.to_vec(),
            expected_sha: request.expected_sha.map(Into::into),
        });
        let racing = self.racing_writer.borrow_mut().take();
        if let Some(bytes) = racing {
            self.put(Some(&bytes));
        }
        // GitHub's compare-and-swap: the expected blob must still be current.
        let current = self.head.borrow().as_ref().map(|head| head.sha.clone());
        if current.as_deref() != request.expected_sha {
            return Err(PublisherError::new("GitHub request failed: conflict"));
        }
        if self.refuse_write.get() {
            return Err(PublisherError::new("GitHub request failed: unavailable"));
        }
        self.lag.landed(self.head.borrow().clone());
        self.put(Some(request.bytes));
        if self.lost_response.get() {
            return Err(PublisherError::new("GitHub request failed: timeout"));
        }
        Ok(())
    }
}
