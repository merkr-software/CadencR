use super::listing::{find_release, get_release, list_assets};
use super::models::{Asset, CreateRelease, PublishRelease, Release};
use super::transport::Transport;
use super::{binding_body, inspect_with, validate_segment};
use crate::domain::projects::publication_release::remote::{
    GitHubPublishRequest, GitHubPublishedRelease, GitHubReleaseExpectation,
};
use crate::error::AppError;
use std::collections::HashMap;

struct ExpectedAsset<'a> {
    name: &'a str,
    digest: &'a str,
    size: u64,
}

pub(super) async fn publish(
    transport: &Transport,
    token: &str,
    request: &GitHubPublishRequest<'_>,
) -> Result<GitHubPublishedRelease, AppError> {
    let expectation = GitHubReleaseExpectation::from_request(request);
    validate_request(&expectation)?;
    revalidate_identity(transport, token, &expectation).await?;
    let body = binding_body(request.release_notes, request.binding_sha256);
    let expected = expected_assets(&expectation);
    let mut release = find_release(transport, token, request.repository, request.tag).await?;
    if let Some(found) = &release {
        validate_release(found, &expectation, &body)?;
        let assets = list_assets(transport, token, request.repository, found.id).await?;
        validate_assets(&assets, &expected, found.draft)?;
        if !found.draft {
            return exact_published(transport, token, &expectation, found, true).await;
        }
    } else {
        release = Some(create_or_reconcile(transport, token, request, &expectation, &body).await?);
    }
    let release = release.expect("release is created or found");
    upload_missing(
        transport,
        token,
        request,
        &expectation,
        &release,
        &body,
        &expected,
    )
    .await?;
    revalidate_identity(transport, token, &expectation).await?;
    let current = exact_draft(transport, token, &expectation, &body, release.id, &expected).await?;
    let published = publish_or_reconcile(transport, token, request, current.id).await?;
    validate_release(&published, &expectation, &body)?;
    if published.draft {
        return Err(conflict(
            "GitHub release remained a draft after publication",
        ));
    }
    exact_published(transport, token, &expectation, &published, false).await
}

pub(super) fn validate_request(request: &GitHubReleaseExpectation) -> Result<(), AppError> {
    for (value, label) in [
        (request.tag.as_str(), "release tag"),
        (request.archive_name.as_str(), "archive asset name"),
        (request.metadata_name.as_str(), "metadata asset name"),
    ] {
        validate_segment(value, label)?;
    }
    if request.archive_name == request.metadata_name {
        return Err(AppError::BadRequest(
            "release asset names must be unique".into(),
        ));
    }
    if !is_sha(&request.source_commit)
        || !is_sha(&request.binding_sha256)
        || request.archive_sha256.len() != 64
        || !is_sha(&request.archive_sha256)
        || request.metadata_sha256.len() != 64
        || !is_sha(&request.metadata_sha256)
    {
        return Err(AppError::BadRequest(
            "release commit, binding, and asset digests must be lowercase SHA values".into(),
        ));
    }
    if request.expected_account.trim().is_empty() {
        return Err(AppError::BadRequest(
            "expected GitHub account is required".into(),
        ));
    }
    Ok(())
}

pub(super) async fn revalidate_identity(
    transport: &Transport,
    token: &str,
    request: &GitHubReleaseExpectation,
) -> Result<(), AppError> {
    let actual = inspect_with(transport, token, &request.repository, &request.tag).await?;
    if actual.account != request.expected_account
        || actual.repository_id != request.expected_repository_id
        || actual.tag_commit != request.source_commit
    {
        return Err(conflict(
            "GitHub account, repository identity, or release tag changed since preview",
        ));
    }
    Ok(())
}

async fn create_or_reconcile(
    transport: &Transport,
    token: &str,
    request: &GitHubPublishRequest<'_>,
    expectation: &GitHubReleaseExpectation,
    body: &str,
) -> Result<Release, AppError> {
    let payload = CreateRelease {
        tag_name: request.tag,
        target_commitish: request.source_commit,
        name: request.tag,
        body,
        draft: true,
        prerelease: request.prerelease,
        make_latest: "false",
    };
    let created = transport
        .post_json(
            token,
            &format!("/repos/{}/releases", request.repository),
            &payload,
        )
        .await;
    match created {
        Ok(release) => {
            validate_release(&release, expectation, body)?;
            if !release.draft {
                return Err(conflict("GitHub created a non-draft release unexpectedly"));
            }
            Ok(release)
        }
        Err(original) => {
            let Some(release) =
                find_release(transport, token, request.repository, request.tag).await?
            else {
                return Err(original);
            };
            validate_release(&release, expectation, body)?;
            if !release.draft {
                return Err(original);
            }
            Ok(release)
        }
    }
}

async fn upload_missing(
    transport: &Transport,
    token: &str,
    request: &GitHubPublishRequest<'_>,
    expectation: &GitHubReleaseExpectation,
    release: &Release,
    body: &str,
    expected: &[ExpectedAsset<'_>; 2],
) -> Result<(), AppError> {
    for (asset, bytes) in expected.iter().zip([request.archive, request.metadata]) {
        revalidate_identity(transport, token, expectation).await?;
        let mut assets =
            current_draft_assets(transport, token, expectation, body, release.id, expected).await?;
        if assets.iter().any(|found| found.name == asset.name) {
            continue;
        }
        let result = transport
            .upload(token, request.repository, release.id, asset.name, bytes)
            .await;
        if result.is_err() {
            assets = list_assets(transport, token, request.repository, release.id).await?;
            if !assets.iter().any(|found| found.name == asset.name) {
                return result.map(|_| ());
            }
        }
        assets = list_assets(transport, token, request.repository, release.id).await?;
        validate_assets(&assets, expected, true)?;
    }
    Ok(())
}

async fn current_draft_assets(
    transport: &Transport,
    token: &str,
    request: &GitHubReleaseExpectation,
    body: &str,
    release_id: u64,
    expected: &[ExpectedAsset<'_>; 2],
) -> Result<Vec<Asset>, AppError> {
    let release = get_release(transport, token, &request.repository, release_id).await?;
    validate_release(&release, request, body)?;
    if release.id != release_id || !release.draft {
        return Err(conflict("GitHub draft identity or state changed"));
    }
    let assets = list_assets(transport, token, &request.repository, release.id).await?;
    validate_assets(&assets, expected, true)?;
    Ok(assets)
}

async fn exact_draft(
    transport: &Transport,
    token: &str,
    request: &GitHubReleaseExpectation,
    body: &str,
    release_id: u64,
    expected: &[ExpectedAsset<'_>; 2],
) -> Result<Release, AppError> {
    let release = get_release(transport, token, &request.repository, release_id).await?;
    validate_release(&release, request, body)?;
    if release.id != release_id || !release.draft {
        return Err(conflict("GitHub draft identity or state changed"));
    }
    let assets = list_assets(transport, token, &request.repository, release.id).await?;
    validate_assets(&assets, expected, false)?;
    Ok(release)
}

async fn publish_or_reconcile(
    transport: &Transport,
    token: &str,
    request: &GitHubPublishRequest<'_>,
    release_id: u64,
) -> Result<Release, AppError> {
    let payload = PublishRelease {
        draft: false,
        make_latest: "false",
    };
    let result = transport
        .patch_json(
            token,
            &format!("/repos/{}/releases/{release_id}", request.repository),
            &payload,
        )
        .await;
    match result {
        Ok(release) => Ok(release),
        Err(original) => {
            let Some(release) =
                find_release(transport, token, request.repository, request.tag).await?
            else {
                return Err(original);
            };
            if release.id == release_id && !release.draft {
                Ok(release)
            } else {
                Err(original)
            }
        }
    }
}

pub(super) async fn exact_published(
    transport: &Transport,
    token: &str,
    request: &GitHubReleaseExpectation,
    release: &Release,
    already_published: bool,
) -> Result<GitHubPublishedRelease, AppError> {
    revalidate_identity(transport, token, request).await?;
    let current = get_release(transport, token, &request.repository, release.id).await?;
    validate_release(
        &current,
        request,
        &super::binding_body(&request.release_notes, &request.binding_sha256),
    )?;
    if current.id != release.id || current.draft {
        return Err(conflict(
            "GitHub published release identity or state changed",
        ));
    }
    let expected = expected_assets(request);
    let assets = list_assets(transport, token, &request.repository, current.id).await?;
    validate_assets(&assets, &expected, false)?;
    Ok(GitHubPublishedRelease {
        release_url: format!(
            "https://github.com/{}/releases/tag/{}",
            request.repository, request.tag
        ),
        already_published,
    })
}

pub(super) fn validate_release(
    release: &Release,
    request: &GitHubReleaseExpectation,
    body: &str,
) -> Result<(), AppError> {
    if release.tag_name != request.tag
        || release.target_commitish != request.source_commit
        || release.name.as_deref() != Some(request.tag.as_str())
        || release.body.as_deref() != Some(body)
        || release.prerelease != request.prerelease
    {
        return Err(conflict(
            "GitHub release exists but does not match the confirmed publication binding",
        ));
    }
    Ok(())
}

fn validate_assets(
    assets: &[Asset],
    expected: &[ExpectedAsset<'_>; 2],
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

fn expected_assets(request: &GitHubReleaseExpectation) -> [ExpectedAsset<'_>; 2] {
    [
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
    ]
}

pub(super) fn is_sha(value: &str) -> bool {
    (value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        || value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn conflict(message: &str) -> AppError {
    AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "PUBLICATION_RELEASE_CONFLICT",
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_verification_requires_github_digest() {
        let expected = [
            ExpectedAsset {
                name: "provider.tar.gz",
                digest: "a",
                size: 7,
            },
            ExpectedAsset {
                name: "package.json",
                digest: "b",
                size: 8,
            },
        ];
        let assets = [Asset {
            id: 1,
            name: "provider.tar.gz".into(),
            size: 7,
            state: "uploaded".into(),
            digest: None,
        }];
        assert!(validate_assets(&assets, &expected, true).is_err());
    }
}
