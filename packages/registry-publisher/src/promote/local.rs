use crate::github::Asset;
use crate::PublisherError;

pub(crate) fn require_same_assets(before: &[Asset], after: &[Asset]) -> Result<(), PublisherError> {
    let mut before = before.to_vec();
    let mut after = after.to_vec();
    before.sort_by(|left, right| left.name.cmp(&right.name));
    after.sort_by(|left, right| left.name.cmp(&right.name));
    if before != after {
        return Err(PublisherError::new(
            "release assets changed during publication verification",
        ));
    }
    Ok(())
}

/// Both snapshots must first pass their phase-specific URL validation. GitHub
/// replaces an untagged draft URL on publication; all asset identity stays fixed.
pub(crate) fn require_same_published_assets(
    before: &[Asset],
    after: &[Asset],
) -> Result<(), PublisherError> {
    fn identities(assets: &[Asset]) -> Vec<(u64, &str, &str, u64)> {
        let mut values = assets
            .iter()
            .map(|asset| {
                (
                    asset.id,
                    asset.name.as_str(),
                    asset.state.as_str(),
                    asset.size,
                )
            })
            .collect::<Vec<_>>();
        values.sort_unstable();
        values
    }
    if identities(before) != identities(after) {
        return Err(PublisherError::new(
            "release assets changed during publication verification",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_changes_only_url_not_asset_identity() {
        let draft = Asset {
            id: 7,
            name: "theme.tar.gz".into(),
            state: "uploaded".into(),
            size: 1100,
            browser_download_url: "draft".into(),
        };
        let mut published = draft.clone();
        published.browser_download_url = "final".into();
        assert!(require_same_published_assets(
            std::slice::from_ref(&draft),
            std::slice::from_ref(&published)
        )
        .is_ok());
        assert!(require_same_assets(
            std::slice::from_ref(&draft),
            std::slice::from_ref(&published)
        )
        .is_err());
        for field in ["id", "name", "state", "size"] {
            let mut changed = published.clone();
            match field {
                "id" => changed.id += 1,
                "name" => changed.name.push('x'),
                "state" => changed.state = "new".into(),
                "size" => changed.size += 1,
                _ => unreachable!(),
            }
            assert!(
                require_same_published_assets(std::slice::from_ref(&draft), &[changed]).is_err(),
                "{field}"
            );
        }
        assert!(require_same_published_assets(&[draft], &[]).is_err());
    }
}
