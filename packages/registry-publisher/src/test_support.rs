//! Doubles shared by the publisher's unit tests.
use std::cell::{Cell, RefCell};

use sha2::{Digest as _, Sha256};

use crate::download::{DiscoveryObservation, DiscoveryReader};
use crate::{DownloadRequest, Downloaded, PublisherError};

// Deterministic synthetic fixture key pair; never a release credential.
pub(crate) const PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n";
pub(crate) const PUBLIC: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n";

/// Public raw reads served from a script; the last body repeats. Bodies pass
/// the same typed classifier as raw HTTP.
pub(crate) struct ScriptedFeed {
    pub(crate) bodies: Vec<Vec<u8>>,
    pub(crate) calls: Cell<usize>,
}

impl ScriptedFeed {
    pub(crate) fn new(bodies: Vec<Vec<u8>>) -> Self {
        Self {
            bodies,
            calls: Cell::new(0),
        }
    }
}

impl DiscoveryReader for ScriptedFeed {
    fn observe(
        &self,
        request: DownloadRequest<'_>,
        previous: Option<&str>,
        _remaining: std::time::Duration,
    ) -> Result<DiscoveryObservation, PublisherError> {
        let call = self.calls.get();
        self.calls.set(call + 1);
        let bytes = &self.bodies[call.min(self.bodies.len() - 1)];
        std::fs::write(&request.output, bytes).unwrap();
        crate::download::discovery::classify(
            Downloaded {
                sha256: crate::hex(&Sha256::digest(bytes)),
                size: bytes.len() as u64,
            },
            Some(bytes.len() as u64),
            request.sha256,
            previous,
        )
    }
}

/// Replication lag for a test double: after a write lands, the next `reads`
/// reads still see the state from before it.
pub(crate) struct ReadLag<T> {
    reads: Cell<u64>,
    before: RefCell<Option<T>>,
    left: Cell<u64>,
}

impl<T> Default for ReadLag<T> {
    fn default() -> Self {
        Self {
            reads: Cell::new(0),
            before: RefCell::new(None),
            left: Cell::new(0),
        }
    }
}

impl<T: Clone> ReadLag<T> {
    /// Lag the next writes by `reads` reads.
    pub(crate) fn set(&self, reads: u64) {
        self.reads.set(reads);
    }

    /// A write is landing: `before` is the state it replaces.
    pub(crate) fn landed(&self, before: T) {
        *self.before.borrow_mut() = Some(before);
        self.left.set(self.reads.get());
    }

    /// The stale state while lag remains, consuming one read.
    pub(crate) fn serve(&self) -> Option<T> {
        if self.left.get() == 0 {
            return None;
        }
        self.left.set(self.left.get() - 1);
        self.before.borrow().clone()
    }
}
