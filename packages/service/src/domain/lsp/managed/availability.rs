//! One availability decision drives marketplace actions and editor suggestions.
use super::{invalid, platform, policy};
use crate::{
    domain::themes::managed::{catalog, models::SignedMixedCatalog},
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
    let node_available = !needs_node || super::super::spawn::node().await.is_ok();
    tokio::task::spawn_blocking(move || evaluate(&index, node_available))
        .await
        .map_err(invalid)
}
fn evaluate(index: &SignedMixedCatalog, node_available: bool) -> Availability {
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
            .get(platform())
            .is_none()
            || platform() == "unsupported"
        {
            Some(LspVersionUnavailable::Platform)
        } else if catalog::resolve_kind(index, id, version, "lsp").is_err() {
            Some(LspVersionUnavailable::Compatibility)
        } else {
            match cadencr_registry_core::signed_lsp_target(package, platform()) {
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
                        if !node_available
                            && target.runtime == cadencr_registry_core::LspRuntime::Node =>
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
        let (mut index, _) = crate::domain::themes::managed::catalog::tests::signed();
        index.signed.packages.clear();
        for id in [
            "ready-node",
            "future",
            "wrong-platform",
            "blocked",
            "incompatible",
        ] {
            let mut entry = template.clone();
            entry["package"]["lsp"]["id"] = id.into();
            let target = entry["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"].clone();
            entry["package"]["lsp"]["distribution"]["binary"] = json!({(platform()):target});
            match id {
                "future" => entry["package"]["lsp"]["protocol_version"] = 2.into(),
                "wrong-platform" => entry["package"]["lsp"]["distribution"]["binary"] = json!({}),
                "incompatible" => {
                    entry["package"]["host"]["compatibility"]["min_app_version"] = "999.0.0".into()
                }
                _ => {}
            }
            index.signed.packages.push(entry);
        }
        let without_node = evaluate(&index, false);
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
            evaluate(&index, true).recommended,
            BTreeMap::from([("ready-node".into(), "1.0.0".into())])
        );
    }
}
