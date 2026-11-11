//! One availability decision drives marketplace actions and editor suggestions.
use super::{invalid, platform, policy};
use crate::{
    domain::marketplace::{catalog, models::SignedMixedCatalog},
    error::AppError,
};
use serde::Serialize;
use std::collections::BTreeMap;
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LspVersionUnavailable {
    Platform,
    Protocol,
    Node,
    Policy,
    Compatibility,
    OperatingSystem,
}
#[derive(Default)]
pub struct Availability {
    pub recommended: BTreeMap<String, String>,
    pub blocked: BTreeMap<String, BTreeMap<String, String>>,
    pub unavailable: BTreeMap<String, BTreeMap<String, LspVersionUnavailable>>,
}
pub async fn acquire(index: SignedMixedCatalog) -> Result<Availability, AppError> {
    let needs_node = cadencr_registry_core::catalog_members(&index.signed.packages)
        .filter(|entry| entry["kind"] == "lsp")
        .any(|entry| {
            entry["package"]["lsp"]["distribution"]["binary"][platform()]["runtime"] == "node"
        });
    let node_version = if needs_node {
        super::super::spawn::node_candidate()
            .await
            .and_then(|candidate| candidate.version)
    } else {
        None
    };
    tokio::task::spawn_blocking(move || {
        evaluate()
            .index(&index)
            .host_platform(platform())
            .maybe_node_version(node_version)
            .maybe_macos_version(super::super::os_requirements::current_macos_version())
            .call()
    })
    .await
    .map_err(invalid)
}
#[bon::builder]
fn evaluate(
    index: &SignedMixedCatalog,
    host_platform: &str,
    node_version: Option<cli_discovery::VersionKey>,
    macos_version: Option<cli_discovery::VersionKey>,
) -> Availability {
    let mut result = Availability::default();
    let policy = policy::snapshot();
    for entry in cadencr_registry_core::catalog_members(&index.signed.packages)
        .filter(|entry| entry["kind"] == "lsp")
    {
        let package = &entry["package"];
        let (Some(id), Some(version)) = (
            package["lsp"]["id"].as_str(),
            package["lsp"]["version"].as_str(),
        ) else {
            continue;
        };
        let reason = if package["lsp"]["protocol_version"] != 1 {
            Some(LspVersionUnavailable::Protocol)
        } else if package["lsp"]["distribution"]["binary"]
            .get(host_platform)
            .is_none()
            || host_platform == "unsupported"
        {
            Some(LspVersionUnavailable::Platform)
        } else if catalog::resolve_kind(index, id, version, "lsp").is_err() {
            Some(LspVersionUnavailable::Compatibility)
        } else {
            match cadencr_registry_core::signed_lsp_target(package, host_platform) {
                Err(_) => Some(LspVersionUnavailable::Protocol),
                Ok(target) => match policy
                    .as_ref()
                    .map_err(invalid)
                    .and_then(|snapshot| snapshot.require_install(id, version, &target))
                {
                    Err(AppError::Coded {
                        code: "LSP_BLOCKED",
                        message,
                        ..
                    }) => {
                        result
                            .blocked
                            .entry(id.into())
                            .or_default()
                            .insert(version.into(), message);
                        None
                    }
                    Err(_) => Some(LspVersionUnavailable::Policy),
                    Ok(())
                        if !super::super::os_requirements::satisfies(
                            macos_version,
                            target.macos_min_version.as_deref(),
                        ) =>
                    {
                        Some(LspVersionUnavailable::OperatingSystem)
                    }
                    Ok(())
                        if target.runtime == cadencr_registry_core::LspRuntime::Node
                            && !super::super::spawn::node_version_satisfies(
                                node_version,
                                target.node_minimum(),
                            ) =>
                    {
                        Some(LspVersionUnavailable::Node)
                    }
                    Ok(()) => None,
                },
            }
        };
        if let Some(reason) = reason {
            result
                .unavailable
                .entry(id.into())
                .or_default()
                .insert(version.into(), reason);
        }
    }
    result.recommended = catalog::recommended_for(index, "lsp", |entry| {
        let id = entry["package"]["lsp"]["id"].as_str().unwrap_or_default();
        let version = entry["package"]["lsp"]["version"]
            .as_str()
            .unwrap_or_default();
        !result
            .blocked
            .get(id)
            .is_some_and(|versions| versions.contains_key(version))
            && !result
                .unavailable
                .get(id)
                .is_some_and(|versions| versions.contains_key(version))
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_macos_requirements_filter_recommendations_on_every_host_platform() {
        let temp = tempfile::tempdir().unwrap();
        let _policy =
            super::super::policy::tests::configure(&temp.path().join("policy"), json!([]));
        let template: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tooling/marketplace-registry/examples/lsp/package.node.json"
        )))
        .unwrap();
        let (mut index, _) = crate::domain::marketplace::catalog::tests::signed();
        index.signed.packages.clear();
        for (id, floor) in [("mac12-server", "12.0.0"), ("mac15-server", "15.0.0")] {
            let mut entry = template.clone();
            entry["package"]["host"]["compatibility"]["min_app_version"] =
                env!("CARGO_PKG_VERSION").into();
            entry["package"]["lsp"]["id"] = id.into();
            let mut target =
                entry["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"].clone();
            target["runtime"] = "native".into();
            target["macos_min_version"] = floor.into();
            entry["package"]["lsp"]["distribution"]["binary"] = json!({"darwin-aarch64":target});
            index.signed.packages.push(entry);
        }
        let old = evaluate()
            .index(&index)
            .host_platform("darwin-aarch64")
            .macos_version(cli_discovery::VersionKey(12, 7, 6))
            .call();
        assert_eq!(
            old.recommended,
            BTreeMap::from([("mac12-server".into(), "1.0.0".into())])
        );
        assert_eq!(
            old.unavailable["mac15-server"]["1.0.0"],
            LspVersionUnavailable::OperatingSystem
        );
        let unknown = evaluate()
            .index(&index)
            .host_platform("darwin-aarch64")
            .call();
        assert!(unknown.recommended.is_empty());
        assert_eq!(
            unknown.unavailable["mac12-server"]["1.0.0"],
            LspVersionUnavailable::OperatingSystem
        );
        let supported = evaluate()
            .index(&index)
            .host_platform("darwin-aarch64")
            .macos_version(cli_discovery::VersionKey(15, 0, 0))
            .call();
        assert_eq!(supported.recommended.len(), 2);
        let linux = evaluate()
            .index(&index)
            .host_platform("linux-x86_64")
            .call();
        assert_eq!(
            linux.unavailable["mac15-server"]["1.0.0"],
            LspVersionUnavailable::Platform
        );
    }
    #[test]
    fn unsupported_platform_protocol_runtime_and_revocation_never_offer_install_actions() {
        let temp = tempfile::tempdir().unwrap();
        let _policy = super::super::policy::tests::configure(
            &temp.path().join("policy"),
            json!([{"lsp_id":"blocked","reason":"unsafe"}]),
        );
        let template: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tooling/marketplace-registry/examples/lsp/package.node.json"
        )))
        .unwrap();
        let (mut index, _) = crate::domain::marketplace::catalog::tests::signed();
        index.signed.packages.clear();
        for id in [
            "ready-node",
            "requires-node22",
            "future",
            "wrong-platform",
            "blocked",
            "incompatible",
        ] {
            let mut entry = template.clone();
            entry["package"]["host"]["compatibility"]["min_app_version"] =
                env!("CARGO_PKG_VERSION").into();
            entry["package"]["lsp"]["id"] = id.into();
            let target = entry["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"].clone();
            entry["package"]["lsp"]["distribution"]["binary"] = json!({(platform()):target});
            match id {
                "requires-node22" => {
                    entry["package"]["lsp"]["distribution"]["binary"][platform()]
                        ["node_min_version"] = "22.18.0".into()
                }
                "future" => entry["package"]["lsp"]["protocol_version"] = 2.into(),
                "wrong-platform" => entry["package"]["lsp"]["distribution"]["binary"] = json!({}),
                "incompatible" => {
                    entry["package"]["host"]["compatibility"]["min_app_version"] = "999.0.0".into()
                }
                _ => {}
            }
            index.signed.packages.push(entry);
        }
        let without_node = evaluate().index(&index).host_platform(platform()).call();
        assert!(without_node.recommended.is_empty());
        assert_eq!(
            without_node.unavailable["ready-node"]["1.0.0"],
            LspVersionUnavailable::Node
        );
        assert_eq!(
            without_node.unavailable["future"]["1.0.0"],
            LspVersionUnavailable::Protocol
        );
        assert_eq!(
            without_node.unavailable["wrong-platform"]["1.0.0"],
            LspVersionUnavailable::Platform
        );
        assert_eq!(
            without_node.unavailable["incompatible"]["1.0.0"],
            LspVersionUnavailable::Compatibility
        );
        assert!(without_node.blocked["blocked"]["1.0.0"].contains("unsafe"));
        assert_eq!(
            evaluate()
                .index(&index)
                .host_platform(platform())
                .node_version(cli_discovery::VersionKey(22, 17, 9))
                .call()
                .unavailable["requires-node22"]["1.0.0"],
            LspVersionUnavailable::Node
        );
        assert_eq!(
            evaluate()
                .index(&index)
                .host_platform(platform())
                .node_version(cli_discovery::VersionKey(22, 18, 0))
                .call()
                .recommended,
            BTreeMap::from([
                ("ready-node".into(), "1.0.0".into()),
                ("requires-node22".into(), "1.0.0".into())
            ])
        );
        assert_eq!(
            evaluate()
                .index(&index)
                .host_platform(platform())
                .node_version(cli_discovery::VersionKey(20, 0, 0))
                .call()
                .recommended,
            BTreeMap::from([("ready-node".into(), "1.0.0".into())])
        );
    }
}
