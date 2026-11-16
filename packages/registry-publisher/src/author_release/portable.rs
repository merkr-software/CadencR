//! Portable original-author requests. Metadata is opaque release documentation,
//! not a validated registry package, signed submission, or publication authority.
use super::{ArchiveFile, Error, GitHubArchive, GitHubPublishRequest, GitHubPublishedRelease};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

const REQUEST_LIMIT: u64 = 64 * 1024;
const ARCHIVE_LIMIT: u64 = 256 * 1024 * 1024;
const METADATA_LIMIT: u64 = 1024 * 1024;
const TOTAL_LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorReleaseAsset {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorReleaseRequest {
    pub schema_version: u64,
    pub repository: String,
    pub expected_repository_id: u64,
    pub expected_account: String,
    pub tag: String,
    pub source_commit: String,
    pub release_notes: String,
    pub prerelease: bool,
    pub archive: AuthorReleaseAsset,
    pub metadata: AuthorReleaseAsset,
    #[serde(default)]
    pub additional_archives: Vec<AuthorReleaseAsset>,
}

/// Owns reviewed metadata and open content-bound sources; no credentials or paths.
pub struct PreparedAuthorRelease {
    request: AuthorReleaseRequest,
    request_sha256: String,
    archive: ArchiveFile,
    metadata_file: ArchiveFile,
    metadata: bytes::Bytes,
    additional_archives: Vec<GitHubArchive>,
}

impl PreparedAuthorRelease {
    pub fn request(&self) -> &AuthorReleaseRequest {
        &self.request
    }
    pub fn request_sha256(&self) -> &str {
        &self.request_sha256
    }
    pub fn confirm(&self, digest: &str) -> Result<(), Error> {
        if digest != self.request_sha256 {
            return Err(invalid());
        }
        Ok(())
    }
    /// Recheck every opened source before the caller obtains credentials.
    pub async fn revalidate(&self) -> Result<(), Error> {
        self.archive.verify().await?;
        self.metadata_file.verify().await?;
        for archive in &self.additional_archives {
            archive.file.verify().await?;
        }
        Ok(())
    }
    pub async fn publish(&self, token: &str) -> Result<GitHubPublishedRelease, Error> {
        self.revalidate().await?;
        super::publish_publication_release(token, self.engine_request()).await
    }
    fn engine_request(&self) -> GitHubPublishRequest<'_> {
        let r = &self.request;
        GitHubPublishRequest::builder()
            .repository(&r.repository)
            .tag(&r.tag)
            .source_commit(&r.source_commit)
            .release_notes(&r.release_notes)
            .prerelease(r.prerelease)
            .archive_name(&r.archive.name)
            .archive_file(&self.archive)
            .archive_sha256(&r.archive.sha256)
            .metadata_name(&r.metadata.name)
            .metadata(&self.metadata)
            .metadata_sha256(&r.metadata.sha256)
            .expected_repository_id(r.expected_repository_id)
            .expected_account(&r.expected_account)
            .binding_sha256(&self.request_sha256)
            .additional_archives(&self.additional_archives)
            .build()
    }
}

/// Fully local inspection: no network, credentials, writes, or executable loading.
pub async fn prepare_author_release(
    request: &Path,
    directory: &Path,
) -> Result<PreparedAuthorRelease, Error> {
    reject_symlink_components(request)?;
    reject_symlink_components(directory)?;
    if !directory.is_dir() {
        return Err(invalid());
    }
    let source = ArchiveFile::open(request, REQUEST_LIMIT).map_err(|_| invalid())?;
    let bytes = source.bytes().await.map_err(|_| invalid())?;
    let request: AuthorReleaseRequest = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    validate(&request)?;
    let archive = open(directory, &request.archive, ARCHIVE_LIMIT)?;
    let metadata_file = open(directory, &request.metadata, METADATA_LIMIT)?;
    let metadata = metadata_file.bytes().await?;
    let mut additional_archives = Vec::new();
    for asset in &request.additional_archives {
        additional_archives.push(GitHubArchive {
            name: asset.name.clone(),
            sha256: asset.sha256.clone(),
            file: open(directory, asset, ARCHIVE_LIMIT)?,
        });
    }
    Ok(PreparedAuthorRelease {
        request,
        request_sha256: super::digest(&bytes),
        archive,
        metadata_file,
        metadata,
        additional_archives,
    })
}

fn validate(r: &AuthorReleaseRequest) -> Result<(), Error> {
    super::validate_repository(&r.repository)?;
    super::validate_tag(&r.tag)?;
    super::validate_segment(&r.expected_account, "expected account")?;
    if r.schema_version != 1
        || r.expected_repository_id == 0
        || r.source_commit.len() != 40
        || !super::state::is_sha(&r.source_commit)
        || r.release_notes.len() > 32 * 1024
        || r.release_notes.contains("cadencr-publication-binding:")
        || r.additional_archives.len() > 14
    {
        return Err(invalid());
    }
    let mut names = HashSet::new();
    let mut total = 0_u64;
    for asset in [&r.archive, &r.metadata]
        .into_iter()
        .chain(&r.additional_archives)
    {
        super::validate_segment(&asset.name, "asset name")?;
        if !names.insert(&asset.name)
            || asset.size == 0
            || asset.size > ARCHIVE_LIMIT
            || asset.sha256.len() != 64
            || !super::state::is_sha(&asset.sha256)
        {
            return Err(invalid());
        }
        total = total.checked_add(asset.size).ok_or_else(invalid)?;
    }
    if total > TOTAL_LIMIT || r.metadata.size > METADATA_LIMIT {
        return Err(invalid());
    }
    Ok(())
}

fn open(root: &Path, asset: &AuthorReleaseAsset, limit: u64) -> Result<ArchiveFile, Error> {
    let file = ArchiveFile::open(&root.join(&asset.name), limit).map_err(|_| invalid())?;
    if file.size != asset.size || file.sha256 != asset.sha256 {
        return Err(invalid());
    }
    Ok(file)
}

fn reject_symlink_components(path: &Path) -> Result<(), Error> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map_err(|_| invalid())?.join(path)
    };
    let mut current = std::path::PathBuf::new();
    for component in absolute.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err(invalid());
        }
        current.push(component);
        if std::fs::symlink_metadata(&current)
            .map_err(|_| invalid())?
            .file_type()
            .is_symlink()
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn invalid() -> Error {
    Error::BadRequest("invalid, changed, or unconfirmed author release request/assets".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::write(root.join("provider.tar.gz"), b"archive").unwrap();
        std::fs::write(root.join("release.json"), b"metadata").unwrap();
        let request = root.join("request.json");
        let asset = |name, bytes: &[u8]| serde_json::json!({"name":name,"size":bytes.len(),"sha256":super::super::digest(bytes)});
        let value = serde_json::json!({"schema_version":1,"repository":"acme/provider",
            "expected_repository_id":42,"expected_account":"author","tag":"v1.0.0",
            "source_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","release_notes":"Release notes",
            "prerelease":false,"archive":asset("provider.tar.gz", b"archive"),
            "metadata":asset("release.json", b"metadata"),"additional_archives":[]});
        std::fs::write(&request, serde_json::to_vec(&value).unwrap()).unwrap();
        (temp, root, request)
    }
    #[tokio::test]
    async fn portable_entrypoint_reconciles_unknown_writes_and_exact_retry() {
        let (_temp, root, request) = setup();
        let prepared = prepare_author_release(&request, &root).await.unwrap();
        let fixture =
            super::super::fixture::Fixture::start(super::super::fixture::FixtureOptions {
                lose_create: true,
                lose_first_upload: true,
                lose_publish: true,
                ..Default::default()
            })
            .await;
        let first =
            super::super::state::publish(&fixture.transport, "secret", &prepared.engine_request())
                .await
                .unwrap();
        assert!(!first.already_published);
        let writes = fixture.writes();
        let second =
            super::super::state::publish(&fixture.transport, "secret", &prepared.engine_request())
                .await
                .unwrap();
        assert!(second.already_published);
        assert_eq!(writes, fixture.writes());
    }
    #[tokio::test]
    async fn current_exact_bytes_require_independent_confirmation_and_mutation_fails() {
        let (_temp, root, request) = setup();
        let first = prepare_author_release(&request, &root).await.unwrap();
        assert!(first.confirm(first.request_sha256()).is_ok());
        let mut bytes = std::fs::read(&request).unwrap();
        bytes.push(b' ');
        std::fs::write(&request, bytes).unwrap();
        let second = prepare_author_release(&request, &root).await.unwrap();
        assert!(second.confirm(first.request_sha256()).is_err());
        std::fs::write(root.join("provider.tar.gz"), b"changed").unwrap();
        assert!(second.revalidate().await.is_err());
        assert!(prepare_author_release(&request, &root).await.is_err());
        std::fs::write(root.join("provider.tar.gz"), b"archive-more").unwrap();
        assert!(prepare_author_release(&request, &root).await.is_err());
    }
    #[tokio::test]
    async fn schema_bounds_unknown_fields_and_unsafe_names_fail_closed() {
        for (key, value) in [
            ("schema_version", serde_json::json!(2)),
            ("unexpected", serde_json::json!(true)),
        ] {
            let (_temp, root, request) = setup();
            let mut json: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&request).unwrap()).unwrap();
            json[key] = value;
            std::fs::write(&request, serde_json::to_vec(&json).unwrap()).unwrap();
            assert!(prepare_author_release(&request, &root).await.is_err());
        }
        for name in ["../escape", "/absolute", "nested/file", "a\\b", ".."] {
            let (_temp, root, request) = setup();
            let mut json: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&request).unwrap()).unwrap();
            json["archive"]["name"] = name.into();
            std::fs::write(&request, serde_json::to_vec(&json).unwrap()).unwrap();
            assert!(prepare_author_release(&request, &root).await.is_err());
        }
    }
    fn typed_request() -> AuthorReleaseRequest {
        AuthorReleaseRequest {
            schema_version: 1,
            repository: "acme/provider".into(),
            expected_repository_id: 42,
            expected_account: "author".into(),
            tag: "v1".into(),
            source_commit: "a".repeat(40),
            release_notes: "notes".into(),
            prerelease: false,
            archive: typed_asset("archive", 1),
            metadata: typed_asset("metadata", 1),
            additional_archives: Vec::new(),
        }
    }
    fn typed_asset(name: &str, size: u64) -> AuthorReleaseAsset {
        AuthorReleaseAsset {
            name: name.into(),
            size,
            sha256: "b".repeat(64),
        }
    }
    #[test]
    fn security_limits_are_inclusive_and_reject_every_overflow_without_large_files() {
        type Case = (&'static str, fn(&mut AuthorReleaseRequest), bool);
        let cases: &[Case] = &[
            (
                "duplicate primary names",
                |r| r.metadata.name = r.archive.name.clone(),
                false,
            ),
            (
                "duplicate additional name",
                |r| r.additional_archives.push(typed_asset("archive", 1)),
                false,
            ),
            (
                "duplicate additional pair",
                |r| r.additional_archives = vec![typed_asset("extra", 1), typed_asset("extra", 1)],
                false,
            ),
            (
                "fourteen additional",
                |r| {
                    r.additional_archives = (0..14)
                        .map(|i| typed_asset(&format!("extra-{i}"), 1))
                        .collect()
                },
                true,
            ),
            (
                "fifteen additional",
                |r| {
                    r.additional_archives = (0..15)
                        .map(|i| typed_asset(&format!("extra-{i}"), 1))
                        .collect()
                },
                false,
            ),
            (
                "aggregate exact",
                |r| {
                    r.archive.size = ARCHIVE_LIMIT;
                    r.additional_archives
                        .push(typed_asset("extra", ARCHIVE_LIMIT - 1));
                },
                true,
            ),
            (
                "aggregate overflow",
                |r| {
                    r.archive.size = ARCHIVE_LIMIT;
                    r.additional_archives
                        .push(typed_asset("extra", ARCHIVE_LIMIT));
                },
                false,
            ),
            ("metadata exact", |r| r.metadata.size = METADATA_LIMIT, true),
            (
                "metadata overflow",
                |r| r.metadata.size = METADATA_LIMIT + 1,
                false,
            ),
            ("zero archive", |r| r.archive.size = 0, false),
            ("zero metadata", |r| r.metadata.size = 0, false),
            (
                "zero additional",
                |r| r.additional_archives.push(typed_asset("extra", 0)),
                false,
            ),
            ("archive exact", |r| r.archive.size = ARCHIVE_LIMIT, true),
            (
                "archive overflow",
                |r| r.archive.size = ARCHIVE_LIMIT + 1,
                false,
            ),
            (
                "additional exact",
                |r| {
                    r.additional_archives
                        .push(typed_asset("extra", ARCHIVE_LIMIT))
                },
                true,
            ),
            (
                "additional overflow",
                |r| {
                    r.additional_archives
                        .push(typed_asset("extra", ARCHIVE_LIMIT + 1))
                },
                false,
            ),
            (
                "reserved binding notes",
                |r| r.release_notes = "<!-- cadencr-publication-binding:sha256:evil -->".into(),
                false,
            ),
            (
                "notes exact",
                |r| r.release_notes = "n".repeat(32 * 1024),
                true,
            ),
            (
                "notes overflow",
                |r| r.release_notes = "n".repeat(32 * 1024 + 1),
                false,
            ),
        ];
        for (label, change, accepted) in cases {
            let mut request = typed_request();
            change(&mut request);
            assert_eq!(validate(&request).is_ok(), *accepted, "{label}");
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_in_assets_or_root_are_refused() {
        let (_temp, root, request) = setup();
        std::fs::rename(root.join("provider.tar.gz"), root.join("original")).unwrap();
        std::os::unix::fs::symlink(root.join("original"), root.join("provider.tar.gz")).unwrap();
        assert!(prepare_author_release(&request, &root).await.is_err());
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        assert!(prepare_author_release(&request, &alias).await.is_err());
    }
}
