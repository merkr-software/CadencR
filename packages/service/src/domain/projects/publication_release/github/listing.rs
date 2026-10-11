use super::models::{Asset, Release};
use super::state::conflict;
use super::transport::Transport;
use crate::error::AppError;

const MAX_PAGES: u8 = 10;
const PAGE_SIZE: usize = 100;

pub(super) async fn find_release(
    transport: &Transport,
    token: &str,
    repository: &str,
    tag: &str,
) -> Result<Option<Release>, AppError> {
    let mut found = None;
    for page in 1..=MAX_PAGES {
        let releases: Vec<Release> = transport
            .get_json(
                token,
                &format!("/repos/{repository}/releases?per_page={PAGE_SIZE}&page={page}"),
            )
            .await?;
        for release in &releases {
            if release.tag_name == tag {
                if found.is_some() {
                    return Err(conflict("GitHub contains duplicate releases for this tag"));
                }
                found = Some(release.clone());
            }
        }
        if releases.len() < PAGE_SIZE {
            return Ok(found);
        }
    }
    Err(conflict("GitHub release listing exceeded 1000 entries"))
}

pub(super) async fn list_assets(
    transport: &Transport,
    token: &str,
    repository: &str,
    release_id: u64,
) -> Result<Vec<Asset>, AppError> {
    let mut all = Vec::new();
    for page in 1..=MAX_PAGES {
        let page_assets: Vec<Asset> = transport
            .get_json(
                token,
                &format!(
                    "/repos/{repository}/releases/{release_id}/assets?per_page={PAGE_SIZE}&page={page}"
                ),
            )
            .await?;
        let done = page_assets.len() < PAGE_SIZE;
        all.extend(page_assets);
        if done {
            return Ok(all);
        }
    }
    Err(conflict("GitHub asset listing exceeded 1000 entries"))
}

pub(super) async fn get_release(
    transport: &Transport,
    token: &str,
    repository: &str,
    release_id: u64,
) -> Result<Release, AppError> {
    transport
        .get_json(token, &format!("/repos/{repository}/releases/{release_id}"))
        .await
}
