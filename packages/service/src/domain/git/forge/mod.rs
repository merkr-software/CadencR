mod activity;
mod auth;
mod bitbucket;
mod cache;
mod github;
mod github_repository;
mod gitlab;
mod http;
pub mod image_routes;
mod poller;
mod provider;
mod repository;
pub mod routes;

pub use activity::ForgeActivityTracker;
pub(crate) use auth::{forge_to_app_error, host_configs, resolve_credentials};
pub use auth::{ForgeAuthStore, FORGE_HOSTS_SETTING};
pub use cache::ForgeStatusCache;
pub use http::ForgeHttp;
pub use poller::spawn;
pub use provider::*;

use crate::domain::git::host::GitHost;

static GITHUB: github::GitHubProvider = github::GitHubProvider;
static GITLAB: gitlab::GitLabProvider = gitlab::GitLabProvider;
static BITBUCKET: bitbucket::BitbucketProvider = bitbucket::BitbucketProvider;

pub fn provider_for(kind: GitHost) -> Option<&'static dyn ForgeProvider> {
    match kind {
        GitHost::GitHub => Some(&GITHUB),
        GitHost::GitLab => Some(&GITLAB),
        GitHost::Bitbucket => Some(&BITBUCKET),
        GitHost::Other => None,
    }
}

pub fn api_base_url(
    hostname: &str,
    kind: GitHost,
    configured: Option<&ForgeHostConfig>,
) -> Result<Option<String>, ForgeError> {
    let candidate = if let Some(configured) = configured
        .and_then(|config| config.api_base_url.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(configured.to_string())
    } else {
        match kind {
            GitHost::GitHub if hostname.eq_ignore_ascii_case("github.com") => {
                Some("https://api.github.com".into())
            }
            GitHost::GitHub => Some(format!("https://{hostname}/api/v3")),
            GitHost::GitLab => Some(format!("https://{hostname}/api/v4")),
            GitHost::Bitbucket if hostname.eq_ignore_ascii_case("bitbucket.org") => {
                Some("https://api.bitbucket.org/2.0".into())
            }
            GitHost::Bitbucket | GitHost::Other => None,
        }
    };
    candidate
        .map(|value| validate_api_base_url(hostname, kind, &value))
        .transpose()
}

fn validate_api_base_url(
    hostname: &str,
    kind: GitHost,
    candidate: &str,
) -> Result<String, ForgeError> {
    let url = reqwest::Url::parse(candidate).map_err(|_| {
        ForgeError::Configuration("Forge API base URL must be a valid HTTPS URL".into())
    })?;
    if url.scheme() != "https" {
        return Err(ForgeError::Configuration(
            "Forge API base URL must use HTTPS so credentials are encrypted".into(),
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ForgeError::Configuration(
            "Forge API base URL cannot contain credentials, a query, or a fragment".into(),
        ));
    }
    let api_hostname = url.host_str().ok_or_else(|| {
        ForgeError::Configuration("Forge API base URL must include a hostname".into())
    })?;
    let host_matches_remote = api_hostname.eq_ignore_ascii_case(hostname);
    let known_cloud_api = matches!(
        (kind, hostname, api_hostname),
        (GitHost::GitHub, "github.com", "api.github.com")
            | (GitHost::Bitbucket, "bitbucket.org", "api.bitbucket.org")
    );
    if !host_matches_remote && !known_cloud_api {
        return Err(ForgeError::Configuration(format!(
            "Forge API hostname {api_hostname} must match remote host {hostname}"
        )));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

pub fn effective_kind(detected: GitHost, configured: Option<&ForgeHostConfig>) -> GitHost {
    configured.map_or(detected, |config| config.kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(api_base_url: &str) -> ForgeHostConfig {
        ForgeHostConfig {
            kind: GitHost::GitLab,
            api_base_url: Some(api_base_url.into()),
            use_cli_auth: false,
            username: None,
        }
    }

    #[test]
    fn api_base_url_requires_https_without_embedded_request_data() {
        for value in [
            "http://git.example.com/api/v4",
            "https://user@git.example.com/api/v4",
            "https://git.example.com/api/v4?token=secret",
            "https://git.example.com/api/v4#fragment",
        ] {
            assert!(
                api_base_url("git.example.com", GitHost::GitLab, Some(&config(value))).is_err()
            );
        }
    }

    #[test]
    fn api_base_url_is_bound_to_the_remote_host() {
        assert!(api_base_url(
            "git.example.com",
            GitHost::GitLab,
            Some(&config("https://collector.example.net/api/v4"))
        )
        .is_err());
        assert_eq!(
            api_base_url(
                "git.example.com",
                GitHost::GitLab,
                Some(&config("https://git.example.com/api/v4/"))
            )
            .unwrap()
            .as_deref(),
            Some("https://git.example.com/api/v4")
        );
    }

    #[test]
    fn api_base_url_allows_known_cloud_api_hosts() {
        assert_eq!(
            api_base_url("github.com", GitHost::GitHub, None)
                .unwrap()
                .as_deref(),
            Some("https://api.github.com")
        );
        assert_eq!(
            api_base_url("bitbucket.org", GitHost::Bitbucket, None)
                .unwrap()
                .as_deref(),
            Some("https://api.bitbucket.org/2.0")
        );
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::HashMap;
    use std::sync::Arc;

    use axum::extract::{OriginalUri, State};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::Value;

    use super::{ForgeAuthSource, ForgeContext, ForgeCredentials, ForgeHttp};
    use crate::domain::git::host::{GitHost, RemoteInfo};

    pub async fn json_fixture_server(routes: HashMap<String, Value>) -> String {
        async fn fixture(
            State(routes): State<Arc<HashMap<String, Value>>>,
            OriginalUri(uri): OriginalUri,
        ) -> Json<Value> {
            Json(
                routes
                    .get(uri.path())
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({ "error": "fixture route missing" })),
            )
        }

        let app = Router::new()
            .route("/graphql", post(fixture))
            .fallback(get(fixture))
            .with_state(Arc::new(routes));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fixture server");
        let address = listener.local_addr().expect("fixture server address");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("fixture server stays available");
        });
        format!("http://{address}")
    }

    pub fn fixture(name: &str) -> Value {
        let raw = match name {
            "github_pulls" => include_str!("fixtures/github_pulls.json"),
            "gitlab_merge_requests" => include_str!("fixtures/gitlab_merge_requests.json"),
            "bitbucket_pullrequests" => include_str!("fixtures/bitbucket_pullrequests.json"),
            "bitbucket_comments" => include_str!("fixtures/bitbucket_comments.json"),
            "github_review_threads" => include_str!("fixtures/github_review_threads.json"),
            _ => panic!("unknown fixture"),
        };
        serde_json::from_str(raw).expect("valid recorded forge fixture")
    }

    pub fn context(api_base_url: String, host: GitHost) -> ForgeContext {
        ForgeContext {
            remote: RemoteInfo {
                host,
                hostname: "forge.test".into(),
                web_base: "https://forge.test".into(),
                owner: "acme".into(),
                repo: "repo".into(),
            },
            api_base_url,
            credentials: ForgeCredentials {
                token: "fixture-token".into(),
                username: Some("developer@example.com".into()),
                source: ForgeAuthSource::Stored,
            },
            http: Arc::new(ForgeHttp::default()),
        }
    }

    #[tokio::test]
    async fn fixture_server_enforces_rest_and_graphql_methods() {
        let mut routes = HashMap::new();
        routes.insert("/rest".into(), serde_json::json!({ "ok": true }));
        routes.insert("/graphql".into(), serde_json::json!({ "data": {} }));
        let base = json_fixture_server(routes).await;
        let client = reqwest::Client::new();

        assert!(client
            .get(format!("{base}/rest"))
            .send()
            .await
            .expect("REST GET")
            .status()
            .is_success());
        assert_eq!(
            client
                .post(format!("{base}/rest"))
                .send()
                .await
                .expect("REST POST")
                .status(),
            reqwest::StatusCode::METHOD_NOT_ALLOWED
        );
        assert!(client
            .post(format!("{base}/graphql"))
            .send()
            .await
            .expect("GraphQL POST")
            .status()
            .is_success());
    }
}
