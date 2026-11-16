//! Where a pull request's `<img src>` actually points, and whether we are
//! willing to go there.
//!
//! Split out of the handler because these are the two decisions worth testing
//! on their own: a forge writes image sources in four different shapes, and the
//! answer to "may the forge token travel with this request" has to be a
//! property of the host rather than of the call site.

use reqwest::Url;

use crate::domain::git::host::{GitHost, RemoteInfo};
use crate::error::AppError;

#[path = "public_address.rs"]
mod public_address;

pub use public_address::ensure_fetchable;

/// Resolve an image source from a PR body into an absolute URL.
///
/// Forges emit four shapes and each resolves differently:
/// absolute (`https://…`), protocol-relative (`//host/…`), site-root-relative
/// (`/owner/repo/…`), and repository-relative (`docs/logo.png`, which the web
/// UI serves from the head commit).
pub fn resolve_image_url(
    remote: &RemoteInfo,
    kind: GitHost,
    head_sha: Option<&str>,
    raw: &str,
) -> Result<Url, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("An image URL is required".into()));
    }
    // `//host/path` means "same scheme as the page". The page is a forge over
    // HTTPS, so that is the scheme it inherits.
    if let Some(rest) = trimmed.strip_prefix("//") {
        return parse_absolute(&format!("https://{rest}"));
    }
    if let Ok(url) = Url::parse(trimmed) {
        return Ok(url);
    }
    repository_relative_url(remote, kind, head_sha, trimmed)
}

fn parse_absolute(candidate: &str) -> Result<Url, AppError> {
    Url::parse(candidate)
        .map_err(|error| AppError::BadRequest(format!("Unreadable image URL: {error}")))
}

fn repository_relative_url(
    remote: &RemoteInfo,
    kind: GitHost,
    head_sha: Option<&str>,
    path: &str,
) -> Result<Url, AppError> {
    // `web_base` is already the repository's own page — `https://host/owner/repo`
    // — so the site root has to be rebuilt from the hostname rather than
    // assumed. Reading it as an origin appends `owner/repo` a second time and
    // 404s every repository-relative image.
    let project = remote.web_base.trim_end_matches('/');
    let site = format!("https://{}", remote.hostname);
    // GitLab writes attachments as `/uploads/<secret>/<name>`, which reads like
    // a site-root path but is served from the *project*. Joining it against the
    // origin — the obvious thing — sends every uploaded screenshot to a 404.
    if let Some(upload) = path.strip_prefix("/uploads/") {
        return parse_absolute(&format!("{project}/uploads/{upload}"));
    }
    if let Some(rooted) = path.strip_prefix('/') {
        return parse_absolute(&format!("{site}/{rooted}"));
    }
    let sha = head_sha
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest(
                "This image is stored in the repository, and the pull request's head commit is not known yet".into(),
            )
        })?;
    let raw_path = match kind {
        GitHost::GitLab => format!("{project}/-/raw/{sha}/{path}"),
        _ => format!("{project}/raw/{sha}/{path}"),
    };
    parse_absolute(&raw_path)
}

/// Whether the forge that hosts this pull request also owns `target` — i.e.
/// whether the configured token may travel to its complete HTTPS origin.
///
/// Everything else is still fetched, just anonymously: a shields.io badge in a
/// PR description is an ordinary image, but it has no business seeing a token
/// that unlocks the user's repositories.
pub fn is_forge_owned_origin(remote: &RemoteInfo, kind: GitHost, target: &Url) -> bool {
    let Some((remote_host, remote_port)) = Url::parse(&remote.web_base)
        .ok()
        .and_then(|url| effective_https_origin(&url))
    else {
        return false;
    };
    let Some((target_host, target_port)) = effective_https_origin(target) else {
        return false;
    };
    if target_host == remote_host && target_port == remote_port {
        return true;
    }
    // Public cloud forges serve assets from sibling domains. Only enable those
    // credential destinations for the canonical cloud host: a GHES or
    // self-hosted GitLab token must never travel to the public provider's CDN.
    if remote_port != 443 || target_port != 443 {
        return false;
    }
    match (kind, remote_host.as_str()) {
        (GitHost::GitHub, "github.com") => {
            is_within(&target_host, "github.com")
                || is_within(&target_host, "githubusercontent.com")
        }
        (GitHost::GitLab, "gitlab.com") => {
            is_within(&target_host, "gitlab.com") || is_within(&target_host, "gitlab-static.net")
        }
        (GitHost::Bitbucket, "bitbucket.org") => is_within(&target_host, "bitbucket.org"),
        (GitHost::Other, _) => false,
        _ => false,
    }
}

fn effective_https_origin(url: &Url) -> Option<(String, u16)> {
    if url.scheme() != "https" {
        return None;
    }
    Some((
        url.host_str()?.trim_end_matches('.').to_ascii_lowercase(),
        url.port_or_known_default()?,
    ))
}

/// `host` is `domain` itself or a subdomain of it — never a mere suffix match,
/// which would hand `evil-github.com` the credentials for `github.com`.
fn is_within(host: &str, domain: &str) -> bool {
    !domain.is_empty()
        && (host == domain
            || host
                .strip_suffix(domain)
                .is_some_and(|head| head.ends_with('.')))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped exactly like `detect_remote` builds one — in particular
    /// `web_base` is the *repository* page, not the site root. A fixture that
    /// got that wrong is what let the double-`owner/repo` bug through.
    fn remote(hostname: &str, host: GitHost) -> RemoteInfo {
        RemoteInfo {
            host,
            hostname: hostname.into(),
            web_base: format!("https://{hostname}/acme/repo"),
            owner: "acme".into(),
            repo: "repo".into(),
        }
    }

    fn github() -> RemoteInfo {
        remote("github.com", GitHost::GitHub)
    }

    fn resolve(raw: &str) -> String {
        resolve_image_url(&github(), GitHost::GitHub, Some("abc123"), raw)
            .expect("resolvable image source")
            .to_string()
    }

    fn owns(remote: &RemoteInfo, kind: GitHost, authority: &str) -> bool {
        let url = Url::parse(&format!("https://{authority}/image.png")).expect("test URL");
        is_forge_owned_origin(remote, kind, &url)
    }

    #[test]
    fn absolute_and_protocol_relative_sources_keep_their_host() {
        assert_eq!(
            resolve("https://avatars.githubusercontent.com/u/1?v=4"),
            "https://avatars.githubusercontent.com/u/1?v=4"
        );
        assert_eq!(
            resolve("//user-images.githubusercontent.com/1/shot.png"),
            "https://user-images.githubusercontent.com/1/shot.png"
        );
    }

    #[test]
    fn a_repository_relative_source_is_served_from_the_head_commit() {
        // A screenshot committed alongside the change is the common case for a
        // relative `src`, and the branch it lives on is the PR's head.
        assert_eq!(
            resolve("docs/screenshot.png"),
            "https://github.com/acme/repo/raw/abc123/docs/screenshot.png"
        );
        let gitlab = remote("gitlab.com", GitHost::GitLab);
        assert_eq!(
            resolve_image_url(&gitlab, GitHost::GitLab, Some("abc123"), "docs/shot.png")
                .unwrap()
                .to_string(),
            "https://gitlab.com/acme/repo/-/raw/abc123/docs/shot.png"
        );
    }

    #[test]
    fn a_gitlab_upload_resolves_against_the_project_not_the_origin() {
        // The bug this covers: `/uploads/...` looks site-root-relative, so a
        // plain join produced `https://gitlab.com/uploads/...` — a 404 for
        // every image a reviewer ever pasted into a merge request.
        let gitlab = remote("gitlab.com", GitHost::GitLab);
        assert_eq!(
            resolve_image_url(&gitlab, GitHost::GitLab, None, "/uploads/deadbeef/shot.png")
                .unwrap()
                .to_string(),
            "https://gitlab.com/acme/repo/uploads/deadbeef/shot.png"
        );
    }

    #[test]
    fn a_repository_relative_source_without_a_head_commit_explains_itself() {
        let error = resolve_image_url(&github(), GitHost::GitHub, None, "docs/shot.png")
            .expect_err("no commit to resolve against");
        assert!(
            matches!(&error, AppError::BadRequest(message) if message.contains("head commit")),
            "{error:?}"
        );
    }

    #[test]
    fn credentials_travel_to_the_forge_and_its_asset_domain_only() {
        let remote = github();
        for host in [
            "github.com",
            "raw.github.com",
            "avatars.githubusercontent.com",
            "private-user-images.githubusercontent.com",
        ] {
            assert!(owns(&remote, GitHost::GitHub, host), "{host}");
        }
        for host in [
            "img.shields.io",
            "secure.gravatar.com",
            // The suffix trap: a lookalike host must never be read as a
            // subdomain of the real one.
            "evil-github.com",
            "notgithubusercontent.com",
        ] {
            assert!(!owns(&remote, GitHost::GitHub, host), "{host}");
        }
        assert!(!owns(&remote, GitHost::GitHub, "github.com:8443"));
        assert!(!owns(
            &remote,
            GitHost::GitHub,
            "avatars.githubusercontent.com:8443"
        ));
    }

    #[test]
    fn a_self_hosted_forge_only_sends_credentials_to_its_exact_host() {
        let self_hosted = remote("git.example.com", GitHost::GitLab);
        assert!(!owns(
            &self_hosted,
            GitHost::GitLab,
            "assets.git.example.com"
        ));
        assert!(owns(&self_hosted, GitHost::GitLab, "git.example.com"));
        assert!(!owns(
            &self_hosted,
            GitHost::GitLab,
            "git.example.com.attacker.test"
        ));
        assert!(!owns(
            &self_hosted,
            GitHost::GitLab,
            "assets.gitlab-static.net"
        ));
        assert!(!owns(&self_hosted, GitHost::GitLab, "git.example.com:8443"));

        let nonstandard = remote("git.example.com:8443", GitHost::GitLab);
        assert!(owns(&nonstandard, GitHost::GitLab, "git.example.com:8443"));
        assert!(!owns(&nonstandard, GitHost::GitLab, "git.example.com"));
    }
}
