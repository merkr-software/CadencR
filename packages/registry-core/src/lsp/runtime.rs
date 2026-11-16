//! Signed runtime and operating-system requirements; omission preserves legacy behavior.
use super::invalid;
use crate::{LspRuntime, LspTarget, RegistryError};

impl LspTarget {
    pub const DEFAULT_NODE_MIN_VERSION: &'static str = "20.0.0";

    /// The signed minimum for a Node bundle, including the legacy default.
    pub fn node_minimum(&self) -> &str {
        self.node_min_version
            .as_deref()
            .unwrap_or(Self::DEFAULT_NODE_MIN_VERSION)
    }
}

pub(super) fn validate_node_minimum(target: &LspTarget) -> Result<(), RegistryError> {
    let Some(value) = &target.node_min_version else {
        return Ok(());
    };
    if target.runtime != LspRuntime::Node || value.len() > 64 {
        return Err(invalid(
            "node_min_version is only a bounded Node runtime requirement",
        ));
    }
    let version = semver::Version::parse(value)
        .map_err(|_| invalid("node_min_version must be a full stable semantic version"))?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err(invalid(
            "node_min_version must be a full stable semantic version",
        ));
    }
    Ok(())
}

/// Only native Darwin targets can sign a macOS requirement.
pub(super) fn validate_macos_minimum(
    target: &LspTarget,
    platform: &str,
) -> Result<(), RegistryError> {
    let Some(value) = &target.macos_min_version else {
        return Ok(());
    };
    if target.runtime != LspRuntime::Native
        || !matches!(platform, "darwin-aarch64" | "darwin-x86_64")
        || value.len() > 64
    {
        return Err(invalid(
            "macos_min_version requires a native Darwin target and at most 64 bytes",
        ));
    }
    let version = semver::Version::parse(value)
        .map_err(|_| invalid("macos_min_version must be a full stable semantic version"))?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err(invalid(
            "macos_min_version must be a full stable semantic version",
        ));
    }
    Ok(())
}

pub(super) fn validate_macos_entry(
    bytes: &[u8],
    platform: &str,
    target: &LspTarget,
) -> Result<(), RegistryError> {
    let Some(value) = &target.macos_min_version else {
        return Ok(());
    };
    let platform = cadencr_plugin_core::tab::TabPlatform::parse(platform)
        .ok_or_else(|| invalid("unsupported platform"))?;
    let minimum =
        cadencr_plugin_core::tab::macos_minimum_version(bytes, platform).map_err(invalid)?;
    let declared = semver::Version::parse(value).map_err(|_| invalid("invalid macOS minimum"))?;
    if let Some([major, minor, patch]) = minimum {
        let actual = semver::Version::new(u64::from(major), u64::from(minor), u64::from(patch));
        if actual > declared {
            return Err(invalid(format!(
                "Mach-O requires macOS {actual}, above signed macos_min_version {declared}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    fn package() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../../tooling/marketplace-registry/examples/lsp/package.node.json"
        ))
        .unwrap()
    }

    #[test]
    fn optional_requirements_preserve_legacy_target_bytes_and_default() {
        let package = package();
        let target = crate::signed_lsp_target(&package, "linux-x86_64").unwrap();
        assert_eq!(target.node_minimum(), "20.0.0");
        assert_eq!(
            serde_json::to_value(target).unwrap(),
            package["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"]
        );
    }

    #[test]
    fn only_full_stable_versions_on_node_targets_are_signed() {
        for value in ["22.18.0", "24.0.1", "20.0.0"] {
            let mut package = package();
            package["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"]
                ["node_min_version"] = json!(value);
            crate::validate_marketplace_package(&package).unwrap();
            assert_eq!(
                crate::signed_lsp_target(&package, "linux-x86_64")
                    .unwrap()
                    .node_minimum(),
                value
            );
        }
        for value in [
            json!(null),
            json!(true),
            json!(22),
            json!("22"),
            json!(">=22.18.0"),
            json!("v22.18.0"),
            json!("22.18.0-rc.1"),
            json!("22.18.0+build"),
            json!("022.18.0"),
            json!("22.18.0\n"),
            json!("1".repeat(65)),
        ] {
            let mut package = package();
            package["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"]
                ["node_min_version"] = value;
            assert!(crate::validate_marketplace_package(&package).is_err());
            assert!(crate::signed_lsp_target(&package, "linux-x86_64").is_err());
        }
        let mut package = package();
        let target = &mut package["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"];
        target["runtime"] = json!("native");
        target["node_min_version"] = json!("22.18.0");
        assert!(crate::validate_marketplace_package(&package).is_err());
    }
    #[test]
    fn macos_minimum_is_optional_but_only_signs_stable_native_darwin_requirements() {
        for platform in ["darwin-aarch64", "darwin-x86_64", "linux-x86_64"] {
            for runtime in ["node", "native"] {
                for value in [
                    json!("15.0.0"),
                    json!(null),
                    json!(15),
                    json!("15"),
                    json!("v15.0.0"),
                    json!("15.0.0-rc.1"),
                    json!("15.0.0+build"),
                    json!("015.0.0"),
                    json!("15.0.0\n"),
                    json!("1".repeat(65)),
                ] {
                    let mut package = package();
                    let mut target =
                        package["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"].clone();
                    target["runtime"] = json!(runtime);
                    target["macos_min_version"] = value.clone();
                    package["package"]["lsp"]["distribution"]["binary"] = json!({platform: target});
                    let valid =
                        runtime == "native" && platform.starts_with("darwin-") && value == "15.0.0";
                    assert_eq!(
                        crate::validate_marketplace_package(&package).is_ok(),
                        valid,
                        "{platform} {runtime} {value}"
                    );
                    assert_eq!(crate::signed_lsp_target(&package, platform).is_ok(), valid);
                    if valid {
                        let target = crate::signed_lsp_target(&package, platform).unwrap();
                        assert_eq!(target.macos_min_version.as_deref(), Some("15.0.0"));
                        assert_eq!(
                            serde_json::to_value(target).unwrap(),
                            package["package"]["lsp"]["distribution"]["binary"][platform]
                        );
                    }
                }
            }
        }
    }
}
