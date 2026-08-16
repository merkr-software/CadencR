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

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

mod validation;
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

/// One descriptor file: a Cadencr host envelope wrapping a portable entry.
///
/// The envelope is host-owned, so an unknown key here is a mistake rather than
/// a field from a newer registry: refuse it instead of ignoring it.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ProviderDescriptor {
    pub schema_version: u32,
    pub agent: AcpAgentEntry,
    #[serde(default)]
    pub installation: HostInstallationSpec,
}

/// ACP Registry agent entry. Field names and shapes follow
/// <https://github.com/agentclientprotocol/registry> `agent.schema.json`.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct AcpAgentEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub repository: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub website: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub license: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub icon: Option<String>,
    /// Optional in the Rust shape because a hand-written local install has
    /// nothing to download. The registry-import validation profile requires it;
    /// the local-install profile does not.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub distribution: Option<AcpDistribution>,
    /// Every field this build does not model, preserved verbatim.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AcpDistribution {
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub binary: Option<BTreeMap<String, AcpBinaryTarget>>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub npx: Option<AcpPackageDistribution>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub uvx: Option<AcpPackageDistribution>,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AcpBinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AcpPackageDistribution {
    pub package: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// Host-local installation policy. Never part of the portable entry.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HostInstallationSpec {
    /// A disabled install stays on disk and stays visible, but does not join
    /// the runtime registry.
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// The explicitly selected local executable. Required in this build:
    /// downloading a distribution is a later increment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<LocalExecutableSpec>,
    /// Root of connector-owned package assets. `agent.icon` is resolved as a
    /// relative path below this directory and inlined by the host; the renderer
    /// never receives an arbitrary local filesystem path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<LocalAssetsSpec>,
}

impl Default for HostInstallationSpec {
    fn default() -> Self {
        Self {
            enabled: true,
            executable: None,
            assets: None,
        }
    }
}

fn enabled_by_default() -> bool {
    true
}

/// JSON Schema optional properties may be absent, but an explicit `null` is
/// not a value of their declared type. Serde's ordinary `Option<T>` collapses
/// those two cases, so registry fields use this deserializer to preserve the
/// schema distinction: `#[serde(default)]` handles absence, while a present
/// value must deserialize as `T`.
fn deserialize_non_null_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// A launch target: program plus argument vector. Never a shell string —
/// marketplace data must not be interpolated into a command line.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LocalExecutableSpec {
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Literal environment applied to the child. Mirrors the ACP distribution
    /// `env` shape. Values are redacted from logs and never leave the service.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// Host-local root for connector-owned assets such as the registry `icon`.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LocalAssetsSpec {
    pub directory: String,
}

impl AcpDistribution {
    /// Whether the entry declares a way to run on this OS/architecture.
    ///
    /// Package distributions are platform-independent, so declaring one is
    /// enough. A binary-only entry must name this host's target.
    pub fn supports_current_platform(&self) -> bool {
        if self.npx.is_some() || self.uvx.is_some() {
            return true;
        }
        match (&self.binary, current_binary_target()) {
            (Some(binary), Some(target)) => binary.contains_key(target),
            _ => false,
        }
    }
}

/// The ACP registry binary-distribution key for the running host, or `None`
/// when Cadencr runs somewhere the registry has no name for.
pub fn current_binary_target() -> Option<&'static str> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        _ => return None,
    };
    let host = format!("{os}-{arch}");
    ACP_BINARY_TARGETS
        .iter()
        .copied()
        .find(|target| *target == host)
}

#[cfg(test)]
mod tests {
    use super::super::rejection::RejectionCode;
    use super::{current_binary_target, AcpAgentEntry, ProviderDescriptor, ACP_BINARY_TARGETS};
    use serde_json::json;
    use std::path::PathBuf;

    fn descriptor(value: serde_json::Value) -> ProviderDescriptor {
        serde_json::from_value(value).expect("descriptor should deserialize")
    }

    fn valid_agent() -> serde_json::Value {
        json!({
            "id": "acme-agent",
            "name": "Acme Agent",
            "version": "1.2.3",
            "description": "An ACP agent",
        })
    }

    fn registry_fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/acp_registry/v1")
            .join(name)
    }

    #[test]
    fn accepts_a_minimal_local_entry() {
        let parsed = descriptor(json!({
            "schema_version": 1,
            "agent": valid_agent(),
            "installation": { "executable": { "command": "/usr/local/bin/acme" } },
        }));
        parsed.validate().expect("minimal entry should validate");
        assert!(parsed.installation.enabled, "enablement defaults to on");
        assert_eq!(
            parsed
                .installation
                .executable
                .expect("executable")
                .args
                .len(),
            0
        );
    }

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

    #[test]
    fn validates_the_distribution_block_when_present() {
        let mut agent = valid_agent();
        agent["distribution"] = json!({});
        let error = descriptor(json!({ "schema_version": 1, "agent": agent.clone() }))
            .validate()
            .expect_err("empty distribution should be rejected");
        assert_eq!(error.code, RejectionCode::DescriptorSchemaViolation);

        agent["distribution"] =
            json!({ "binary": { "plan9-riscv": { "archive": "https://x", "cmd": "x" } } });
        let error = descriptor(json!({ "schema_version": 1, "agent": agent.clone() }))
            .validate()
            .expect_err("unknown platform key should be rejected");
        assert_eq!(error.code, RejectionCode::DescriptorSchemaViolation);

        agent["distribution"] = json!({ "binary": { "linux-x86_64": { "archive": "https://x", "cmd": "x", "sha256": "abc" } } });
        let error = descriptor(json!({ "schema_version": 1, "agent": agent.clone() }))
            .validate()
            .expect_err("short sha256 should be rejected");
        assert_eq!(error.code, RejectionCode::DescriptorSchemaViolation);

        agent["distribution"] = json!({ "npx": { "package": "@acme/agent@1.2.3" } });
        descriptor(json!({ "schema_version": 1, "agent": agent }))
            .validate()
            .expect("npx distribution should validate");

        let mut agent = valid_agent();
        agent["distribution"] = json!({
            "binary": {},
            "npx": { "package": "@acme/agent@1.2.3" },
        });
        let error = descriptor(json!({ "schema_version": 1, "agent": agent }))
            .validate()
            .expect_err("a present binary map must satisfy minProperties");
        assert_eq!(error.code, RejectionCode::DescriptorSchemaViolation);
    }

    #[test]
    fn validates_every_registry_uri_field() {
        for field in ["repository", "website"] {
            let mut agent = valid_agent();
            agent["distribution"] = json!({ "npx": { "package": "acme-agent" } });
            agent[field] = json!("not a uri");
            let error = descriptor(json!({ "schema_version": 1, "agent": agent }))
                .agent
                .validate_registry_entry()
                .expect_err("invalid URI should be rejected");
            assert!(error.message.contains(field), "{}", error.message);
        }

        let mut agent = valid_agent();
        agent["distribution"] = json!({
            "binary": {
                "linux-x86_64": { "archive": "not a uri", "cmd": "acme" },
            },
        });
        let error = descriptor(json!({ "schema_version": 1, "agent": agent }))
            .agent
            .validate_registry_entry()
            .expect_err("invalid archive URI should be rejected");
        assert!(error.message.contains("archive"), "{}", error.message);
    }

    #[test]
    fn nested_registry_objects_reject_unknown_fields() {
        for agent in [
            json!({
                "id": "acme-agent",
                "name": "Acme Agent",
                "version": "1.0.0",
                "description": "d",
                "distribution": { "futureDistribution": {} },
            }),
            json!({
                "id": "acme-agent",
                "name": "Acme Agent",
                "version": "1.0.0",
                "description": "d",
                "distribution": {
                    "binary": {
                        "linux-x86_64": {
                            "archive": "https://example.com/acme.tar.gz",
                            "cmd": "acme",
                            "futureTarget": true,
                        },
                    },
                },
            }),
            json!({
                "id": "acme-agent",
                "name": "Acme Agent",
                "version": "1.0.0",
                "description": "d",
                "distribution": {
                    "npx": { "package": "acme-agent", "futurePackage": true },
                },
            }),
        ] {
            let error = serde_json::from_value::<AcpAgentEntry>(agent)
                .expect_err("nested additionalProperties must be false");
            assert!(error.to_string().contains("unknown field"), "{error}");
        }
    }

    #[test]
    fn optional_registry_properties_reject_explicit_null() {
        for (field, value) in [
            ("repository", json!(null)),
            ("website", json!(null)),
            ("license", json!(null)),
            ("icon", json!(null)),
            ("distribution", json!(null)),
        ] {
            let mut agent = valid_agent();
            agent[field] = value;
            let error = serde_json::from_value::<AcpAgentEntry>(agent)
                .expect_err("an explicit null is not an omitted schema property");
            assert!(error.to_string().contains("null"), "{field}: {error}");
        }

        for distribution in [
            json!({ "binary": null, "npx": { "package": "acme" } }),
            json!({ "npx": null, "uvx": { "package": "acme" } }),
            json!({ "uvx": null, "npx": { "package": "acme" } }),
            json!({
                "binary": {
                    "linux-x86_64": {
                        "archive": "https://example.com/acme.tar.gz",
                        "cmd": "acme",
                        "sha256": null,
                    },
                },
            }),
        ] {
            let mut agent = valid_agent();
            agent["distribution"] = distribution;
            serde_json::from_value::<AcpAgentEntry>(agent)
                .expect_err("nested optional schema properties reject null");
        }
    }

    #[test]
    fn local_icon_assets_require_an_absolute_root_and_contained_image_path() {
        for (directory, icon) in [
            ("relative/root", "icon.svg"),
            ("/package", "../secret.svg"),
            ("/package", "/tmp/icon.svg"),
            ("/package", "icon.txt"),
        ] {
            let mut agent = valid_agent();
            agent["icon"] = json!(icon);
            let error = descriptor(json!({
                "schema_version": 1,
                "agent": agent,
                "installation": {
                    "assets": { "directory": directory }
                }
            }))
            .validate()
            .expect_err("unsafe local icon metadata must be rejected");
            assert_eq!(error.code, RejectionCode::DescriptorSchemaViolation);
        }
    }

    #[test]
    fn pinned_registry_entry_validates_and_round_trips_losslessly() {
        let raw = std::fs::read_to_string(registry_fixture("claude-acp.agent.json"))
            .expect("pinned registry entry");
        let original: serde_json::Value = serde_json::from_str(&raw).expect("fixture JSON");
        let entry: AcpAgentEntry = serde_json::from_value(original.clone()).expect("entry shape");
        entry
            .validate_registry_entry()
            .expect("pinned upstream entry should validate");
        assert_eq!(serde_json::to_value(entry).unwrap(), original);
    }

    #[test]
    fn pinned_schema_records_the_constraints_implemented_here() {
        let raw = std::fs::read_to_string(registry_fixture("agent.schema.json"))
            .expect("pinned registry schema");
        let schema: serde_json::Value = serde_json::from_str(&raw).expect("schema JSON");
        assert_eq!(
            schema["$id"],
            "https://cdn.agentclientprotocol.com/registry/v1/latest/agent.schema.json"
        );
        assert!(schema["required"]
            .as_array()
            .expect("required")
            .iter()
            .any(|field| field == "distribution"));
        assert_eq!(
            schema["properties"]["distribution"]["additionalProperties"],
            false
        );
        assert_eq!(
            schema["definitions"]["binaryDistribution"]["minProperties"],
            1
        );
        assert_eq!(
            schema["definitions"]["binaryTarget"]["additionalProperties"],
            false
        );
        assert_eq!(
            schema["definitions"]["packageDistribution"]["additionalProperties"],
            false
        );
    }

    #[test]
    fn platform_support_falls_back_to_package_distributions() {
        let entry: AcpAgentEntry = serde_json::from_value(json!({
            "id": "acme-agent",
            "name": "Acme Agent",
            "version": "1.0.0",
            "description": "d",
            "distribution": { "npx": { "package": "@acme/agent@1.0.0" } },
        }))
        .unwrap();
        assert!(entry
            .distribution
            .expect("distribution")
            .supports_current_platform());
    }

    #[test]
    fn binary_only_distribution_must_name_this_host() {
        let current = current_binary_target().expect("supported test platform");
        let other = ACP_BINARY_TARGETS
            .iter()
            .find(|target| **target != current)
            .expect("another target");
        let entry: AcpAgentEntry = serde_json::from_value(json!({
            "id": "acme-agent",
            "name": "Acme Agent",
            "version": "1.0.0",
            "description": "d",
            "distribution": { "binary": { (*other): { "archive": "https://x", "cmd": "acme" } } },
        }))
        .unwrap();
        assert!(!entry
            .distribution
            .expect("distribution")
            .supports_current_platform());
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

    /// The host envelope is ours, so a typo there is a mistake to surface — not
    /// a field from a newer registry to preserve.
    #[test]
    fn rejects_unknown_host_envelope_fields() {
        for value in [
            json!({ "schema_version": 1, "agent": valid_agent(), "provider": "acme" }),
            json!({
                "schema_version": 1,
                "agent": valid_agent(),
                "installation": { "enable": true },
            }),
            json!({
                "schema_version": 1,
                "agent": valid_agent(),
                "installation": { "executable": { "command": "/bin/acme", "shell": "zsh" } },
            }),
        ] {
            let error = serde_json::from_value::<ProviderDescriptor>(value)
                .expect_err("unknown host fields must not be ignored");
            assert!(error.to_string().contains("unknown field"), "{error}");
        }
    }

    /// Registry fields this build does not model must survive a round trip, so
    /// an imported entry can be exported again without silent data loss.
    #[test]
    fn unknown_registry_fields_round_trip() {
        let entry: AcpAgentEntry = serde_json::from_value(json!({
            "id": "acme-agent",
            "name": "Acme Agent",
            "version": "1.0.0",
            "description": "d",
            "license": "MIT",
            "futureField": { "nested": [1, 2, 3] },
        }))
        .unwrap();
        assert_eq!(entry.extra.get("futureField").unwrap()["nested"][2], 3);
        let exported = serde_json::to_value(&entry).unwrap();
        assert_eq!(exported["futureField"]["nested"][2], 3);
        assert_eq!(exported["license"], "MIT");
    }

    #[test]
    fn registry_profile_preserves_unknown_root_fields_without_applying_host_policy() {
        let entry: AcpAgentEntry = serde_json::from_value(json!({
            "id": "acme-agent",
            "name": "Acme Agent",
            "version": "1.0.0",
            "description": "d",
            "distribution": { "npx": { "package": "acme-agent" } },
            "models": ["future-registry-field"],
        }))
        .unwrap();
        entry
            .validate_registry_entry()
            .expect("the upstream root schema permits additional properties");
        assert_eq!(entry.extra["models"][0], "future-registry-field");
    }
}
