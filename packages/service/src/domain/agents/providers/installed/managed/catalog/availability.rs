//! Which catalog versions cannot install on this host, judged by the installer's own check.

use super::super::validation::ships_for_platform;
use super::super::ManagedProviderPackage;
use crate::domain::marketplace::models::TabVersionUnavailable;
use std::collections::BTreeMap;

pub(super) type UnavailableVersions = BTreeMap<String, BTreeMap<String, TabVersionUnavailable>>;

/// Every version the installer would refuse for lack of a binary for `platform`
/// (`None`: this host has no registry target name, so every version).
pub(super) fn unavailable_versions(
    packages: &[ManagedProviderPackage],
    platform: Option<&str>,
) -> UnavailableVersions {
    let mut unavailable = UnavailableVersions::new();
    for package in packages
        .iter()
        .filter(|package| !ships_for_platform(package, platform))
    {
        unavailable
            .entry(package.agent.id.clone())
            .or_default()
            .insert(
                package.agent.version.clone(),
                TabVersionUnavailable::Platform,
            );
    }
    unavailable
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::providers::installed::managed::SignedManagedProviderIndex;

    fn package(id: &str, version: &str) -> ManagedProviderPackage {
        let index: SignedManagedProviderIndex = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/managed_provider_index/v1/valid.json"
        )))
        .unwrap();
        let mut package = index.signed.packages[0].clone();
        package.agent.id = id.into();
        package.agent.version = version.into();
        package
    }

    fn target_of(package: &ManagedProviderPackage) -> String {
        package
            .agent
            .distribution
            .as_ref()
            .and_then(|distribution| distribution.binary.as_ref())
            .and_then(|binary| binary.keys().next().cloned())
            .expect("fixture has a binary target")
    }

    #[test]
    fn versions_without_a_binary_for_the_host_are_platform_unavailable() {
        let shipped = package("agent", "1.0.0");
        let host = target_of(&shipped);
        let mut elsewhere = package("agent", "2.0.0");
        let distribution = elsewhere.agent.distribution.as_mut().unwrap();
        let binary = distribution.binary.as_mut().unwrap();
        let target = binary.remove(&host).unwrap();
        binary.insert("other-target".into(), target);
        let packages = [shipped, elsewhere];
        assert_eq!(
            unavailable_versions(&packages, Some(&host)),
            BTreeMap::from([(
                "agent".to_string(),
                BTreeMap::from([("2.0.0".to_string(), TabVersionUnavailable::Platform)])
            )])
        );
    }

    #[test]
    fn a_host_with_no_target_name_cannot_install_any_version() {
        let packages = [
            package("a", "1.0.0"),
            package("a", "1.1.0"),
            package("b", "2.0.0"),
        ];
        assert_eq!(
            unavailable_versions(&packages, None),
            BTreeMap::from([
                (
                    "a".to_string(),
                    BTreeMap::from([
                        ("1.0.0".to_string(), TabVersionUnavailable::Platform),
                        ("1.1.0".to_string(), TabVersionUnavailable::Platform),
                    ])
                ),
                (
                    "b".to_string(),
                    BTreeMap::from([("2.0.0".to_string(), TabVersionUnavailable::Platform)])
                ),
            ])
        );
        assert!(unavailable_versions(&[], None).is_empty());
    }
}
