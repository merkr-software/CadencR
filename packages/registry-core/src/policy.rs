//! The three signed revocation policies (provider, theme, custom tab) as one
//! family: the file each lives in on the discovery branch, its domain rules,
//! and authentication of signed bytes read from anywhere.
use chrono::{DateTime, Utc};
use serde_json::Value;

use ed25519_dalek::VerifyingKey;

use crate::blocklist::{prepare_blocklist, timestamp, MAX_BLOCKLIST_BYTES, SIGNED_OVERHEAD_BYTES};
use crate::provider_blocklist::prepare_provider_blocklist;
use crate::signing::{parse_public_key, reject_unknown, validate_signature};
use crate::{
    canonical_json_bytes, parse_json_bytes, validate_signing_key_id, LspBlocklistEntry,
    PreparedSigningPayload, RegistryError, TabBlocklistEntry, ThemeBlocklistEntry,
};

/// Which revocation policy a document is. Domains never mix: each kind
/// accepts only its own document shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyKind {
    Provider,
    Theme,
    Tab,
    Lsp,
}

impl PolicyKind {
    /// `provider`, `theme` or `tab`.
    pub fn name(self) -> &'static str {
        match self {
            PolicyKind::Provider => "provider",
            PolicyKind::Theme => "theme",
            PolicyKind::Tab => "tab",
            PolicyKind::Lsp => "lsp",
        }
    }

    /// The one fixed path of this policy on the discovery branch.
    pub fn file_name(self) -> &'static str {
        match self {
            PolicyKind::Provider => "managed-blocklist.json",
            PolicyKind::Theme => "managed-theme-blocklist.json",
            PolicyKind::Tab => "managed-tab-blocklist.json",
            PolicyKind::Lsp => "managed-lsp-blocklist.json",
        }
    }

    /// Largest signed envelope of this policy that may be written, and so the
    /// largest the registry will read. The desktop service refuses to download
    /// a managed-provider policy of more than [`MAX_BLOCKLIST_BYTES`] in total,
    /// so a provider policy must fit that budget with its signature; the
    /// other feeds budget their payload and the envelope overhead separately.
    pub fn max_signed_bytes(self) -> usize {
        match self {
            PolicyKind::Provider => MAX_BLOCKLIST_BYTES,
            PolicyKind::Theme | PolicyKind::Tab | PolicyKind::Lsp => {
                MAX_BLOCKLIST_BYTES + SIGNED_OVERHEAD_BYTES
            }
        }
    }

    /// Validate `value` as this kind's feed; the canonical bytes are
    /// retained, never a typed projection.
    pub(crate) fn prepare(
        self,
        value: &Value,
        allow_expired: bool,
        now: DateTime<Utc>,
    ) -> Result<PreparedSigningPayload, RegistryError> {
        match self {
            PolicyKind::Provider => prepare_provider_blocklist(value, allow_expired, now),
            PolicyKind::Theme => {
                prepare_blocklist::<ThemeBlocklistEntry>(value, allow_expired, now)
                    .map(|prepared| prepared.signing)
            }
            PolicyKind::Lsp => prepare_blocklist::<LspBlocklistEntry>(value, allow_expired, now)
                .map(|prepared| prepared.signing),
            PolicyKind::Tab => prepare_blocklist::<TabBlocklistEntry>(value, allow_expired, now)
                .map(|prepared| prepared.signing),
        }
    }
}

/// A signed policy whose signature, key id and domain have been verified.
#[derive(Debug, Clone)]
pub struct AuthenticatedPolicy {
    kind: PolicyKind,
    signed: Value,
    generated_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

impl AuthenticatedPolicy {
    pub fn kind(&self) -> PolicyKind {
        self.kind
    }
    /// The authenticated `signed` payload.
    pub fn signed(&self) -> &Value {
        &self.signed
    }
    pub fn generated_at(&self) -> DateTime<Utc> {
        self.generated_at
    }
    pub fn expires_at(&self) -> DateTime<Utc> {
        self.expires_at
    }
    /// The canonical bytes the signature covers.
    pub fn canonical_payload(&self) -> Vec<u8> {
        canonical_json_bytes(&self.signed)
    }
}

/// Authenticate signed `bytes` as `kind`'s policy against a pinned public key
/// (PEM) and signing key id. An expired policy is accepted only with
/// `allow_expired`, and only if it is still correctly signed: expiry never
/// replaces authentication.
pub fn authenticate_policy(
    kind: PolicyKind,
    bytes: &[u8],
    public_key_pem: &[u8],
    key_id: &str,
    allow_expired: bool,
    now: DateTime<Utc>,
) -> Result<AuthenticatedPolicy, RegistryError> {
    let label = format!("{} blocklist", kind.name());
    if bytes.len() > kind.max_signed_bytes() {
        return Err(RegistryError::single(format!(
            "signed {label} exceeds its size limit"
        )));
    }
    let envelope = parse_json_bytes(bytes)
        .map_err(|_| RegistryError::single(format!("signed {label} must be valid JSON")))?;
    let key = parse_public_key(public_key_pem)?;
    let signed = verify_policy_envelope(&envelope, &key, key_id, &label)?;
    let prepared = kind.prepare(&signed, allow_expired, now)?;
    let (generated_at, expires_at) = prepared.window();
    Ok(AuthenticatedPolicy {
        kind,
        generated_at: timestamp(generated_at, &label)?,
        expires_at: timestamp(expires_at, &label)?,
        signed,
    })
}

/// The `signed` payload of a `{signed, signature}` policy envelope, once its
/// signature verifies under the pinned `key` and `key_id`; the caller
/// validates its domain.
fn verify_policy_envelope(
    envelope: &Value,
    key: &VerifyingKey,
    key_id: &str,
    label: &str,
) -> Result<Value, RegistryError> {
    validate_signing_key_id(key_id)?;
    let object = envelope
        .as_object()
        .ok_or_else(|| RegistryError::single(format!("{label} envelope must be an object")))?;
    reject_unknown(object, &["signed", "signature"], "envelope")?;
    let signed = object
        .get("signed")
        .ok_or_else(|| RegistryError::single("envelope.signed is required"))?;
    let signature = object.get("signature").and_then(Value::as_object);
    let decoded = validate_signature(signature)?;
    if signature
        .and_then(|value| value.get("key_id"))
        .and_then(Value::as_str)
        != Some(key_id)
    {
        return Err(RegistryError::single(
            "envelope signing key id does not match",
        ));
    }
    key.verify_strict(&canonical_json_bytes(signed), &decoded)
        .map_err(|_| RegistryError::single("envelope signature verification failed"))?;
    Ok(signed.clone())
}
