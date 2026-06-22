//! Web Push (RFC 8030/8291) for PWA / remote devices.
//!
//! Background notifications when an agent finishes or needs input, delivered to
//! an installed PWA even when its tab is backgrounded, locked, or closed (the
//! live WebSocket — and the in-app toast / Electron-native path — only cover a
//! foregrounded client). The dispatcher ([`dispatcher`]) listens on the same
//! session-status broadcast the WebSocket consumes and pushes ONLY to remote
//! devices that don't currently hold a live socket, so a foregrounded tab is
//! never double-notified.
//!
//! VAPID keypair: the private key is held server-side under the remote data dir
//! (`vapid.json`, `0600`), generated on first use. The public key is handed to
//! the browser as the `applicationServerKey` for `pushManager.subscribe`.
//! Rotating = delete `vapid.json`; existing subscriptions then fail to verify
//! and the client resubscribes against the new key (the frontend compares the
//! served key to the one its subscription was made with).

pub mod dispatcher;
pub mod models;
pub mod repo;
pub mod routes;

use std::path::Path;

use base64::Engine;
use jwt_simple::algorithms::ES256KeyPair;
use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

use repo::PushSubscriptionRecord;

const VAPID_FILE: &str = "vapid.json";
/// VAPID `sub` claim (RFC 8292): a contact URI the push service may use to reach
/// the operator about abuse. The server is localhost-held, so a stable mailto is
/// sufficient — it is never an authentication credential.
const VAPID_SUBJECT: &str = "mailto:push@cadencr.app";
/// How long a push service should retain an undelivered message. An hour is
/// ample for an "agent finished / needs input" ping; a staler one is pointless.
const PUSH_TTL_SECS: u32 = 3600;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

#[derive(serde::Serialize, serde::Deserialize)]
struct VapidFile {
    /// Raw P-256 private scalar, base64url (no padding) — the form
    /// `VapidSignatureBuilder::from_base64` consumes.
    private_key: String,
}

/// Holds the VAPID keypair and a shared Web Push HTTP client. Stored as
/// `Arc<PushNotifier>` on `AppState`; cloning the client is cheap (shared
/// connection pool), so handlers and the dispatcher share one instance.
pub struct PushNotifier {
    private_key_b64: String,
    /// Uncompressed P-256 public point, base64url — the browser's
    /// `applicationServerKey`.
    public_key_b64: String,
    client: HyperWebPushClient,
}

impl PushNotifier {
    /// Load the VAPID private key from `<dir>/vapid.json`, generating one on
    /// first run (written `0600`). Never fatal to the caller: callers fall back
    /// to [`Self::ephemeral`] on error so the service still boots.
    pub fn load_or_generate(dir: &Path) -> anyhow::Result<Self> {
        let path = dir.join(VAPID_FILE);
        let private_key_b64 = match std::fs::read_to_string(&path) {
            Ok(contents) => {
                let parsed: VapidFile = serde_json::from_str(&contents)?;
                crate::remote::secure_fs::ensure_owner_only(&path)?;
                parsed.private_key
            }
            Err(_) => {
                let encoded = generate_private_key_b64();
                std::fs::create_dir_all(dir)?;
                let body = serde_json::to_vec(&VapidFile {
                    private_key: encoded.clone(),
                })?;
                crate::remote::secure_fs::write_secret(&path, &body)?;
                encoded
            }
        };
        let public_key_b64 = derive_public_key_b64(&private_key_b64)?;
        Ok(Self {
            private_key_b64,
            public_key_b64,
            client: HyperWebPushClient::new(),
        })
    }

    /// In-memory keypair with no disk persistence — for tests and as the
    /// non-fatal fallback when key load/generate fails.
    pub fn ephemeral() -> Self {
        let private_key_b64 = generate_private_key_b64();
        let public_key_b64 = derive_public_key_b64(&private_key_b64).unwrap_or_default();
        Self {
            private_key_b64,
            public_key_b64,
            client: HyperWebPushClient::new(),
        }
    }

    /// Base64url VAPID public key the frontend passes to `pushManager.subscribe`.
    pub fn public_key_b64(&self) -> &str {
        &self.public_key_b64
    }

    /// Encrypt + VAPID-sign `payload` (a JSON document the service worker reads)
    /// and POST it to the subscription's endpoint. Returns the raw
    /// [`WebPushError`] so callers can prune dead subscriptions on 404/410.
    pub async fn send(
        &self,
        sub: &PushSubscriptionRecord,
        payload: &[u8],
    ) -> Result<(), WebPushError> {
        let info = SubscriptionInfo::new(
            sub.endpoint.as_str(),
            sub.p256dh.as_str(),
            sub.auth.as_str(),
        );

        let mut sig_builder = VapidSignatureBuilder::from_base64(&self.private_key_b64, &info)?;
        sig_builder.add_claim("sub", VAPID_SUBJECT);
        let signature = sig_builder.build()?;

        let mut builder = WebPushMessageBuilder::new(&info);
        builder.set_payload(ContentEncoding::Aes128Gcm, payload);
        builder.set_vapid_signature(signature);
        builder.set_ttl(PUSH_TTL_SECS);

        self.client.send(builder.build()?).await
    }
}

/// A 404 (endpoint gone) or 410 (subscription expired) means the browser dropped
/// this subscription — the row should be deleted rather than retried.
pub fn is_gone(err: &WebPushError) -> bool {
    matches!(
        err,
        WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_)
    )
}

fn generate_private_key_b64() -> String {
    B64.encode(ES256KeyPair::generate().to_bytes())
}

fn derive_public_key_b64(private_key_b64: &str) -> anyhow::Result<String> {
    let partial = VapidSignatureBuilder::from_base64_no_sub(private_key_b64)
        .map_err(|e| anyhow::anyhow!("invalid VAPID private key: {e}"))?;
    Ok(B64.encode(partial.get_public_key()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generates_then_reloads_identical_key() {
        let dir = tempdir().unwrap();
        let first = PushNotifier::load_or_generate(dir.path()).unwrap();
        let pubkey = first.public_key_b64().to_string();
        assert!(!pubkey.is_empty());
        let second = PushNotifier::load_or_generate(dir.path()).unwrap();
        assert_eq!(
            pubkey,
            second.public_key_b64(),
            "VAPID key must persist across loads"
        );
    }

    #[test]
    fn public_key_is_uncompressed_p256_point() {
        let n = PushNotifier::ephemeral();
        let decoded = B64.decode(n.public_key_b64()).unwrap();
        // Uncompressed P-256 point: 0x04 || X(32) || Y(32).
        assert_eq!(decoded.len(), 65);
        assert_eq!(decoded[0], 0x04);
    }
}
