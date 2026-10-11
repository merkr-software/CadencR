use super::AcpAgentEntry;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::*;
    use crate::RejectionCode;
    use serde_json::json;

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
}
