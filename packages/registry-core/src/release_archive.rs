//! One canonical GitHub release-archive policy for authoring and installation.
use crate::{submission, RegistryError};

#[derive(Debug, PartialEq, Eq)]
pub struct GitHubReleaseArchive {
    pub repository: String,
    /// Decoded Git tag, not its URL-encoded path segment.
    pub tag: String,
    pub asset: String,
}

pub fn parse_github_release_archive_url(raw: &str) -> Result<GitHubReleaseArchive, RegistryError> {
    let invalid = || {
        RegistryError::single("archive must be a canonical HTTPS GitHub release archive with a safe tag and asset name")
    };
    let url = url::Url::parse(raw).map_err(|_| invalid())?;
    let parts = url.path().split('/').collect::<Vec<_>>();
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != raw
        || parts.len() != 7
        || !parts[0].is_empty()
        || parts[3..5] != ["releases", "download"]
    {
        return Err(invalid());
    }
    let repository = format!("https://github.com/{}/{}", parts[1], parts[2]);
    let tag = submission::decode_uri_component(parts[5]).ok_or_else(invalid)?;
    let segment = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    let asset = parts[6];
    let lower = asset.to_ascii_lowercase();
    if !submission::canonical_github_repository(&repository)
        || !submission::valid_git_tag(&tag)
        || !tag.split('/').all(segment)
        || submission::encode_uri_component(&tag) != parts[5]
        || !segment(asset)
        || asset.len() > 128
        || (!lower.ends_with(".tar.gz") && !lower.ends_with(".tgz"))
    {
        return Err(invalid());
    }
    Ok(GitHubReleaseArchive {
        repository,
        tag,
        asset: asset.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_only_canonical_safe_namespaced_release_tags() {
        for kind in ["provider", "theme", "tab", "lsp"] {
            let raw = format!("https://github.com/merkr-software/CadencR/releases/download/plugins%2F{kind}-example%2Fv1.0.0/plugin.tar.gz");
            let parsed = parse_github_release_archive_url(&raw).unwrap();
            assert_eq!(
                parsed.repository,
                "https://github.com/merkr-software/CadencR"
            );
            assert_eq!(parsed.tag, format!("plugins/{kind}-example/v1.0.0"));
            assert_eq!(parsed.asset, "plugin.tar.gz");
        }
        assert_eq!(
            parse_github_release_archive_url(
                "https://github.com/acme/plugin/releases/download/v1.0.0/plugin.TGZ"
            )
            .unwrap()
            .tag,
            "v1.0.0"
        );
    }

    #[test]
    fn rejects_ambiguous_encodings_paths_origins_and_assets() {
        let prefix = "https://github.com/acme/plugin/releases/download/";
        for tail in [
            "plugins/theme/v1/plugin.tar.gz",
            "plugins%2ftheme%2fv1/plugin.tar.gz",
            "plugins%252Ftheme%252Fv1/plugin.tar.gz",
            "%2E%2E/plugin.tar.gz",
            "plugins%2F..%2Fv1/plugin.tar.gz",
            "plugins%2F.hidden%2Fv1/plugin.tar.gz",
            "plugins%2Fname.lock%2Fv1/plugin.tar.gz",
            "plugins%2F%2Fv1/plugin.tar.gz",
            "plugins%5Ctheme%5Cv1/plugin.tar.gz",
            "v1%00/plugin.tar.gz",
            "%ZZ/plugin.tar.gz",
            "v1/plugin%2Fother.tar.gz",
            "v1/plugin%2Etar.gz",
            "v1/package.json",
            "v1/plugin.tar.gz?token=x",
            "v1/plugin.tar.gz#fragment",
            "v1/plugin.tar.gz/extra",
        ] {
            assert!(
                parse_github_release_archive_url(&format!("{prefix}{tail}")).is_err(),
                "{tail}"
            );
        }
        for origin in [
            "http://github.com",
            "https://github.com.evil.test",
            "https://user@github.com",
            "https://github.com:8443",
        ] {
            assert!(
                parse_github_release_archive_url(&format!(
                    "{origin}/acme/plugin/releases/download/v1/plugin.tar.gz"
                ))
                .is_err(),
                "{origin}"
            );
        }
    }
}
