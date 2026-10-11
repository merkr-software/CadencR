use super::archive::invalid;
use crate::domain::projects::publication_release::local::validation::{
    parse_repository, validate_archive_url,
};
use crate::error::AppError;
use futures::StreamExt as _;

#[derive(Clone, Copy, PartialEq, Eq)]
enum DownloadKind {
    Catalog,
    Artifact,
}

pub async fn download_archive(
    url: &str,
    repository: Option<&str>,
    limit: usize,
) -> Result<Vec<u8>, AppError> {
    let repository = parse_repository(repository)?;
    validate_archive_url(url, &repository)?;
    download_inner(url, limit, DownloadKind::Artifact).await
}
fn allowed_redirect(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
}

pub async fn download(url: &str, limit: usize) -> Result<Vec<u8>, AppError> {
    download_inner(url, limit, DownloadKind::Catalog).await
}
fn client(kind: DownloadKind) -> Result<&'static reqwest::Client, AppError> {
    static CATALOG: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    static ARTIFACT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    let slot = match kind {
        DownloadKind::Catalog => &CATALOG,
        DownloadKind::Artifact => &ARTIFACT,
    };
    slot.get_or_init(|| build_client(kind))
        .as_ref()
        .map_err(invalid)
}
fn build_client(kind: DownloadKind) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if (kind == DownloadKind::Artifact && !allowed_redirect(attempt.url()))
                || attempt.url().scheme() != "https"
                || attempt.previous().len() >= 3
            {
                attempt.error("unsafe theme download redirect")
            } else {
                attempt.follow()
            }
        }))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}
async fn download_inner(url: &str, limit: usize, kind: DownloadKind) -> Result<Vec<u8>, AppError> {
    let url = reqwest::Url::parse(url).map_err(invalid)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid(
            "theme download requires absolute HTTPS without credentials",
        ));
    }
    let client = client(kind)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(invalid)?
        .error_for_status()
        .map_err(invalid)?;
    if (kind == DownloadKind::Artifact && !allowed_redirect(response.url()))
        || response.url().scheme() != "https"
        || response
            .content_length()
            .is_some_and(|size| size > limit as u64)
    {
        return Err(invalid("unsafe or oversized theme download"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(invalid)?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(invalid("theme download exceeds budget"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn artifact_sources_reject_private_hosts_non_release_paths_and_queries() {
        for url in [
            "https://127.0.0.1/archive.tar.gz",
            "https://localhost/archive.tar.gz",
            "https://github.com/acme/themes/archive.tar.gz",
            "https://github.com/acme/themes/releases/download/v1/theme.tar.gz?secret=1",
            "https://github.com/other/themes/releases/download/v1/theme.tar.gz",
        ] {
            assert!(
                download_archive(url, Some("https://github.com/acme/themes"), 10)
                    .await
                    .is_err()
            );
        }
    }
    #[test]
    fn redirect_policy_permits_only_public_github_asset_hosts() {
        for url in [
            "https://127.0.0.1/a",
            "https://localhost/a",
            "https://github.com.evil.test/a",
            "http://github.com/a",
            "https://user@github.com/a",
            "https://github.com:8443/a",
        ] {
            assert!(!allowed_redirect(&reqwest::Url::parse(url).unwrap()));
        }
        assert!(allowed_redirect(
            &reqwest::Url::parse(
                "https://release-assets.githubusercontent.com/object?token=signed"
            )
            .unwrap()
        ));
    }
}
