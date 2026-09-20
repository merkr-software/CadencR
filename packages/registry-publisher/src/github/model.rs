use std::io::Read as _;

use serde::{Deserialize, Serialize};

use super::validation::{error, id, text, MAX_ASSET_BYTES, MAX_JSON_BYTES};
use super::{Asset, PublisherError, Release};

#[derive(Deserialize)]
pub(super) struct RawTagReference {
    r#ref: String,
    object: RawTagTarget,
}

impl RawTagReference {
    pub(super) fn validate(self, tag: &str) -> Result<RawTagTarget, PublisherError> {
        if self.r#ref != format!("refs/tags/{tag}") {
            return Err(error("GitHub tag reference does not match"));
        }
        self.object.validate()
    }
}

#[derive(Deserialize)]
pub(super) struct RawAnnotatedTag {
    sha: String,
    object: RawTagTarget,
}

impl RawAnnotatedTag {
    pub(super) fn validate(self, expected: &str) -> Result<RawTagTarget, PublisherError> {
        if self.sha != expected {
            return Err(error("GitHub annotated tag does not match"));
        }
        self.object.validate()
    }
}

#[derive(Deserialize)]
pub(super) struct RawTagTarget {
    #[serde(rename = "type")]
    pub(super) kind: String,
    pub(super) sha: String,
}

impl RawTagTarget {
    fn validate(self) -> Result<Self, PublisherError> {
        if crate::validate_registry_commit(&self.sha).is_err()
            || !matches!(self.kind.as_str(), "commit" | "tag")
        {
            return Err(error("GitHub tag target is malformed"));
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
pub(super) struct RawRelease {
    id: u64,
    draft: Option<bool>,
    prerelease: Option<bool>,
    tag_name: String,
    target_commitish: Option<String>,
    body: Option<String>,
}

impl RawRelease {
    pub(super) fn validate_list_entry(&self) -> Result<(), PublisherError> {
        id(self.id, "release id")?;
        text(&self.tag_name, "release tag")
    }

    pub(super) fn matches_tag(&self, tag: &str) -> bool {
        self.tag_name == tag
    }
}

impl TryFrom<RawRelease> for Release {
    type Error = PublisherError;

    fn try_from(value: RawRelease) -> Result<Self, Self::Error> {
        value.validate_list_entry()?;
        let (Some(draft), Some(prerelease), Some(target_commitish), Some(body)) = (
            value.draft,
            value.prerelease,
            value.target_commitish,
            value.body,
        ) else {
            return Err(error("GitHub release response is malformed"));
        };
        if target_commitish.is_empty() {
            return Err(error("GitHub release response is malformed"));
        }
        Ok(Self {
            id: value.id,
            draft,
            prerelease,
            tag_name: value.tag_name,
            target_commitish,
            body,
        })
    }
}

#[derive(Deserialize)]
pub(super) struct RawAsset {
    id: u64,
    name: String,
    state: String,
    browser_download_url: String,
    size: u64,
}

impl TryFrom<RawAsset> for Asset {
    type Error = PublisherError;

    fn try_from(value: RawAsset) -> Result<Self, Self::Error> {
        let asset = Self {
            id: value.id,
            name: value.name,
            state: value.state,
            browser_download_url: value.browser_download_url,
            size: value.size,
        };
        validate_asset(&asset)?;
        Ok(asset)
    }
}

pub(super) fn validate_asset(asset: &Asset) -> Result<(), PublisherError> {
    id(asset.id, "asset id")?;
    text(&asset.name, "asset name")?;
    if asset.state != "uploaded"
        || asset.browser_download_url.is_empty()
        || asset.size > MAX_ASSET_BYTES
    {
        return Err(error("GitHub asset is malformed"));
    }
    Ok(())
}

#[derive(Serialize)]
pub(super) struct DraftBody<'a> {
    pub(super) tag_name: &'a str,
    pub(super) target_commitish: &'a str,
    pub(super) body: &'a str,
    pub(super) name: &'a str,
    pub(super) draft: bool,
    pub(super) prerelease: bool,
    pub(super) make_latest: &'a str,
}

#[derive(Serialize)]
pub(super) struct PublishBody<'a> {
    pub(super) draft: bool,
    pub(super) make_latest: &'a str,
}

pub(super) fn decode_asset_response(
    response: reqwest::blocking::Response,
) -> Result<Asset, PublisherError> {
    let mut bytes = Vec::new();
    response
        .take(MAX_JSON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("GitHub API response could not be read"))?;
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Err(error("GitHub API response exceeds 2 MiB"));
    }
    let raw = serde_json::from_slice::<RawAsset>(&bytes)
        .map_err(|_| error("GitHub API returned malformed JSON"))?;
    Asset::try_from(raw)
}
