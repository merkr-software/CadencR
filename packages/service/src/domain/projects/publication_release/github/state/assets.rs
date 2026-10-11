use super::{conflict, Asset, GitHubReleaseExpectation};
use crate::error::AppError;
use std::collections::HashMap;

pub(super) struct ExpectedAsset<'a> {
    pub name: &'a str,
    pub digest: &'a str,
    pub size: u64,
}

pub(super) fn validate_assets(
    assets: &[Asset],
    expected: &[ExpectedAsset<'_>],
    allow_missing: bool,
) -> Result<(), AppError> {
    let expected = expected
        .iter()
        .map(|asset| (asset.name, asset))
        .collect::<HashMap<_, _>>();
    let mut seen = HashMap::new();
    for asset in assets {
        let Some(wanted) = expected.get(asset.name.as_str()) else {
            return Err(conflict("GitHub release contains an unexpected asset"));
        };
        if seen.insert(asset.name.as_str(), asset.id).is_some() {
            return Err(conflict("GitHub release contains duplicate asset names"));
        }
        if asset.state != "uploaded"
            || asset.size != wanted.size
            || asset.digest.as_deref() != Some(&format!("sha256:{}", wanted.digest))
        {
            return Err(conflict(
                "GitHub release asset state, size, or digest does not match",
            ));
        }
    }
    if !allow_missing && seen.len() != expected.len() {
        return Err(conflict("GitHub release is missing a required asset"));
    }
    Ok(())
}

pub(super) fn expected_assets(request: &GitHubReleaseExpectation) -> Vec<ExpectedAsset<'_>> {
    let mut assets = vec![
        ExpectedAsset {
            name: &request.archive_name,
            digest: &request.archive_sha256,
            size: request.archive_size,
        },
        ExpectedAsset {
            name: &request.metadata_name,
            digest: &request.metadata_sha256,
            size: request.metadata_size,
        },
    ];
    assets.extend(
        request
            .additional_archives
            .iter()
            .map(|archive| ExpectedAsset {
                name: &archive.name,
                digest: &archive.sha256,
                size: archive.size,
            }),
    );
    assets
}

pub(in crate::domain::projects::publication_release::github) fn is_sha(value: &str) -> bool {
    (value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        || value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_platform_is_required_and_extra_or_duplicate_assets_are_rejected() {
        let expected = [
            ExpectedAsset {
                name: "linux.tgz",
                digest: "linux",
                size: 1,
            },
            ExpectedAsset {
                name: "darwin.tgz",
                digest: "darwin",
                size: 2,
            },
            ExpectedAsset {
                name: "package.json",
                digest: "manifest",
                size: 3,
            },
        ];
        let asset = |id, name: &str, sha: &str, size| Asset {
            id,
            name: name.into(),
            size,
            state: "uploaded".into(),
            digest: Some(format!("sha256:{sha}")),
        };
        let mut assets = vec![
            asset(1, "linux.tgz", "linux", 1),
            asset(2, "darwin.tgz", "darwin", 2),
        ];
        assert!(validate_assets(&assets, &expected, false).is_err());
        assets.push(asset(3, "package.json", "manifest", 3));
        assert!(validate_assets(&assets, &expected, false).is_ok());
        assets.push(asset(4, "darwin.tgz", "darwin", 2));
        assert!(validate_assets(&assets, &expected, false).is_err());
        assets.pop();
        assets.push(asset(4, "extra.tgz", "extra", 4));
        assert!(validate_assets(&assets, &expected, true).is_err());
    }
}
