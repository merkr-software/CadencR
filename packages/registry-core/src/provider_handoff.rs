//! Append-only, signed provider retirement and namespace reassignment.
//! Retired entries stay in `packages` verbatim; only discovery/install views omit them.
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{canonical_json_bytes, RegistryError};
pub(crate) mod contribution;
pub use contribution::read_file as read_provider_handoffs;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderOwner {
    pub publisher: String,
    pub repository: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderHandoff {
    pub provider_id: String,
    pub from: ProviderOwner,
    pub to: ProviderOwner,
    /// Exact schema-2 catalog entry canonical SHA-256, keyed by retired version.
    pub retired_versions: BTreeMap<String, String>,
    pub authorization: String,
    pub reason: String,
}

fn bad(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
}

pub(crate) fn records(payload: &Value) -> Result<Vec<ProviderHandoff>, RegistryError> {
    match payload.get("provider_handoffs") {
        None => Ok(Vec::new()),
        Some(value) => {
            let records: Vec<ProviderHandoff> = serde_json::from_value(value.clone())
                .map_err(|e| bad(format!("invalid provider_handoffs: {e}")))?;
            validate_records(&records)?;
            if records.is_empty() {
                return Err(bad("empty provider_handoffs must be omitted"));
            }
            if payload["schema_version"] != 2 {
                return Err(bad("provider handoffs require schema 2"));
            }
            Ok(records)
        }
    }
}

pub(crate) fn validate_records(records: &[ProviderHandoff]) -> Result<(), RegistryError> {
    if records.len() > 100 {
        return Err(bad("at most 100 provider handoffs are supported"));
    }
    let mut ids = HashSet::new();
    for record in records {
        if cadencr_plugin_core::validate_provider_id(&record.provider_id).is_err()
            || !ids.insert(&record.provider_id)
        {
            return Err(bad("provider handoff identity must be valid and unique"));
        }
        if record.from == record.to
            || record.retired_versions.is_empty()
            || record.retired_versions.len() > 1000
            || record.reason.trim().is_empty()
            || record.reason.len() > 4096
        {
            return Err(bad(
                "handoff requires distinct owners, retired versions and a reason",
            ));
        }
        for owner in [&record.from, &record.to] {
            if owner.publisher.trim().is_empty()
                || owner.publisher.len() > 128
                || !crate::submission::canonical_github_repository(&owner.repository)
            {
                return Err(bad("invalid provider handoff owner"));
            }
        }
        if let Some(error) = crate::reserved_publisher::reserved_publisher_error(
            "handoff.to.publisher",
            Some(&record.to.publisher),
            Some(&record.to.repository),
        ) {
            return Err(bad(error));
        }
        let authority = url::Url::parse(&record.authorization)
            .map_err(|_| bad("invalid provider handoff authorization URL"))?;
        if authority.scheme() != "https"
            || authority.host_str() != Some("github.com")
            || authority.username() != ""
            || authority.password().is_some()
            || authority.query().is_some()
            || !authorization_permalink(&authority)
        {
            return Err(bad(
                "handoff requires a GitHub review authorization permalink",
            ));
        }
        for (version, digest) in &record.retired_versions {
            semver::Version::parse(version).map_err(|_| bad("invalid retired version"))?;
            if !crate::digest::is_lower_sha256(digest) {
                return Err(bad("invalid retired package SHA-256"));
            }
        }
    }
    Ok(())
}

impl ProviderHandoff {
    pub fn retires(&self, package: &Value) -> bool {
        crate::marketplace::kind(package) == "provider"
            && crate::package::identity(package).is_some_and(|(id, version)| {
                id == self.provider_id && self.retired_versions.contains_key(version)
            })
    }

    fn matches_owner(&self, package: &Value, owner: &ProviderOwner) -> bool {
        crate::marketplace::body(package)
            .pointer("/host/publisher")
            .and_then(Value::as_str)
            == Some(owner.publisher.as_str())
            && crate::marketplace::descriptor(package)
                .get("repository")
                .and_then(Value::as_str)
                == Some(owner.repository.as_str())
    }

    pub(crate) fn check_package(
        &self,
        package: &Value,
        check_digest: bool,
    ) -> Result<(), RegistryError> {
        let Some((id, version)) = crate::package::identity(package) else {
            return Ok(());
        };
        if id != self.provider_id {
            return Ok(());
        }
        if crate::marketplace::kind(package) != "provider" {
            return Err(bad(
                "a provider handoff cannot change package kind or transfer a plugin member",
            ));
        }
        if let Some(digest) = self.retired_versions.get(version) {
            if !self.matches_owner(package, &self.from) {
                return Err(bad("retired provider owner does not match handoff"));
            }
            if check_digest && &crate::digest::sha256_hex(&canonical_json_bytes(package)) != digest
            {
                return Err(bad(
                    "retired provider canonical package digest does not match handoff",
                ));
            }
        } else {
            let proposed =
                semver::Version::parse(version).map_err(|_| bad("invalid successor version"))?;
            if !self.matches_owner(package, &self.to)
                || self.retired_versions.keys().any(|old| {
                    proposed
                        .cmp_precedence(&semver::Version::parse(old).expect("validated version"))
                        .is_le()
                })
            {
                return Err(bad("handoff successor must use the authorized owner and a version above all retired versions"));
            }
        }
        Ok(())
    }
}

/// Return retired status only after authenticating and validating the full payload.
pub fn provider_package_is_retired(
    payload: &Value,
    package: &Value,
) -> Result<bool, RegistryError> {
    Ok(records(payload)?
        .iter()
        .any(|record| record.retires(package)))
}

pub(crate) mod catalog;
pub(crate) use catalog::{active_packages, continuity};

fn authorization_permalink(url: &url::Url) -> bool {
    let parts: Vec<_> = url.path().split('/').collect();
    let fragment = url.fragment().unwrap_or("");
    let review = ["issuecomment-", "pullrequestreview-", "discussion_r"]
        .iter()
        .any(|prefix| {
            fragment
                .strip_prefix(prefix)
                .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        });
    parts.len() == 5
        && !parts[1].is_empty()
        && !parts[2].is_empty()
        && parts[3] == "pull"
        && parts[4].parse::<u64>().is_ok_and(|n| n > 0)
        && url.port().is_none()
        && review
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_uses_provider_and_author_contracts_and_requires_a_review_permalink() {
        let record: ProviderHandoff = serde_json::from_value(serde_json::json!({
            "provider_id":"foo--bar", "from":{"publisher":"old","repository":"https://github.com/old/pi.provider"},
            "to":{"publisher":"new","repository":"https://github.com/new/pi.provider"},
            "retired_versions":{"1.0.0":"a".repeat(64)},
            "authorization":"https://github.com/owner/registry/pull/22#issuecomment-123", "reason":"Retire and transfer"
        })).unwrap();
        validate_records(std::slice::from_ref(&record)).unwrap();
        for url in [
            "https://github.com/#x",
            "https://github.com/o/r/pull/0#issuecomment-1",
            "https://github.com/o/r/issues/22#issuecomment-1",
            "https://github.com/o/r/pull/22#arbitrary",
        ] {
            let mut invalid = record.clone();
            invalid.authorization = url.into();
            assert!(validate_records(&[invalid]).is_err(), "{url}");
        }
    }
}
