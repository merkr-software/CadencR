use crate::binding::PublicationPrebinding;
use crate::github::{Asset, ReleaseClient};
use crate::mirror::artifacts::{validated_metadata, AssetMetadata};
use crate::PublisherError;

pub(super) fn inspect(
    binding: &PublicationPrebinding,
    registry_commit: &str,
    prior_id: Option<u64>,
    client: &impl ReleaseClient,
) -> Result<u64, PublisherError> {
    let release = client
        .find_release(&binding.tag)?
        .ok_or_else(|| PublisherError::new("published release is required but missing"))?;
    if !crate::binding::valid_release_id(release.id) {
        return Err(PublisherError::new("release id is invalid"));
    }
    let expected_id = prior_id.unwrap_or(release.id);
    crate::mirror::release::validate_published_release(
        &release,
        &binding.tag,
        registry_commit,
        &binding.body,
        expected_id,
    )?;
    validate_assets(client.list_assets(release.id)?, binding)?;
    crate::promote::verify_exact_tag(
        client,
        &binding.tag,
        registry_commit,
        "before restore staging",
    )?;
    Ok(release.id)
}

fn validate_assets(
    assets: Vec<Asset>,
    binding: &PublicationPrebinding,
) -> Result<(), PublisherError> {
    let metadata = binding
        .expected
        .iter()
        .map(|artifact| AssetMetadata {
            name: &artifact.name,
            size: artifact.size,
            expected_url: &artifact.expected_url,
        })
        .collect::<Vec<_>>();
    let assets = validated_metadata(assets, &metadata, true)?;
    let mut total = 0_u64;
    for expected in &binding.expected {
        let asset = assets
            .iter()
            .find(|asset| asset.name == expected.name)
            .expect("complete metadata-validated asset set");
        if expected.size.is_none() {
            if asset.size > crate::stage::MAX_ARCHIVE_BYTES {
                return Err(PublisherError::new(
                    "managed staging artifact exceeds 256 MiB",
                ));
            }
            total = total
                .checked_add(asset.size)
                .ok_or_else(|| PublisherError::new("managed staging exceeds the 1 GiB budget"))?;
            if total > crate::stage::MAX_MANAGED_BYTES {
                return Err(PublisherError::new(
                    "managed staging exceeds the 1 GiB budget",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binding::build_publication_prebinding;
    use crate::recover::fixture::{published, COMMIT, REPOSITORY};

    #[test]
    fn initial_release_inspection_rejects_every_unpublished_or_unbound_state() {
        for mode in 0..11 {
            let (_root, submission, client, _) = published();
            let plan =
                cadencr_registry_core::create_publication_plan_from_file(&submission, REPOSITORY)
                    .unwrap();
            let binding = build_publication_prebinding(&plan, REPOSITORY, COMMIT).unwrap();
            match mode {
                0 => *client.release.borrow_mut() = None,
                1 => client.release.borrow_mut().as_mut().unwrap().draft = true,
                2 => client.release.borrow_mut().as_mut().unwrap().prerelease = true,
                3 => client.release.borrow_mut().as_mut().unwrap().id = 0,
                4 => client.release.borrow_mut().as_mut().unwrap().tag_name = "other".into(),
                5 => {
                    client
                        .release
                        .borrow_mut()
                        .as_mut()
                        .unwrap()
                        .target_commitish = "c".repeat(40)
                }
                6 => client.release.borrow_mut().as_mut().unwrap().body = "other".into(),
                7 => {
                    client.assets.borrow_mut().pop();
                }
                8 => client.assets.borrow_mut()[0].0.state = "new".into(),
                9 => {
                    client.assets.borrow_mut()[0].0.browser_download_url =
                        "https://github.com/author/source".into()
                }
                10 => client.assets.borrow_mut()[0].0.size = crate::stage::MAX_ARCHIVE_BYTES + 1,
                _ => unreachable!(),
            }
            assert!(
                inspect(&binding, COMMIT, None, &client).is_err(),
                "mode {mode}"
            );
        }
    }

    #[test]
    fn remote_archive_metadata_budget_includes_every_target_but_not_provenance() {
        let (_root, submission, client, _) = published();
        let plan =
            cadencr_registry_core::create_publication_plan_from_file(&submission, REPOSITORY)
                .unwrap();
        for count in [4, 5] {
            let mut binding = build_publication_prebinding(&plan, REPOSITORY, COMMIT).unwrap();
            let template = binding.expected[0].clone();
            let provenance = binding.expected.pop().unwrap();
            binding.expected.clear();
            let mut assets = Vec::new();
            for index in 0..count {
                let mut expected = template.clone();
                expected.name = format!("archive-{index}");
                expected.expected_url = format!(
                    "https://github.com/cadencr/registry/releases/download/tag/archive-{index}"
                );
                assets.push(Asset {
                    id: index + 1,
                    name: expected.name.clone(),
                    state: "uploaded".into(),
                    browser_download_url: expected.expected_url.clone(),
                    size: crate::stage::MAX_ARCHIVE_BYTES,
                });
                binding.expected.push(expected);
            }
            assets.push(client.assets.borrow().last().unwrap().0.clone());
            binding.expected.push(provenance);
            assert_eq!(validate_assets(assets, &binding).is_ok(), count == 4);
        }
    }
}
