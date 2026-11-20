//! Provider detection for git remote URLs.
//!
//! This module is the shared entry point for classifying remotes and building
//! browser URLs. Provider API behavior lives in the dedicated sibling
//! `forge/` adapters; every other code path consumes the neutral types here,
//! per `.claude/rules/provider-boundaries.md`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::error::AppError;
use crate::shared::git_cli::run_git_probe_background;

/// Known git hosting providers. `Other` is the fallback for self-hosted
/// installations whose URL we cannot confidently classify.
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum GitHost {
    GitHub,
    GitLab,
    Bitbucket,
    Other,
}

/// Parsed metadata extracted from a remote URL.
///
/// `web_base` is the URL prefix usable for browser-facing operations
/// (e.g. `https://github.com/owner/repo`). `owner` carries the full path
/// segment leading up to the repo name — for GitLab this preserves nested
/// groups (`group/sub-group`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct RemoteInfo {
    pub host: GitHost,
    pub hostname: String,
    pub web_base: String,
    pub owner: String,
    pub repo: String,
}

/// Parse SSH (`git@host:owner/repo.git`), HTTPS (`https://host/owner/repo.git`),
/// and `ssh://` variants. Returns `None` for inputs that don't look like a
/// remote URL we can usefully describe.
pub fn detect_remote(url: &str) -> Option<RemoteInfo> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (hostname, path) = split_host_path(trimmed)?;
    let path = path.trim_start_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let path = path.trim_end_matches('/');

    let mut segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() < 2 {
        return None;
    }
    let repo = segments.pop()?.to_string();
    let owner = segments.join("/");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    let host = classify_host(hostname);
    // We always render `web_base` as `https://` — git hosting providers all
    // serve their browser surfaces over TLS, and self-hosted instances
    // (`Other`) overwhelmingly do too. The frontend uses `web_base` only
    // for click-to-open URLs, never for protocol-sensitive operations.
    let web_base = format!("https://{hostname}/{owner}/{repo}");

    Some(RemoteInfo {
        host,
        hostname: hostname.to_string(),
        web_base,
        owner,
        repo,
    })
}

/// Read and classify the repository's `origin` remote: `None` when there is
/// no `origin` or its URL names no known host. A configuration Git cannot read
/// is an error, never a missing remote.
pub async fn detect_origin_remote(repo: &Path) -> Result<Option<RemoteInfo>, AppError> {
    let args = ["config", "--get", "remote.origin.url"];
    let url = run_git_probe_background(&args, repo).await?;
    Ok(url.and_then(|url| detect_remote(url.trim())))
}

/// Build the provider-specific compare/PR URL.
///
/// - GitHub: `{web_base}/compare/{base}...{head}?expand=1`
/// - GitLab: `{web_base}/-/compare/{base}...{head}`
/// - Bitbucket: `{web_base}/branches/compare/{head}..{base}` (Bitbucket uses
///   `head..base` ordering and `..` rather than `...`)
/// - Other: `None`. Self-hosted/unknown providers don't have a single
///   conventional compare path, so we refuse to guess. Callers (and the
///   frontend) treat `None` as the signal to disable the open-compare action.
///   This is the *only* place that knows about the `Other` sentinel — keeping
///   it inside `host.rs` enforces the provider boundary.
///
/// Both `base` and `head` are normalized through [`strip_remote_prefix`]
/// before being interpolated, because the user-facing compare page on the
/// provider has no notion of "remote-tracking ref": GitHub's `main` and the
/// local `origin/main` are the same branch from its point of view, and a URL
/// with `compare/origin/main...feat` 404s. The Cadencr UI lets users pick
/// either form as a target — we honor that choice for everything *except*
/// this last URL hop, where the provider's vocabulary wins.
pub fn compare_url(info: &RemoteInfo, base: &str, head: &str) -> Option<String> {
    let base = strip_remote_prefix(base);
    let head = strip_remote_prefix(head);
    match info.host {
        GitHost::GitHub => Some(format!(
            "{}/compare/{}...{}?expand=1",
            info.web_base, base, head
        )),
        GitHost::GitLab => Some(format!("{}/-/compare/{}...{}", info.web_base, base, head)),
        GitHost::Bitbucket => Some(format!(
            "{}/branches/compare/{}..{}",
            info.web_base, head, base
        )),
        GitHost::Other => None,
    }
}

/// Reduce a Cadencr-side branch identifier to the bare name a hosting
/// provider expects on its compare URL. We strip:
///
/// - the SCP-style `origin/` prefix used by remote-tracking refs in our
///   branch picker (`origin/main` → `main`),
/// - the fully-qualified `refs/remotes/origin/` form returned by some git
///   plumbing (`refs/remotes/origin/main` → `main`),
/// - the `refs/heads/` form for symmetry (`refs/heads/feat` → `feat`).
///
/// This is intentionally conservative: we only strip the `origin` remote,
/// not arbitrary remote names. Cadencr's UI exposes `origin` as the only
/// remote in the picker today, and stripping unknown `<remote>/` prefixes
/// would drop branches whose names legitimately start with a slug like
/// `release/2026.1`.
fn strip_remote_prefix(branch: &str) -> &str {
    let b = branch
        .strip_prefix("refs/remotes/origin/")
        .or_else(|| branch.strip_prefix("refs/heads/"))
        .unwrap_or(branch);
    b.strip_prefix("origin/").unwrap_or(b)
}

/// Build the provider-specific URL for viewing a single commit in the browser.
///
/// - GitHub / Bitbucket-on-`github`-style: `{web_base}/commit/{sha}`
/// - GitLab: `{web_base}/-/commit/{sha}`
/// - Bitbucket: `{web_base}/commits/{sha}` (note the plural path segment)
/// - Other: `None` — same provider-boundary policy as [`compare_url`]; we
///   refuse to guess for self-hosted/unknown hosts.
pub fn commit_url(info: &RemoteInfo, sha: &str) -> Option<String> {
    match info.host {
        GitHost::GitHub => Some(format!("{}/commit/{}", info.web_base, sha)),
        GitHost::GitLab => Some(format!("{}/-/commit/{}", info.web_base, sha)),
        GitHost::Bitbucket => Some(format!("{}/commits/{}", info.web_base, sha)),
        GitHost::Other => None,
    }
}

/// Provider-specific label for the "open the proposal page" action.
pub fn pr_label(host: &GitHost) -> &'static str {
    match host {
        GitHost::GitHub => "Open pull request",
        GitHost::GitLab => "Open merge request",
        GitHost::Bitbucket => "Open pull request",
        GitHost::Other => "Open compare",
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Split a remote URL into `(hostname, path)`. Handles:
/// - `git@host:owner/repo.git` (SCP-like SSH)
/// - `ssh://git@host/owner/repo.git`
/// - `https://host/owner/repo.git`
/// - `http://host/owner/repo.git`
/// - `git://host/owner/repo.git`
fn split_host_path(url: &str) -> Option<(&str, &str)> {
    if let Some(rest) = url.strip_prefix("git@") {
        // SCP-like: `host:path`
        let (host, path) = rest.split_once(':')?;
        return Some((host, path));
    }
    for prefix in ["ssh://", "https://", "http://", "git://"] {
        if let Some(rest) = url.strip_prefix(prefix) {
            // Strip optional `user@`
            let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
            let (host, path) = rest.split_once('/')?;
            return Some((host, path));
        }
    }
    None
}

/// Classify a hostname against known providers. Self-hosted heuristic:
/// hostnames that start with `gitlab.` or `github.` or `bitbucket.` are
/// treated as that provider. Anything else is `Other`.
fn classify_host(hostname: &str) -> GitHost {
    let h = hostname.to_ascii_lowercase();
    if h == "github.com" || h.starts_with("github.") {
        GitHost::GitHub
    } else if h == "gitlab.com" || h.starts_with("gitlab.") {
        GitHost::GitLab
    } else if h == "bitbucket.org" || h.starts_with("bitbucket.") {
        GitHost::Bitbucket
    } else {
        GitHost::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_github() {
        let info = detect_remote("git@github.com:owner/repo.git").unwrap();
        assert_eq!(info.host, GitHost::GitHub);
        assert_eq!(info.owner, "owner");
        assert_eq!(info.repo, "repo");
        assert_eq!(info.web_base, "https://github.com/owner/repo");
    }

    #[test]
    fn https_github() {
        let info = detect_remote("https://github.com/owner/repo.git").unwrap();
        assert_eq!(info.host, GitHost::GitHub);
        assert_eq!(info.owner, "owner");
        assert_eq!(info.repo, "repo");
        assert_eq!(info.web_base, "https://github.com/owner/repo");
    }

    #[test]
    fn https_github_no_dot_git() {
        let info = detect_remote("https://github.com/owner/repo").unwrap();
        assert_eq!(info.host, GitHost::GitHub);
        assert_eq!(info.repo, "repo");
    }

    #[test]
    fn gitlab_nested_group() {
        let info = detect_remote("https://gitlab.com/group/sub/repo.git").unwrap();
        assert_eq!(info.host, GitHost::GitLab);
        assert_eq!(info.owner, "group/sub");
        assert_eq!(info.repo, "repo");
        assert_eq!(info.web_base, "https://gitlab.com/group/sub/repo");
    }

    #[test]
    fn self_hosted_gitlab_ssh() {
        let info = detect_remote("git@gitlab.example.com:group/repo.git").unwrap();
        assert_eq!(info.host, GitHost::GitLab);
        assert_eq!(info.owner, "group");
        assert_eq!(info.repo, "repo");
        assert_eq!(info.web_base, "https://gitlab.example.com/group/repo");
    }

    #[test]
    fn bitbucket_https() {
        let info = detect_remote("https://bitbucket.org/owner/repo").unwrap();
        assert_eq!(info.host, GitHost::Bitbucket);
        assert_eq!(info.owner, "owner");
        assert_eq!(info.repo, "repo");
    }

    #[test]
    fn unknown_host_falls_back_to_other() {
        let info = detect_remote("https://example.com/foo/bar.git").unwrap();
        assert_eq!(info.host, GitHost::Other);
        assert_eq!(info.owner, "foo");
        assert_eq!(info.repo, "bar");
    }

    #[test]
    fn ssh_url_scheme_with_user() {
        let info = detect_remote("ssh://git@github.com/owner/repo.git").unwrap();
        assert_eq!(info.host, GitHost::GitHub);
        assert_eq!(info.owner, "owner");
        assert_eq!(info.repo, "repo");
    }

    #[test]
    fn empty_or_invalid_returns_none() {
        assert!(detect_remote("").is_none());
        assert!(detect_remote("not-a-url").is_none());
        assert!(detect_remote("https://github.com/").is_none());
        assert!(detect_remote("https://github.com/owner").is_none());
    }

    #[test]
    fn compare_url_github() {
        let info = detect_remote("git@github.com:owner/repo.git").unwrap();
        let url = compare_url(&info, "main", "feature/x").unwrap();
        assert_eq!(
            url,
            "https://github.com/owner/repo/compare/main...feature/x?expand=1"
        );
    }

    #[test]
    fn compare_url_gitlab_nested() {
        let info = detect_remote("https://gitlab.com/group/sub/repo.git").unwrap();
        let url = compare_url(&info, "main", "feat").unwrap();
        assert_eq!(
            url,
            "https://gitlab.com/group/sub/repo/-/compare/main...feat"
        );
    }

    #[test]
    fn compare_url_bitbucket_uses_head_first() {
        let info = detect_remote("https://bitbucket.org/owner/repo").unwrap();
        let url = compare_url(&info, "main", "feat").unwrap();
        // Bitbucket compare expects head..base (note ordering and `..`).
        assert_eq!(
            url,
            "https://bitbucket.org/owner/repo/branches/compare/feat..main"
        );
    }

    #[test]
    fn compare_url_other_returns_none() {
        // The `Other` host is the only sentinel inside the provider boundary —
        // we refuse to guess a compare URL and let the frontend disable the
        // action via the resulting `None`.
        let info = detect_remote("https://example.com/foo/bar.git").unwrap();
        assert_eq!(info.host, GitHost::Other);
        assert!(compare_url(&info, "main", "feat").is_none());
    }

    #[test]
    fn compare_url_strips_origin_prefix_from_base() {
        // The picker offers `origin/main` as a distinct entry from local
        // `main`; the user can pick either as the target. GitHub's compare
        // page doesn't know about remote-tracking refs, so the URL must
        // resolve to `compare/main...feat`, not `compare/origin/main...feat`.
        let info = detect_remote("git@github.com:owner/repo.git").unwrap();
        let url = compare_url(&info, "origin/main", "feat").unwrap();
        assert_eq!(
            url,
            "https://github.com/owner/repo/compare/main...feat?expand=1"
        );
    }

    #[test]
    fn compare_url_strips_origin_prefix_from_head() {
        // Symmetric: a head branch passed as `origin/feat` (rare but
        // possible if upstream tooling normalizes through remotes) must
        // also collapse to the bare name on the URL.
        let info = detect_remote("git@github.com:owner/repo.git").unwrap();
        let url = compare_url(&info, "main", "origin/feat").unwrap();
        assert_eq!(
            url,
            "https://github.com/owner/repo/compare/main...feat?expand=1"
        );
    }

    #[test]
    fn compare_url_strips_full_ref_path() {
        // `refs/remotes/origin/<branch>` and `refs/heads/<branch>` are the
        // forms `git for-each-ref` and friends emit. Same provider rule:
        // strip down to the bare name.
        let info = detect_remote("https://gitlab.com/group/repo.git").unwrap();
        let url = compare_url(&info, "refs/remotes/origin/main", "refs/heads/feat").unwrap();
        assert_eq!(url, "https://gitlab.com/group/repo/-/compare/main...feat");
    }

    #[test]
    fn compare_url_preserves_non_origin_slash_prefix() {
        // Branch names like `release/2026.1` legitimately contain a `/`.
        // We only strip the literal `origin/` remote prefix — everything
        // else passes through untouched.
        let info = detect_remote("git@github.com:owner/repo.git").unwrap();
        let url = compare_url(&info, "release/2026.1", "feature/x").unwrap();
        assert_eq!(
            url,
            "https://github.com/owner/repo/compare/release/2026.1...feature/x?expand=1"
        );
    }

    #[test]
    fn commit_url_per_host() {
        let gh = detect_remote("git@github.com:owner/repo.git").unwrap();
        assert_eq!(
            commit_url(&gh, "abc123").unwrap(),
            "https://github.com/owner/repo/commit/abc123"
        );
        let gl = detect_remote("https://gitlab.com/group/sub/repo.git").unwrap();
        assert_eq!(
            commit_url(&gl, "abc123").unwrap(),
            "https://gitlab.com/group/sub/repo/-/commit/abc123"
        );
        let bb = detect_remote("https://bitbucket.org/owner/repo").unwrap();
        assert_eq!(
            commit_url(&bb, "abc123").unwrap(),
            "https://bitbucket.org/owner/repo/commits/abc123"
        );
        let other = detect_remote("https://example.com/foo/bar.git").unwrap();
        assert!(commit_url(&other, "abc123").is_none());
    }

    #[test]
    fn pr_label_per_host() {
        assert_eq!(pr_label(&GitHost::GitHub), "Open pull request");
        assert_eq!(pr_label(&GitHost::GitLab), "Open merge request");
        assert_eq!(pr_label(&GitHost::Bitbucket), "Open pull request");
        assert_eq!(pr_label(&GitHost::Other), "Open compare");
    }

    /// No `origin` is `None`; a configuration Git cannot parse is an error.
    #[tokio::test]
    async fn origin_remote_tells_a_missing_origin_from_a_failure() {
        let repo = tempfile::tempdir().unwrap();
        crate::shared::git_cli::run_git(&["init", "-q"], repo.path())
            .await
            .unwrap();
        assert_eq!(detect_origin_remote(repo.path()).await.unwrap(), None);
        crate::shared::git_cli::run_git(
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/acme/widgets.git",
            ],
            repo.path(),
        )
        .await
        .unwrap();
        let info = detect_origin_remote(repo.path()).await.unwrap().unwrap();
        assert_eq!(info.repo, "widgets");

        std::fs::write(repo.path().join(".git/config"), "[broken\n").unwrap();
        assert!(detect_origin_remote(repo.path()).await.is_err());
    }
}
