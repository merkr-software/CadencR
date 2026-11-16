use super::entry::deserialize_non_null_option;
use super::ACP_BINARY_TARGETS;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
    use super::super::fixture::*;
    use super::super::AcpAgentEntry;
    use super::*;
    use crate::RejectionCode;
    use serde_json::json;

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
}
