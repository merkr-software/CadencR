//! Signed Node runtime requirements; omitted requirements preserve the Node 20 baseline.
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
}
