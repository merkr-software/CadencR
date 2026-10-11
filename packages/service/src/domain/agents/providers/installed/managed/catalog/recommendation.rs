//! Release selection policy is host-owned, never part of the signed catalog.

use super::super::ManagedProviderPackage;
use semver::Version;
use std::collections::BTreeMap;

pub(super) fn recommended_versions(
    packages: &[ManagedProviderPackage],
    app_version: &str,
    platform: Option<&str>,
) -> BTreeMap<String, String> {
    let Some(platform) = platform else {
        return BTreeMap::new();
    };
    let mut selected: BTreeMap<String, Version> = BTreeMap::new();
    for package in packages {
        if !package
            .host
            .compatibility
            .supports(app_version)
            .unwrap_or(false)
            || !package
                .agent
                .distribution
                .as_ref()
                .and_then(|distribution| distribution.binary.as_ref())
                .is_some_and(|binary| binary.contains_key(platform))
        {
            continue;
        }
        let Ok(version) = Version::parse(&package.agent.version) else {
            continue;
        };
        let replace = selected.get(&package.agent.id).is_none_or(|current| {
            let stable = version.pre.is_empty();
            let current_stable = current.pre.is_empty();
            stable && !current_stable || stable == current_stable && version > *current
        });
        if replace {
            selected.insert(package.agent.id.clone(), version);
        }
    }
    selected
        .into_iter()
        .map(|(id, version)| (id, version.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::providers::installed::managed::SignedManagedProviderIndex;

    fn package(version: &str) -> ManagedProviderPackage {
        let index: SignedManagedProviderIndex = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/managed_provider_index/v1/valid.json"
        )))
        .unwrap();
        let mut package = index.signed.packages[0].clone();
        package.agent.version = version.into();
        package
    }

    fn select(packages: &[ManagedProviderPackage]) -> Option<String> {
        let target = packages[0]
            .agent
            .distribution
            .as_ref()
            .unwrap()
            .binary
            .as_ref()
            .unwrap()
            .keys()
            .next()
            .unwrap();
        recommended_versions(packages, "0.12.0", Some(target))
            .get(&packages[0].agent.id)
            .cloned()
    }

    #[test]
    fn chooses_highest_semver_stable_independently_of_catalog_order() {
        assert_eq!(
            select(&[package("1.9.0"), package("1.10.0"), package("2.0.0-beta.1")]),
            Some("1.10.0".into())
        );
        assert_eq!(
            select(&[package("2.0.0-beta.1"), package("2.0.0-beta.10")]),
            Some("2.0.0-beta.10".into())
        );
    }

    #[test]
    fn excludes_unavailable_distributions_and_incompatible_app_bounds() {
        let mut unsupported = package("5.0.0");
        unsupported.agent.distribution = None;
        let mut too_new = package("4.0.0");
        too_new.host.compatibility.min_app_version = "0.13.0".into();
        let mut too_old = package("3.0.0");
        too_old.host.compatibility.max_app_version = Some("0.11.0".into());
        assert_eq!(
            select(&[package("1.0.0"), unsupported, too_new, too_old]),
            Some("1.0.0".into())
        );
        assert!(
            recommended_versions(&[package("1.0.0")], "0.12.0", Some("unknown-target")).is_empty()
        );
        assert!(recommended_versions(&[package("1.0.0")], "0.12.0", None).is_empty());
    }
}
