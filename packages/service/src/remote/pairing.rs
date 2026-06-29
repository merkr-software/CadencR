//! Short-lived, single-use pairing codes. The QR/URL embeds a code (never a
//! device token); a new device exchanges it at `/api/remote/pair` for a durable
//! device token. Codes live only in memory — a restart invalidates pending
//! ones, which is acceptable (re-show the QR).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use rand::TryRng;
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use utoipa::ToSchema;

const CODE_TTL: Duration = Duration::from_secs(120);
const CODE_BYTES: usize = 24;

/// Lifecycle of the most-recently-minted pairing code, surfaced to the host UI
/// so it can retire the QR the *moment* the code is actually used — rather than
/// inferring consumption from a device-count change, which was unreliable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PairingState {
    /// Nothing minted yet (or the listener just (re)started — codes live only in
    /// memory).
    None,
    /// A code is live and waiting to be scanned.
    Pending,
    /// The live code was exchanged for a device token; it is now dead.
    Consumed,
    /// The code's TTL elapsed before any device paired with it.
    Expired,
}

/// The single live (or last) pairing code. Only one is ever tracked: minting a
/// new one replaces the prior slot (the host UI shows a single QR, and "New
/// code" should make the old link stop working). We store the `sha256(code)`
/// hash — not the raw code — so a memory dump doesn't reveal a valid code.
struct CodeSlot {
    /// `Some` while the code can still be consumed; cleared on consume/expiry so
    /// a second attempt can't match.
    hash: Option<String>,
    expiry: Instant,
    consumed: bool,
}

/// In-memory tracker for the current pairing code and its lifecycle state.
#[derive(Default)]
pub struct PairingCodes {
    slot: Mutex<Option<CodeSlot>>,
}

pub struct MintedCode {
    pub code: String,
    pub expires_in_secs: u64,
}

impl PairingCodes {
    /// Mint a fresh single-use code valid for [`CODE_TTL`]. Only one code is ever
    /// active: minting a new one invalidates any prior code (the host UI shows a
    /// single QR, and "New code" should make the old link stop working — a
    /// smaller window and a less surprising model than several live at once).
    pub fn mint(&self) -> MintedCode {
        let code = random_code();
        let mut slot = self.slot.lock().unwrap();
        *slot = Some(CodeSlot {
            hash: Some(hash_code(&code)),
            expiry: Instant::now() + CODE_TTL,
            consumed: false,
        });
        MintedCode {
            code,
            expires_in_secs: CODE_TTL.as_secs(),
        }
    }

    /// Validate and consume a code. Returns true exactly once per minted code,
    /// and only before it expires. On success the slot is marked `Consumed` so
    /// [`state`](Self::state) can report it, and the hash is cleared so a second
    /// attempt fails.
    pub fn consume(&self, code: &str) -> bool {
        let presented = hash_code(code);
        let mut slot = self.slot.lock().unwrap();
        let Some(entry) = slot.as_mut() else {
            return false;
        };
        if entry.consumed || entry.expiry <= Instant::now() {
            return false;
        }
        let Some(stored) = entry.hash.as_ref() else {
            return false;
        };
        if !bool::from(stored.as_bytes().ct_eq(presented.as_bytes())) {
            return false;
        }
        entry.hash = None;
        entry.consumed = true;
        true
    }

    /// Lifecycle state of the current code, for the host status payload.
    pub fn state(&self) -> PairingState {
        let slot = self.slot.lock().unwrap();
        match slot.as_ref() {
            None => PairingState::None,
            Some(entry) if entry.consumed => PairingState::Consumed,
            Some(entry) if entry.expiry <= Instant::now() => PairingState::Expired,
            Some(_) => PairingState::Pending,
        }
    }
}

fn random_code() -> String {
    let mut bytes = [0u8; CODE_BYTES];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS random source should be available");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_code(code: &str) -> String {
    let digest = Sha256::digest(code.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_single_use() {
        let codes = PairingCodes::default();
        let minted = codes.mint();
        assert!(codes.consume(&minted.code), "first use succeeds");
        assert!(!codes.consume(&minted.code), "second use fails");
    }

    #[test]
    fn unknown_code_is_rejected() {
        let codes = PairingCodes::default();
        codes.mint();
        assert!(!codes.consume("not-a-real-code"));
    }

    #[test]
    fn minting_invalidates_the_previous_code() {
        let codes = PairingCodes::default();
        let first = codes.mint();
        let second = codes.mint();
        assert!(!codes.consume(&first.code), "old code is no longer valid");
        assert!(codes.consume(&second.code), "newest code still works");
    }

    #[test]
    fn state_transitions_pending_to_consumed() {
        let codes = PairingCodes::default();
        assert_eq!(codes.state(), PairingState::None, "nothing minted yet");
        let minted = codes.mint();
        assert_eq!(codes.state(), PairingState::Pending, "live code is pending");
        assert!(codes.consume(&minted.code));
        assert_eq!(
            codes.state(),
            PairingState::Consumed,
            "consumed code reports consumed"
        );
        // Minting again resets the state for the next QR.
        codes.mint();
        assert_eq!(codes.state(), PairingState::Pending);
    }

    #[test]
    fn state_reports_expired_after_ttl() {
        let codes = PairingCodes::default();
        codes.mint();
        // Force the slot's expiry into the past without waiting out the TTL.
        {
            let mut slot = codes.slot.lock().unwrap();
            slot.as_mut().unwrap().expiry = Instant::now() - Duration::from_secs(1);
        }
        assert_eq!(codes.state(), PairingState::Expired);
    }
}
