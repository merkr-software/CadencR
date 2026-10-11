use std::fs::{File, OpenOptions};
use std::io::Read as _;
use std::path::Path;
use std::sync::OnceLock;

use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, USER_AGENT};
use reqwest::StatusCode;

use super::request::{authorization, http_client, API_VERSION, USER_AGENT_VALUE};
use super::validation::{error, id, text, MAX_ASSET_BYTES, MAX_JSON_BYTES};
use super::Asset;
use crate::fs::Identity;
use crate::PublisherError;

pub(super) struct Uploader {
    client: OnceLock<Result<Client, PublisherError>>,
    base: String,
    authorization: reqwest::header::HeaderValue,
}

impl Uploader {
    pub(super) fn production(token: &str) -> Result<Self, PublisherError> {
        Self::build(token, "https://uploads.github.com".into())
    }

    #[cfg(test)]
    pub(super) fn fixture(token: &str, base: String) -> Result<Self, PublisherError> {
        Self::build(token, base)
    }

    fn build(token: &str, base: String) -> Result<Self, PublisherError> {
        let authorization = authorization(token)?;
        Ok(Self {
            client: OnceLock::new(),
            base,
            authorization,
        })
    }

    pub(super) fn upload(
        &self,
        repository: &str,
        release_id: u64,
        name: &str,
        path: &Path,
        size: u64,
    ) -> Result<Asset, PublisherError> {
        validate_upload(release_id, name, size)?;
        let before = std::fs::symlink_metadata(path)
            .map_err(|error| PublisherError::io("inspect GitHub upload file", error))?;
        if !before.file_type().is_file() || before.len() != size {
            return Err(error("GitHub upload file is invalid or has the wrong size"));
        }
        let file = open_nofollow(path)?;
        let opened = file
            .metadata()
            .map_err(|error| PublisherError::io("inspect opened GitHub upload file", error))?;
        let identity = Identity::from_metadata(&before);
        if !opened.is_file() || !identity.matches(&opened) || opened.len() != size {
            return Err(error("GitHub upload file changed"));
        }
        let response = self.send(repository, release_id, name, size, file)?;
        let after = std::fs::symlink_metadata(path)
            .map_err(|error| PublisherError::io("reinspect GitHub upload file", error))?;
        if !after.is_file() || !identity.matches(&after) || after.len() != size {
            return Err(error("GitHub upload file changed"));
        }
        super::model::decode_asset_response(response)
    }

    fn send(
        &self,
        repository: &str,
        release_id: u64,
        name: &str,
        size: u64,
        file: File,
    ) -> Result<reqwest::blocking::Response, PublisherError> {
        let encoded = url::form_urlencoded::byte_serialize(name.as_bytes()).collect::<String>();
        let url = format!(
            "{}/repos/{repository}/releases/{release_id}/assets?name={encoded}",
            self.base
        );
        let response = self
            .client
            .get_or_init(http_client)
            .as_ref()
            .map_err(Clone::clone)?
            .post(url)
            .header(ACCEPT, "application/vnd.github+json")
            .header(AUTHORIZATION, self.authorization.clone())
            .header(CONTENT_TYPE, "application/octet-stream")
            .header(CONTENT_LENGTH, size)
            .header("x-github-api-version", API_VERSION)
            .header(USER_AGENT, USER_AGENT_VALUE)
            .body(reqwest::blocking::Body::sized(file.take(size), size))
            .send()
            .map_err(|_| error("GitHub upload failed"))?;
        if response.status() != StatusCode::CREATED {
            return Err(error(format!(
                "GitHub upload failed with status {}",
                response.status().as_u16()
            )));
        }
        if response
            .content_length()
            .is_some_and(|value| value > MAX_JSON_BYTES)
        {
            return Err(error("GitHub API response exceeds 2 MiB"));
        }
        Ok(response)
    }
}

fn validate_upload(release_id: u64, name: &str, size: u64) -> Result<(), PublisherError> {
    id(release_id, "release id")?;
    text(name, "asset name")?;
    if name.contains(['/', '\\']) {
        return Err(error("GitHub asset name is invalid"));
    }
    if size > MAX_ASSET_BYTES {
        return Err(error("GitHub upload size is invalid"));
    }
    Ok(())
}

fn open_nofollow(path: &Path) -> Result<File, PublisherError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(
        &mut options,
        libc::O_NOFOLLOW | libc::O_NONBLOCK,
    );
    options
        .open(path)
        .map_err(|error| PublisherError::io("open GitHub upload file", error))
}

#[cfg(test)]
mod tests {
    use super::super::fixture::serve_json;
    use super::*;

    #[test]
    fn upload_is_sized_and_authenticated_with_encoded_name() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("asset");
        std::fs::write(&path, b"abc").unwrap();
        let body = r#"{"id":1,"name":"asset name","state":"uploaded","browser_download_url":"https://github.com/acme/releases/releases/download/v1/a","size":3}"#;
        let (base, server) = serve_json("201 Created", body);
        let uploader = Uploader::fixture("secret", base).unwrap();
        assert!(uploader.client.get().is_none());
        uploader
            .upload("acme/releases", 1, "asset name", &path, 3)
            .unwrap();
        assert!(uploader.client.get().is_some());
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /repos/acme/releases/releases/1/assets?name=asset+name"));
        assert!(request.contains("authorization: Bearer secret"));
        assert!(request.contains("content-length: 3"));
        assert!(request.ends_with("abc"));
    }

    #[test]
    fn unsafe_or_wrong_sized_sources_fail_before_network() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("file");
        std::fs::write(&file, b"abc").unwrap();
        let uploader = Uploader::fixture("secret", "http://127.0.0.1:1".into()).unwrap();
        assert!(uploader.upload("acme/releases", 1, "a", &file, 2).is_err());
        assert!(uploader.client.get().is_none());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = directory.path().join("link");
            symlink(&file, &link).unwrap();
            assert!(uploader.upload("acme/releases", 1, "a", &link, 3).is_err());
            let fifo = directory.path().join("fifo");
            let path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            assert!(uploader.upload("acme/releases", 1, "a", &fifo, 0).is_err());
        }
    }
}
