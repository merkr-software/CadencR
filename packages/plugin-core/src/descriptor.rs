//! The portable ACP Registry agent entry and the Cadencr host envelope around
//! it.
//!
//! Two deliberately separate things live here:
//!
//! - [`AcpAgentEntry`] is the **portable** payload. It mirrors the ACP Registry
//!   entry format (`agent.schema.json`: `id`, `name`, `version`, `description`,
//!   `repository`, `website`, `authors`, `license`, `icon`, `distribution`) and
//!   keeps every unrecognised root field in `extra`, so an entry can round-trip
//!   through Cadencr without losing data it does not consume yet. Registry
//!   imports use [`AcpAgentEntry::validate_registry_entry`]; local descriptors
//!   use a deliberately separate profile that permits an omitted distribution.
//! - [`ProviderDescriptor`] is the **host** envelope: a Cadencr `schema_version`
//!   plus the host-local [`HostInstallationSpec`] (enablement and the resolved
//!   local executable). Nothing in the envelope belongs in the portable payload,
//!   and the portable payload never carries host policy.
//!
//! Capabilities are not modelled here on purpose. Models, modes, permission
//! maps, and authentication are owned by the ACP protocol and discovered
//! through `initialize` / `session/new`; inventing descriptor booleans for them
//! would make a marketplace field authoritative over the negotiated session.
//! See `docs/PROVIDER_SPEC/BOUNDARIES.md` ("Do not guess capabilities from
//! executable names, versions, tool names, or provider IDs").
mod distribution;
mod entry;
#[cfg(test)]
mod fixture;
mod host;
mod validation;
pub use distribution::{
    current_binary_target, AcpBinaryTarget, AcpDistribution, AcpPackageDistribution,
};
pub use entry::AcpAgentEntry;
pub use host::{HostInstallationSpec, LocalAssetsSpec, LocalExecutableSpec, ProviderDescriptor};
pub use validation::validate_provider_id;

/// Host envelope versions this build understands.
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Platform keys the ACP Registry `distribution.binary` map is allowed to use.
pub const ACP_BINARY_TARGETS: &[&str] = &[
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
];

#[cfg(test)]
mod tests {
    use super::fixture::*;
    use crate::RejectionCode;
    use serde_json::json;

    #[test]
    fn local_and_registry_profiles_disagree_only_where_documented() {
        let parsed = descriptor(json!({
            "schema_version": 1,
            "agent": valid_agent(),
            "installation": { "executable": { "command": "/usr/local/bin/acme" } },
        }));
        parsed
            .validate()
            .expect("a local install may omit distribution");
        let error = parsed
            .agent
            .validate_registry_entry()
            .expect_err("a registry import must declare distribution");
        assert_eq!(error.code, RejectionCode::DescriptorSchemaViolation);
        assert!(error.message.contains("distribution"), "{}", error.message);
    }

    #[test]
    fn rejects_unsupported_schema_versions() {
        let error = descriptor(json!({ "schema_version": 99, "agent": valid_agent() }))
            .validate()
            .expect_err("future schema versions must be rejected");
        assert_eq!(error.code, RejectionCode::UnsupportedSchemaVersion);
    }

    #[test]
    fn rejects_ids_outside_the_registry_pattern() {
        for bad in ["Acme", "1acme", "acme_agent", "acme agent", ""] {
            let mut agent = valid_agent();
            agent["id"] = json!(bad);
            let error = descriptor(json!({ "schema_version": 1, "agent": agent }))
                .validate()
                .expect_err("id should be rejected");
            assert_eq!(
                error.code,
                RejectionCode::DescriptorSchemaViolation,
                "{bad}"
            );
        }
    }

    #[test]
    fn requires_name_description_and_semver() {
        for (field, value) in [("name", json!("")), ("description", json!(" "))] {
            let mut agent = valid_agent();
            agent[field] = value;
            let error = descriptor(json!({ "schema_version": 1, "agent": agent }))
                .validate()
                .expect_err("empty field should be rejected");
            assert_eq!(error.code, RejectionCode::DescriptorSchemaViolation);
        }
        for bad in ["1", "1.2", "v1.2.3", "1.2.x"] {
            let mut agent = valid_agent();
            agent["version"] = json!(bad);
            let error = descriptor(json!({ "schema_version": 1, "agent": agent }))
                .validate()
                .expect_err("bad version should be rejected");
            assert_eq!(
                error.code,
                RejectionCode::DescriptorSchemaViolation,
                "{bad}"
            );
        }
        let mut agent = valid_agent();
        agent["version"] = json!("1.2.3-beta.1");
        descriptor(json!({ "schema_version": 1, "agent": agent }))
            .validate()
            .expect("pre-release suffixes are allowed by the registry pattern");
    }

    /// A descriptor may not pre-declare what ACP negotiates. Silently ignoring
    /// such a field would let marketplace JSON look authoritative over the
    /// handshake, so the whole descriptor is refused.
    #[test]
    fn rejects_fields_the_acp_handshake_owns() {
        for key in [
            "models",
            "modes",
            "permissions",
            "permission_modes",
            "authMethods",
            "capabilities",
            "default_model",
            "thinking-levels",
            "accessModes",
            "slash_commands",
        ] {
            let mut agent = valid_agent();
            agent[key] = json!(["anything"]);
            let error = descriptor(json!({ "schema_version": 1, "agent": agent }))
                .validate()
                .expect_err("a protocol-owned field must be refused");
            assert_eq!(
                error.code,
                RejectionCode::DescriptorSchemaViolation,
                "{key}"
            );
            assert!(error.message.contains(key), "{key}: {}", error.message);
        }
    }
}
