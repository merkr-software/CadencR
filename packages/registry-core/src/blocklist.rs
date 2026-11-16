//! What every signed revocation feed (`theme-blocklist`, `tab-blocklist`)
//! shares: the document shape, its bounded publication window and the rules
//! each entry obeys. A feed differs only in its entries ([`BlocklistEntry`]).
use chrono::{DateTime, SecondsFormat, Utc};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

use crate::digest::is_lower_sha256;
use crate::{canonical_json_bytes, PreparedSigningPayload, RegistryError};

/// Canonical signed payload budget of every feed; envelope overhead is
/// separate.
pub(crate) const MAX_BLOCKLIST_BYTES: usize = 1024 * 1024;
/// Envelope overhead a signed feed may add to its payload.
pub(crate) const SIGNED_OVERHEAD_BYTES: usize = 1024;
pub(crate) const MAX_ENTRIES: usize = 4096;
const MAX_WINDOW_DAYS: i64 = 14;

/// A validated revocation feed. Only [`prepare_blocklist`] builds one: it
/// also parses each entry's version requirement once.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Blocklist<E> {
    pub schema_version: u32,
    pub kind: String,
    pub generated_at: String,
    pub expires_at: String,
    pub entries: Vec<E>,
    /// `entries[i].version_requirement`, parsed.
    #[serde(skip)]
    requirements: Vec<Option<semver::VersionReq>>,
}

/// A feed and the canonical bytes it was validated from.
pub struct PreparedBlocklist<E> {
    pub signing: PreparedSigningPayload,
    pub policy: Blocklist<E>,
}

/// One feed's entry type. Nominally `pub` so it may bound [`Blocklist`]'s
/// impl; the module is private, so no other crate can implement or name it.
pub trait BlocklistEntry: DeserializeOwned {
    /// `theme`: the feed's kind is `theme-blocklist`, its errors say
    /// "theme blocklist".
    const SUBJECT: &'static str;
    /// The schema/kind refusal.
    const UNSUPPORTED: &'static str;
    /// The refusal of a digest that is not lowercase SHA-256.
    const INVALID_DIGEST: &'static str;
    fn valid_id(&self) -> bool;
    fn version_requirement(&self) -> Option<&str>;
    fn digests(&self) -> Vec<&str>;
    fn reason(&self) -> &str;
    /// Entries are unique and sorted by this.
    fn identity(&self) -> Vec<&str>;
}

/// Validate `value` as `E`'s feed and retain its canonical bytes, never a
/// typed projection.
pub(crate) fn prepare_blocklist<E: BlocklistEntry>(
    value: &Value,
    allow_expired: bool,
    now: DateTime<Utc>,
) -> Result<PreparedBlocklist<E>, RegistryError> {
    let label = format!("{} blocklist", E::SUBJECT);
    let canonical = canonical_json_bytes(value);
    if canonical.len() > MAX_BLOCKLIST_BYTES {
        return Err(invalid(format!("{label} exceeds 1 MiB")));
    }
    let mut policy: Blocklist<E> = serde_json::from_value(value.clone())
        .map_err(|error| invalid(format!("invalid {label}: {error}")))?;
    if policy.schema_version != 1
        || policy.kind != format!("{}-blocklist", E::SUBJECT)
        || policy.entries.len() > MAX_ENTRIES
    {
        return Err(invalid(E::UNSUPPORTED));
    }
    validate_window(
        &policy.generated_at,
        &policy.expires_at,
        allow_expired,
        now,
        &label,
    )?;
    let requirements = validate_entries(&policy.entries, &label)?;
    policy.requirements = requirements;
    let signing = PreparedSigningPayload {
        canonical,
        generated_at: policy.generated_at.clone(),
        expires_at: policy.expires_at.clone(),
    };
    Ok(PreparedBlocklist { signing, policy })
}

/// Every entry's parsed version requirement once all fields are valid and
/// the entries are unique and sorted by identity.
pub(crate) fn validate_entries<E: BlocklistEntry>(
    entries: &[E],
    label: &str,
) -> Result<Vec<Option<semver::VersionReq>>, RegistryError> {
    let mut previous: Option<Vec<&str>> = None;
    let mut requirements = Vec::with_capacity(entries.len());
    for entry in entries {
        requirements.push(validate_entry(entry)?);
        let identity = entry.identity();
        if previous.as_ref().is_some_and(|prior| *prior >= identity) {
            return Err(invalid(format!(
                "{label} entries must be unique and sorted by identity"
            )));
        }
        previous = Some(identity);
    }
    Ok(requirements)
}

/// The entry's parsed version requirement, once its fields are valid.
fn validate_entry<E: BlocklistEntry>(
    entry: &E,
) -> Result<Option<semver::VersionReq>, RegistryError> {
    if !entry.valid_id() {
        return Err(invalid(format!("invalid revocation {}_id", E::SUBJECT)));
    }
    let requirement = entry
        .version_requirement()
        .map(semver::VersionReq::parse)
        .transpose()
        .map_err(|_| invalid("invalid revocation version requirement"))?;
    if !entry.digests().into_iter().all(is_lower_sha256) {
        return Err(invalid(E::INVALID_DIGEST));
    }
    if !valid_reason(entry.reason()) {
        return Err(invalid("revocation reason must be bounded visible text"));
    }
    Ok(requirement)
}

impl<E: BlocklistEntry> Blocklist<E> {
    /// The entries whose version requirement admits `version` (all of them
    /// when they set none), or `Err` when `version` is not semver.
    pub(crate) fn admitting(
        &self,
        version: &str,
    ) -> Result<impl Iterator<Item = &E>, RegistryError> {
        let version = semver::Version::parse(version)
            .map_err(|_| invalid(format!("{} version is invalid", E::SUBJECT)))?;
        Ok(self
            .entries
            .iter()
            .zip(&self.requirements)
            .filter(move |(_, requirement)| {
                requirement
                    .as_ref()
                    .is_none_or(|requirement| requirement.matches(&version))
            })
            .map(|(entry, _)| entry))
    }
}

/// A canonical UTC whole-second publication window of at most 14 days that
/// is not future-dated (nor expired, unless `allow_expired`). Shared by every
/// blocklist feed; `label` names it in errors.
pub(crate) fn validate_window(
    generated_at: &str,
    expires_at: &str,
    allow_expired: bool,
    now: DateTime<Utc>,
    label: &str,
) -> Result<(), RegistryError> {
    let generated_at = timestamp(generated_at, label)?;
    let expires_at = timestamp(expires_at, label)?;
    if generated_at > now
        || expires_at <= generated_at
        || expires_at - generated_at > chrono::Duration::days(MAX_WINDOW_DAYS)
        || (!allow_expired && expires_at <= now)
    {
        return Err(invalid(format!(
            "{label} window is invalid, future-dated, or expired"
        )));
    }
    Ok(())
}

pub(crate) fn timestamp(value: &str, label: &str) -> Result<DateTime<Utc>, RegistryError> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| invalid(format!("{label} timestamp is invalid")))?
        .with_timezone(&Utc);
    if value.len() != 20 || parsed.to_rfc3339_opts(SecondsFormat::Secs, true) != value {
        return Err(invalid(format!(
            "{label} timestamps require canonical UTC whole seconds"
        )));
    }
    Ok(parsed)
}

/// Bounded visible text: what the user is shown for a revocation.
pub(crate) fn valid_reason(reason: &str) -> bool {
    !reason.trim().is_empty() && reason.len() <= 1024 && !reason.chars().any(char::is_control)
}

fn invalid(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validity_window_is_bounded_at_fourteen_days_including_expired_history() {
        let now = DateTime::parse_from_rfc3339("2026-10-11T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let generated = "2026-10-11T11:00:00Z";
        let at_limit = "2026-10-25T11:00:00Z";
        let past_limit = "2026-10-25T11:00:01Z";
        assert!(validate_window(generated, at_limit, false, now, "test").is_ok());
        assert!(validate_window(generated, past_limit, false, now, "test").is_err());
        let later = now + chrono::Duration::days(30);
        assert!(validate_window(generated, past_limit, true, later, "test").is_err());
        assert!(validate_window(generated, at_limit, true, later, "test").is_ok());
        assert!(
            validate_window("2026-10-11T11:00:00+00:00", at_limit, false, now, "test").is_err()
        );
    }
}
