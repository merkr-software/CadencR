//! Validation profiles for portable ACP Registry entries and Cadencr's local
//! host descriptor.

use std::collections::BTreeMap;

use super::{
    AcpAgentEntry, AcpBinaryTarget, AcpDistribution, HostInstallationSpec, ProviderDescriptor,
    ACP_BINARY_TARGETS, SUPPORTED_SCHEMA_VERSION,
};
use crate::domain::agents::providers::installed::rejection::{DescriptorError, RejectionCode};

/// Field names the ACP handshake owns.
///
/// A local descriptor carrying one reads as if it configured the agent, but
/// cannot: `initialize` and `session/new` are authoritative. Compared after
/// stripping case and separators, so `authMethods` and `auth_methods` are both
/// caught. Deliberately only the plural nouns the boundary rule names; guessing
/// at singulars could refuse a future registry field with unrelated meaning.
const PROTOCOL_OWNED_FIELDS: &[&str] = &[
    "accessmodes",
    "auth",
    "authmethods",
    "capabilities",
    "defaultmodel",
    "models",
    "modes",
    "permissionmodes",
    "permissions",
    "slashcommands",
    "thinkinglevels",
];

/// Validate an id before using it as a descriptor file name. This is the same
/// contract as the portable ACP Registry entry, exposed for lifecycle routes
/// so an HTTP path segment can never escape the providers directory.
pub fn validate_provider_id(id: &str) -> Result<(), DescriptorError> {
    if is_registry_id(id) {
        Ok(())
    } else {
        Err(schema_violation(format!(
            "provider id {id:?} must match the ACP registry pattern ^[a-z][a-z0-9-]*$"
        )))
    }
}

#[derive(Clone, Copy)]
enum PortableValidationProfile {
    LocalInstall,
    RegistryV1,
}

impl PortableValidationProfile {
    fn requires_distribution(self) -> bool {
        matches!(self, Self::RegistryV1)
    }
}

impl ProviderDescriptor {
    /// Validate the envelope and the portable entry it carries.
    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(DescriptorError::new(
                RejectionCode::UnsupportedSchemaVersion,
                format!(
                    "descriptor schema_version {} is not supported by this build (expected {})",
                    self.schema_version, SUPPORTED_SCHEMA_VERSION
                ),
            ));
        }
        self.agent.validate_local_install()?;
        self.installation.validate(&self.agent)
    }
}

impl HostInstallationSpec {
    fn validate(&self, agent: &AcpAgentEntry) -> Result<(), DescriptorError> {
        let Some(assets) = &self.assets else {
            return Ok(());
        };
        let directory = assets.directory.trim();
        if directory.is_empty() || !std::path::Path::new(directory).is_absolute() {
            return Err(schema_violation(
                "installation.assets.directory must be an absolute path",
            ));
        }
        if let Some(icon) = agent.icon.as_deref() {
            validate_local_asset_path("agent icon", icon)?;
        }
        Ok(())
    }
}

impl AcpAgentEntry {
    /// Validate a portable entry against the pinned ACP Registry v1 shape.
    ///
    /// Unlike a local descriptor, `distribution` is mandatory. Unknown root
    /// fields remain valid because the upstream root schema intentionally does
    /// not set `additionalProperties: false`; nested distribution records do.
    pub fn validate_registry_entry(&self) -> Result<(), DescriptorError> {
        self.validate_portable_shape(PortableValidationProfile::RegistryV1)
    }

    /// Validate the portable payload embedded in a local host descriptor.
    fn validate_local_install(&self) -> Result<(), DescriptorError> {
        if self.distribution.is_some() {
            self.validate_registry_entry()?;
        } else {
            self.validate_portable_shape(PortableValidationProfile::LocalInstall)?;
        }
        self.validate_local_policy()
    }

    fn validate_portable_shape(
        &self,
        profile: PortableValidationProfile,
    ) -> Result<(), DescriptorError> {
        validate_provider_id(&self.id)?;
        if self.name.is_empty() {
            return Err(schema_violation("agent name must not be empty"));
        }
        if self.description.is_empty() {
            return Err(schema_violation("agent description must not be empty"));
        }
        if !is_semver_prefixed(&self.version) {
            return Err(schema_violation(format!(
                "agent version {:?} must start with a semantic version (MAJOR.MINOR.PATCH)",
                self.version
            )));
        }
        validate_optional_uri("agent repository", self.repository.as_deref())?;
        validate_optional_uri("agent website", self.website.as_deref())?;
        match &self.distribution {
            Some(distribution) => distribution.validate(),
            None if profile.requires_distribution() => Err(schema_violation(
                "ACP Registry entries must declare a distribution",
            )),
            None => Ok(()),
        }
    }

    fn validate_local_policy(&self) -> Result<(), DescriptorError> {
        if self.name.trim().is_empty() {
            return Err(schema_violation("agent name must not be empty"));
        }
        if self.description.trim().is_empty() {
            return Err(schema_violation("agent description must not be empty"));
        }
        if let Some(key) = self.extra.keys().find(|key| is_protocol_owned_field(key)) {
            return Err(schema_violation(format!(
                "agent field {key:?} describes a capability the ACP handshake owns; \
                 remove it — models, modes, permissions, and auth come from \
                 initialize and session/new, never from a descriptor"
            )));
        }
        if let Some(distribution) = &self.distribution {
            distribution.validate_local_policy()?;
        }
        Ok(())
    }
}

impl AcpDistribution {
    fn validate(&self) -> Result<(), DescriptorError> {
        if self.binary.is_none() && self.npx.is_none() && self.uvx.is_none() {
            return Err(schema_violation(
                "agent distribution must declare at least one of binary, npx, or uvx",
            ));
        }
        if self.binary.as_ref().is_some_and(BTreeMap::is_empty) {
            return Err(schema_violation(
                "binary distribution must declare at least one platform target",
            ));
        }
        for (platform, target) in self.binary.iter().flatten() {
            if !ACP_BINARY_TARGETS.contains(&platform.as_str()) {
                return Err(schema_violation(format!(
                    "unknown binary distribution target {platform:?}"
                )));
            }
            target.validate(platform)?;
        }
        for (label, package) in [("npx", &self.npx), ("uvx", &self.uvx)] {
            if package
                .as_ref()
                .is_some_and(|package| package.package.is_empty())
            {
                return Err(schema_violation(format!(
                    "{label} distribution package must not be empty"
                )));
            }
        }
        Ok(())
    }

    fn validate_local_policy(&self) -> Result<(), DescriptorError> {
        for (platform, target) in self.binary.iter().flatten() {
            if target.cmd.trim().is_empty() {
                return Err(schema_violation(format!(
                    "binary target {platform} is missing a cmd"
                )));
            }
        }
        for (label, package) in [("npx", &self.npx), ("uvx", &self.uvx)] {
            if package
                .as_ref()
                .is_some_and(|package| package.package.trim().is_empty())
            {
                return Err(schema_violation(format!(
                    "{label} distribution package must not be empty"
                )));
            }
        }
        Ok(())
    }
}

impl AcpBinaryTarget {
    fn validate(&self, platform: &str) -> Result<(), DescriptorError> {
        validate_uri(&format!("binary target {platform} archive"), &self.archive)?;
        if let Some(sha256) = &self.sha256 {
            let valid = sha256.len() == 64 && sha256.chars().all(|c| c.is_ascii_hexdigit());
            if !valid {
                return Err(schema_violation(format!(
                    "binary target {platform} sha256 must be 64 hex characters"
                )));
            }
        }
        Ok(())
    }
}

fn validate_optional_uri(label: &str, value: Option<&str>) -> Result<(), DescriptorError> {
    match value {
        Some(value) => validate_uri(label, value),
        None => Ok(()),
    }
}

fn validate_local_asset_path(label: &str, value: &str) -> Result<(), DescriptorError> {
    use std::path::Component;

    let path = std::path::Path::new(value);
    let safe_components = !value.trim().is_empty()
        && !value.contains('\\')
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if !safe_components {
        return Err(schema_violation(format!(
            "{label} {value:?} must be a relative path contained by installation.assets.directory"
        )));
    }
    if crate::shared::image_file::image_or_svg_mime_for_path(path).is_none() {
        return Err(schema_violation(format!(
            "{label} {value:?} must use an image format Cadencr can paint"
        )));
    }
    Ok(())
}

fn validate_uri(label: &str, value: &str) -> Result<(), DescriptorError> {
    reqwest::Url::parse(value)
        .map(|_| ())
        .map_err(|error| schema_violation(format!("{label} must be a valid URI: {error}")))
}

fn schema_violation(message: impl Into<String>) -> DescriptorError {
    DescriptorError::new(RejectionCode::DescriptorSchemaViolation, message)
}

fn is_protocol_owned_field(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    PROTOCOL_OWNED_FIELDS.contains(&normalized.as_str())
}

fn is_registry_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The registry pattern is `^[0-9]+\.[0-9]+\.[0-9]+` — anchored at the start
/// only, so pre-release and build suffixes are allowed to follow.
fn is_semver_prefixed(version: &str) -> bool {
    let mut segments = version.splitn(3, '.');
    let (Some(major), Some(minor), Some(rest)) =
        (segments.next(), segments.next(), segments.next())
    else {
        return false;
    };
    let patch: String = rest.chars().take_while(char::is_ascii_digit).collect();
    !major.is_empty()
        && !minor.is_empty()
        && !patch.is_empty()
        && major.chars().all(|c| c.is_ascii_digit())
        && minor.chars().all(|c| c.is_ascii_digit())
}
