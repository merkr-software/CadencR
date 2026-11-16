mod asset_url;
pub(crate) use asset_url::AssetUrlPolicy;
pub(crate) mod discovery;
mod model;
mod release_lookup;
mod request;
mod tag;
mod upload;
mod validation;
use serde::Deserialize;
use std::path::Path;
use std::time::Instant;

use model::{validate_asset, DraftBody, RawAsset, RawRelease};
use request::{AssetResponse, Requester};
use upload::Uploader;
use validation::{error, id, text};

use crate::{DownloadRequest, PublisherError};

const PAGE_SIZE: usize = 100;
const MAX_PAGES: usize = 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Release {
    pub(crate) id: u64,
    pub(crate) draft: bool,
    pub(crate) prerelease: bool,
    pub(crate) tag_name: String,
    pub(crate) target_commitish: String,
    pub(crate) body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Asset {
    pub(crate) id: u64,
    pub(crate) name: String,
    pub(crate) state: String,
    pub(crate) browser_download_url: String,
    pub(crate) size: u64,
}

#[derive(bon::Builder)]
pub(crate) struct CreateDraftRequest<'a> {
    pub(crate) tag: &'a str,
    pub(crate) commit: &'a str,
    pub(crate) body: &'a str,
}

#[derive(bon::Builder)]
pub(crate) struct UploadAssetRequest<'a> {
    pub(crate) release_id: u64,
    pub(crate) name: &'a str,
    pub(crate) file: &'a Path,
    pub(crate) size: u64,
}

#[derive(bon::Builder)]
pub(crate) struct VerifyAssetRequest<'a> {
    #[builder(default)]
    pub(crate) url_policy: AssetUrlPolicy,
    pub(crate) asset: &'a Asset,
    pub(crate) expected_url: &'a str,
    pub(crate) sha256: &'a str,
    pub(crate) size: u64,
    pub(crate) output: &'a Path,
}

pub(crate) trait ReleaseClient {
    fn get_tag_commit(&self, tag: &str) -> Result<Option<String>, PublisherError>;
    /// Like [`Self::get_tag_commit`], every request bounded by `deadline`.
    fn get_tag_commit_before(
        &self,
        tag: &str,
        deadline: Instant,
    ) -> Result<Option<String>, PublisherError> {
        request::check_deadline(Some(deadline))?;
        let result = self.get_tag_commit(tag);
        request::check_deadline(Some(deadline))?;
        result
    }
    fn find_release(&self, tag: &str) -> Result<Option<Release>, PublisherError>;
    fn get_release(&self, release_id: u64) -> Result<Option<Release>, PublisherError>;
    fn create_draft(&self, request: CreateDraftRequest<'_>) -> Result<Release, PublisherError>;
    fn list_assets(&self, release_id: u64) -> Result<Vec<Asset>, PublisherError>;
    /// Like [`Self::list_assets`], every request bounded by `deadline`.
    fn list_assets_before(
        &self,
        release_id: u64,
        deadline: Instant,
    ) -> Result<Vec<Asset>, PublisherError> {
        request::check_deadline(Some(deadline))?;
        let result = self.list_assets(release_id);
        request::check_deadline(Some(deadline))?;
        result
    }
    fn upload_asset(&self, request: UploadAssetRequest<'_>) -> Result<Asset, PublisherError>;
    fn verify_asset(&self, request: VerifyAssetRequest<'_>) -> Result<(), PublisherError>;
    fn publish_draft(&self, release_id: u64) -> Result<Release, PublisherError>;
}

pub(crate) struct GitHubClient {
    repository: String,
    request: Requester,
    uploader: Uploader,
    downloader: crate::download::ProductionDownloader,
}

impl GitHubClient {
    pub(crate) fn new(repository: &str, token: &str) -> Result<Self, PublisherError> {
        validation::configuration(repository, token)?;
        Ok(Self {
            repository: repository.into(),
            request: Requester::production(token)?,
            uploader: Uploader::production(token)?,
            downloader: Default::default(),
        })
    }

    #[cfg(test)]
    pub(crate) fn fixture(
        repository: &str,
        token: &str,
        api: String,
        uploads: String,
    ) -> Result<Self, PublisherError> {
        validation::configuration(repository, token)?;
        Ok(Self {
            repository: repository.into(),
            request: Requester::fixture(token, api)?,
            uploader: Uploader::fixture(token, uploads)?,
            downloader: Default::default(),
        })
    }
}

impl GitHubClient {
    fn tag_commit(
        &self,
        tag: &str,
        deadline: Option<Instant>,
    ) -> Result<Option<String>, PublisherError> {
        text(tag, "release tag")?;
        let encoded = url::form_urlencoded::byte_serialize(tag.as_bytes())
            .collect::<String>()
            .replace('+', "%20");
        let Some(reference) = self
            .request
            .get_optional_with_deadline::<model::RawTagReference>(
                &format!("/repos/{}/git/ref/tags/{encoded}", self.repository),
                deadline,
            )?
        else {
            return Ok(None);
        };
        let mut target = reference.validate(tag)?;
        let mut visited = std::collections::HashSet::new();
        while target.kind == "tag" {
            if visited.len() >= 5 {
                return Err(error("GitHub annotated tag chain limit exceeded"));
            }
            if !visited.insert(target.sha.clone()) {
                return Err(error("GitHub annotated tag cycle detected"));
            }
            let annotated: model::RawAnnotatedTag = self.request.get_with_deadline(
                &format!("/repos/{}/git/tags/{}", self.repository, target.sha),
                deadline,
            )?;
            target = annotated.validate(&target.sha)?;
        }
        Ok(Some(target.sha))
    }

    fn assets(
        &self,
        release_id: u64,
        deadline: Option<Instant>,
    ) -> Result<Vec<Asset>, PublisherError> {
        id(release_id, "release id")?;
        self.paged_before::<RawAsset>(
            "asset",
            &format!("/repos/{}/releases/{release_id}/assets", self.repository),
            deadline,
        )?
        .into_iter()
        .map(Asset::try_from)
        .collect()
    }
}

impl ReleaseClient for GitHubClient {
    fn get_tag_commit(&self, tag: &str) -> Result<Option<String>, PublisherError> {
        self.tag_commit(tag, None)
    }

    fn get_tag_commit_before(
        &self,
        tag: &str,
        deadline: Instant,
    ) -> Result<Option<String>, PublisherError> {
        request::check_deadline(Some(deadline))?;
        let result = self.tag_commit(tag, Some(deadline));
        request::check_deadline(Some(deadline))?;
        result
    }

    fn find_release(&self, tag: &str) -> Result<Option<Release>, PublisherError> {
        text(tag, "release tag")?;
        let raw: Vec<RawRelease> =
            self.paged("release", &format!("/repos/{}/releases", self.repository))?;
        for release in &raw {
            release.validate_list_entry()?;
        }
        let mut matches = raw.into_iter().filter(|release| release.matches_tag(tag));
        let found = matches.next();
        if matches.next().is_some() {
            return Err(error("GitHub release tag is duplicated"));
        }
        found.map(Release::try_from).transpose()
    }

    fn get_release(&self, release_id: u64) -> Result<Option<Release>, PublisherError> {
        self.release_by_id(release_id)
    }

    fn create_draft(&self, request: CreateDraftRequest<'_>) -> Result<Release, PublisherError> {
        text(request.tag, "release tag")?;
        crate::validate_registry_commit(request.commit)?;
        let body = DraftBody {
            tag_name: request.tag,
            target_commitish: request.commit,
            body: request.body,
            name: request.tag,
            draft: true,
            prerelease: false,
            make_latest: "false",
        };
        let raw: RawRelease = self
            .request
            .post(&format!("/repos/{}/releases", self.repository), &body)?;
        Release::try_from(raw)
    }

    fn list_assets(&self, release_id: u64) -> Result<Vec<Asset>, PublisherError> {
        self.assets(release_id, None)
    }

    fn list_assets_before(
        &self,
        release_id: u64,
        deadline: Instant,
    ) -> Result<Vec<Asset>, PublisherError> {
        request::check_deadline(Some(deadline))?;
        let result = self.assets(release_id, Some(deadline));
        request::check_deadline(Some(deadline))?;
        result
    }

    fn upload_asset(&self, request: UploadAssetRequest<'_>) -> Result<Asset, PublisherError> {
        self.uploader.upload(
            &self.repository,
            request.release_id,
            request.name,
            request.file,
            request.size,
        )
    }

    fn verify_asset(&self, request: VerifyAssetRequest<'_>) -> Result<(), PublisherError> {
        validate_asset(request.asset)?;
        if !request
            .url_policy
            .matches(&request.asset.browser_download_url, request.expected_url)
        {
            return Err(error("GitHub asset URL does not match"));
        }
        if request.asset.size != request.size {
            return Err(error("GitHub asset size does not match"));
        }
        crate::download::validate_asset_expectations(request.expected_url, request.sha256)?;
        let response = self.request.asset_response(&format!(
            "/repos/{}/releases/assets/{}",
            self.repository, request.asset.id
        ))?;
        let download = DownloadRequest {
            url: request.expected_url,
            sha256: request.sha256,
            output: request.output.into(),
            max_bytes: request.size,
        };
        let downloaded = match response {
            AssetResponse::Bytes(response) => {
                crate::download::download_authenticated_asset(response, download)?
            }
            AssetResponse::Redirect(location) => {
                self.downloader.redirected_asset(&location, download)?
            }
        };
        if downloaded.size != request.size {
            return Err(error("GitHub asset size does not match"));
        }
        Ok(())
    }

    fn publish_draft(&self, release_id: u64) -> Result<Release, PublisherError> {
        id(release_id, "release id")?;
        let raw: RawRelease = self.request.patch(
            &format!("/repos/{}/releases/{release_id}", self.repository),
            &model::PublishBody {
                draft: false,
                make_latest: "false",
            },
        )?;
        Release::try_from(raw)
    }
}

#[cfg(test)]
pub(crate) mod fixture;

#[cfg(test)]
mod tests {
    use super::fixture::{client, serve_json, serve_many};
    use super::*;
    #[test]
    fn duplicate_release_tags_are_refused_and_pagination_is_bounded() {
        let release = r#"{"id":1,"draft":true,"prerelease":false,"tag_name":"v1","target_commitish":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","body":"notes"}"#;
        let unrelated = r#"{"id":2,"draft":false,"prerelease":false,"tag_name":"old","target_commitish":"a","body":null}"#;
        let body = format!("[{unrelated},{release},{release}]");
        let (api, observed) = serve_json("200 OK", &body);
        let error = client(api).find_release("v1").unwrap_err().to_string();
        assert!(error.contains("duplicated"));
        let request = observed.join().unwrap();
        assert!(request.contains("per_page=100&page=1"));
        assert!(request.contains("authorization: Bearer secret-token"));
        let (api, _) = serve_json("200 OK", r#"[{"id":0,"tag_name":"old"}]"#);
        assert!(client(api).find_release("v1").is_err());
    }
    #[test]
    fn draft_creation_requires_201_and_sends_bound_fields() {
        let body = r#"{"id":7,"draft":true,"prerelease":false,"tag_name":"v1","target_commitish":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","body":"notes"}"#;
        let (api, observed) = serve_json("201 Created", body);
        let release = client(api)
            .create_draft(
                CreateDraftRequest::builder()
                    .tag("v1")
                    .commit("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                    .body("notes")
                    .build(),
            )
            .unwrap();
        assert_eq!(release.id, 7);
        let request = observed.join().unwrap();
        assert!(request.starts_with("POST /repos/acme/releases/releases HTTP/1.1"));
        assert!(request.contains("\"make_latest\":\"false\""));
        assert!(request.contains("\"draft\":true"));
        let (api, _) = serve_json("200 OK", "abc");
        let client = client(api);
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("asset");
        let asset = Asset {
            id: 1,
            name: "a".into(),
            state: "uploaded".into(),
            browser_download_url: "https://github.com/acme/releases/releases/download/v1/a".into(),
            size: 3,
        };
        client
            .verify_asset(
                VerifyAssetRequest::builder()
                    .asset(&asset)
                    .expected_url(&asset.browser_download_url)
                    .sha256("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
                    .size(3)
                    .output(&output)
                    .build(),
            )
            .unwrap();
        assert_eq!(std::fs::read(output).unwrap(), b"abc");
    }
    #[test]
    fn validation_rejects_unsafe_ids_assets_and_configuration() {
        assert!(GitHubClient::new("bad", "token").is_err());
        assert!(GitHubClient::new("acme/registry-", "token").is_ok());
        assert!(GitHubClient::new("acme/registry_", "token").is_ok());
        assert!(GitHubClient::new("acme/releases", "bad\ntoken").is_err());
        let asset = Asset {
            id: 0,
            name: "archive.tgz".into(),
            state: "uploaded".into(),
            browser_download_url: "https://github.com/acme/releases/releases/download/v1/a".into(),
            size: 1,
        };
        assert!(validate_asset(&asset).is_err());
        assert!(id(9_007_199_254_740_992, "asset id").is_err());
        assert!(
            crate::validate_registry_commit("a234567890123456789012345678901234567890").is_ok()
        );
        assert!(
            crate::validate_registry_commit("A234567890123456789012345678901234567890").is_err()
        );
    }
    #[test]
    fn tag_lookup_handles_missing_direct_annotated_wrong_type_and_depth() {
        let (api, _) = serve_json("404 Not Found", "missing");
        assert_eq!(client(api).get_tag_commit("v1").unwrap(), None);
        let commit = "a".repeat(40);
        let direct =
            format!(r#"{{"ref":"refs/tags/v1","object":{{"type":"commit","sha":"{commit}"}}}}"#);
        let (api, _) = serve_json("200 OK", &direct);
        assert_eq!(
            client(api).get_tag_commit("v1").unwrap(),
            Some(commit.clone())
        );
        let tag = "b".repeat(40);
        let reference =
            format!(r#"{{"ref":"refs/tags/v1","object":{{"type":"tag","sha":"{tag}"}}}}"#);
        let annotated =
            format!(r#"{{"sha":"{tag}","object":{{"type":"commit","sha":"{commit}"}}}}"#);
        assert_eq!(
            client(serve_many(vec![reference.clone(), annotated]))
                .get_tag_commit("v1")
                .unwrap(),
            Some(commit)
        );
        let wrong = format!(
            r#"{{"ref":"refs/tags/v1","object":{{"type":"tree","sha":"{}"}}}}"#,
            "c".repeat(40)
        );
        let (api, _) = serve_json("200 OK", &wrong);
        assert!(client(api).get_tag_commit("v1").is_err());
        let mut chain = vec![reference];
        for index in 0..5_u8 {
            let sha = if index == 0 {
                tag.clone()
            } else {
                format!("{:040x}", index)
            };
            let next = format!("{:040x}", index + 1);
            chain.push(format!(
                r#"{{"sha":"{sha}","object":{{"type":"tag","sha":"{next}"}}}}"#
            ));
        }
        let failure = client(serve_many(chain)).get_tag_commit("v1").unwrap_err();
        assert!(failure.to_string().contains("limit"), "{failure}");
    }
}
