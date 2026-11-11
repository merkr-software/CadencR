//! Plugin-token authorization (`docs/CUSTOM_TABS.md` §4.3): grant → policy
//! entry → scope → binding → [`PluginPrincipal`].
//!
//! Called by `auth_middleware` for requests carrying `x-cadencr-plugin-token`.
//! The route template comes from axum's `MatchedPath` and the path parameters
//! from `RawPathParams`, both stamped by the router before route-level
//! middleware runs, so the policy is matched against the route that will
//! actually serve the request. Query parameters are decoded by axum's own
//! `Query` decoder: a binding check that decoded differently from the handler
//! would be a bypass.

use axum::extract::{FromRequestParts, MatchedPath, Query, RawPathParams};
use axum::http::request::Parts;
use axum::http::StatusCode;

use super::grants::{Grant, GrantStore};
use super::policy::{self, Binding, PolicyEntry, Scope};
use crate::error::AppError;

/// The header carrying a grant token on plugin API requests.
pub const PLUGIN_TOKEN_HEADER: &str = "x-cadencr-plugin-token";

/// Who is calling: inserted as a request extension once a plugin token passes.
#[derive(Debug, Clone)]
pub struct PluginPrincipal {
    pub plugin_id: String,
    pub project_id: i64,
    /// The feature the grant is bound to: where `exec` runs and which
    /// backend `backend.request` reaches.
    pub feature_id: i64,
    /// The hash the grant was consented under; self routes refuse to act on a
    /// manifest whose hash has moved since (`plugin_routes::granted_manifest`).
    pub permissions_hash: String,
    /// The grant's store key (token hash), for `DELETE /grants/current`.
    pub grant_key: String,
}

impl From<&Grant> for PluginPrincipal {
    fn from(grant: &Grant) -> Self {
        Self {
            plugin_id: grant.plugin_id.clone(),
            project_id: grant.project_id,
            feature_id: grant.feature_id,
            permissions_hash: grant.permissions_hash.clone(),
            grant_key: grant.key.clone(),
        }
    }
}

/// Handlers of plugin-only routes take the principal as an extractor; a
/// request without one (the main token) is refused rather than a 500.
impl<S: Send + Sync> FromRequestParts<S> for PluginPrincipal {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<PluginPrincipal>()
            .cloned()
            .ok_or_else(|| {
                AppError::coded(
                    StatusCode::UNAUTHORIZED,
                    "PLUGIN_TOKEN_REQUIRED",
                    "this route is only for custom tabs (x-cadencr-plugin-token)",
                )
            })
    }
}

pub fn token_invalid() -> AppError {
    AppError::coded(
        StatusCode::UNAUTHORIZED,
        "PLUGIN_TOKEN_INVALID",
        "the plugin token is unknown, expired or revoked",
    )
}

/// Authorize the request whose `parts` were presented with plugin `token`.
pub async fn authorize(
    grants: &GrantStore,
    token: &str,
    parts: &mut Parts,
) -> Result<PluginPrincipal, AppError> {
    let grant = grants.resolve(token).ok_or_else(token_invalid)?;
    let matched = parts
        .extensions
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_string())
        .ok_or_else(|| scope_denied("this route is not part of the plugin API".into()))?;
    let method = parts.method.as_str().to_string();
    let entries: Vec<&PolicyEntry> = policy::entries_for(&method, &matched).collect();
    if entries.is_empty() {
        return Err(scope_denied(format!(
            "{method} {matched} is not part of the plugin API"
        )));
    }
    let granted: Vec<&PolicyEntry> = entries
        .iter()
        .copied()
        .filter(|entry| entry.scope.is_none_or(|scope| grant.has_scope(scope)))
        .collect();
    if granted.is_empty() {
        let needed: Vec<&str> = entries
            .iter()
            .filter_map(|entry| entry.scope.map(Scope::as_str))
            .collect();
        return Err(scope_denied(format!(
            "{method} {matched} requires {}",
            needed.join(" or ")
        )));
    }
    // Both decoders fail closed: an undecodable path or query binds nothing.
    let path = RawPathParams::from_request_parts(parts, &()).await.ok();
    let query = Query::<Vec<(String, String)>>::try_from_uri(&parts.uri)
        .ok()
        .map(|Query(pairs)| pairs);
    let request = Params {
        path: path.as_ref(),
        query: query.as_deref(),
    };
    if !granted
        .iter()
        .any(|entry| binding_holds(entry, &grant, &request))
    {
        return Err(AppError::coded(
            StatusCode::FORBIDDEN,
            "PLUGIN_BINDING_DENIED",
            format!(
                "{method} {matched} is limited to feature {} of project {}",
                grant.feature_id, grant.project_id
            ),
        ));
    }
    Ok(PluginPrincipal::from(&grant))
}

fn scope_denied(message: String) -> AppError {
    AppError::coded(StatusCode::FORBIDDEN, "PLUGIN_SCOPE_DENIED", message)
}

/// The request's parameters as the handler will see them; `None` when axum
/// could not decode them.
struct Params<'a> {
    path: Option<&'a RawPathParams>,
    query: Option<&'a [(String, String)]>,
}

impl Params<'_> {
    /// The integer value of path parameter `param`.
    fn path_id(&self, param: &str) -> Option<i64> {
        self.path?
            .iter()
            .find(|(name, _)| *name == param)
            .and_then(|(_, value)| value.parse().ok())
    }

    /// `Some(true)` when `param` occurs and every occurrence parses to
    /// `expected`, `Some(false)` when any occurrence does not (or the query is
    /// undecodable), `None` when it is absent.
    fn query_is(&self, param: &str, expected: i64) -> Option<bool> {
        let Some(pairs) = self.query else {
            return Some(false);
        };
        let mut values = pairs
            .iter()
            .filter(|(key, _)| key == param)
            .map(|(_, value)| value.parse::<i64>().ok() == Some(expected))
            .peekable();
        values.peek()?;
        Some(values.all(|matches| matches))
    }
}

/// The entry's binding holds, and — on any bound entry — every `feature_id`
/// / `project_id` query parameter names the grant's, so a route that takes
/// both cannot be pointed at another project through the one not bound.
fn binding_holds(entry: &PolicyEntry, grant: &Grant, request: &Params<'_>) -> bool {
    let feature = grant.feature_id;
    let project = grant.project_id;
    let primary = match entry.binding {
        Binding::Unbound => return true,
        Binding::SelfPlugin => true,
        Binding::FeaturePath(param) => request.path_id(param) == Some(feature),
        Binding::ProjectPath(param) => request.path_id(param) == Some(project),
        Binding::FeatureQuery(param) => request.query_is(param, feature) == Some(true),
        Binding::ProjectQuery(param) => request.query_is(param, project) == Some(true),
    };
    primary
        && request.query_is("feature_id", feature) != Some(false)
        && request.query_is("project_id", project) != Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::grants::GrantRequest;
    use axum::body::Body;
    use axum::extract::Request;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    fn store_with(scopes: Vec<Scope>) -> (GrantStore, String) {
        let store = GrantStore::default();
        let token = store
            .mint(
                GrantRequest::builder()
                    .plugin_id("graph".into())
                    .project_id(7)
                    .feature_id(42)
                    .scopes(scopes)
                    .permissions_hash("h".into())
                    .build(),
            )
            .token;
        (store, token)
    }

    /// The request parts exactly as a route-level middleware sees them:
    /// routed through a throwaway router for `template`, so `MatchedPath` and
    /// the URL params are axum's own.
    async fn parts(method: &str, template: &str, uri: &str) -> Parts {
        let slot: Arc<Mutex<Option<Parts>>> = Arc::default();
        let captured = slot.clone();
        let router = axum::Router::new().route(
            template,
            axum::routing::any(move |request: Request| {
                let captured = captured.clone();
                async move {
                    *captured.lock().unwrap() = Some(request.into_parts().0);
                }
            }),
        );
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        router.oneshot(request).await.unwrap();
        let parts = slot.lock().unwrap().take();
        parts.unwrap_or_else(|| panic!("{uri} does not route to {template}"))
    }

    async fn check(
        store: &GrantStore,
        token: &str,
        method: &str,
        template: &str,
        uri: &str,
    ) -> &'static str {
        let mut parts = parts(method, template, uri).await;
        match authorize(store, token, &mut parts).await {
            Ok(_) => "OK",
            Err(AppError::Coded { code, .. }) => code,
            Err(other) => panic!("unexpected error {other:?}"),
        }
    }

    /// A tab turns Git paths (checkout-relative) into editor paths with its
    /// feature's prefix, and only its own feature's.
    #[tokio::test]
    async fn git_read_covers_the_path_prefix_of_the_granted_feature_only() {
        let prefix = "/api/git/path-prefix";
        let (store, token) = store_with(vec![Scope::GitRead]);
        for (uri, expected) in [
            ("/api/git/path-prefix?feature_id=42", "OK"),
            (
                "/api/git/path-prefix?feature_id=43",
                "PLUGIN_BINDING_DENIED",
            ),
            (prefix, "PLUGIN_BINDING_DENIED"),
        ] {
            assert_eq!(
                check(&store, &token, "GET", prefix, uri).await,
                expected,
                "{uri}"
            );
        }
        let (store, token) = store_with(vec![Scope::FilesRead, Scope::FeaturesRead]);
        assert_eq!(
            check(
                &store,
                &token,
                "GET",
                prefix,
                "/api/git/path-prefix?feature_id=42"
            )
            .await,
            "PLUGIN_SCOPE_DENIED"
        );
    }

    #[tokio::test]
    async fn walks_grant_policy_scope_and_binding_in_order() {
        let (store, token) = store_with(vec![Scope::GitRead, Scope::FeaturesRead]);
        let status = "/api/git/status";
        assert_eq!(
            check(&store, "nope", "GET", status, status).await,
            "PLUGIN_TOKEN_INVALID"
        );
        for (method, template, uri, expected) in [
            ("GET", status, "/api/git/status?feature_id=42", "OK"),
            (
                "GET",
                status,
                "/api/git/status?feature_id=43",
                "PLUGIN_BINDING_DENIED",
            ),
            ("GET", status, "/api/git/status", "PLUGIN_BINDING_DENIED"),
            (
                "GET",
                "/api/git/blame",
                "/api/git/blame?feature_id=42&project_id=8",
                "PLUGIN_BINDING_DENIED",
            ),
            (
                "GET",
                "/api/git/blame",
                "/api/git/blame?feature_id=42&project_id=7",
                "OK",
            ),
            ("GET", "/api/features/{id}", "/api/features/42", "OK"),
            (
                "GET",
                "/api/features/{id}",
                "/api/features/41",
                "PLUGIN_BINDING_DENIED",
            ),
            (
                "POST",
                status,
                "/api/git/status?feature_id=42",
                "PLUGIN_SCOPE_DENIED",
            ),
            (
                "GET",
                "/api/editor/read",
                "/api/editor/read?feature_id=42",
                "PLUGIN_SCOPE_DENIED",
            ),
            (
                "GET",
                "/api/remote/status",
                "/api/remote/status",
                "PLUGIN_SCOPE_DENIED",
            ),
            // Project-bound under features:read; workspace-wide needs workspace:read.
            ("GET", "/api/features", "/api/features?project_id=7", "OK"),
            (
                "GET",
                "/api/features",
                "/api/features?project_id=9",
                "PLUGIN_BINDING_DENIED",
            ),
            (
                "GET",
                "/api/features",
                "/api/features",
                "PLUGIN_BINDING_DENIED",
            ),
        ] {
            assert_eq!(
                check(&store, &token, method, template, uri).await,
                expected,
                "{method} {uri}"
            );
        }
    }

    /// Parameters are read the way the handler's extractors read them.
    #[tokio::test]
    async fn bindings_decode_like_the_handlers() {
        let (store, token) = store_with(vec![Scope::GitRead, Scope::FeaturesRead]);
        let status = "/api/git/status";
        let feature = "/api/features/{id}";
        for (template, uri, expected) in [
            // Percent-encoded values and names decode before comparison.
            (feature, "/api/features/%34%32", "OK"),
            (status, "/api/git/status?feature_id=%34%32", "OK"),
            (
                status,
                "/api/git/status?feature_%69d=43&feature_id=42",
                "PLUGIN_BINDING_DENIED",
            ),
            // An encoded slash stays inside the one segment: `42/` is no id.
            (feature, "/api/features/42%2F", "PLUGIN_BINDING_DENIED"),
            (feature, "/api/features/4%2F2", "PLUGIN_BINDING_DENIED"),
            // Every occurrence of a repeated parameter must match.
            (
                status,
                "/api/git/status?feature_id=42&feature_id=43",
                "PLUGIN_BINDING_DENIED",
            ),
            (status, "/api/git/status?feature_id=42&feature_id=42", "OK"),
            (
                status,
                "/api/git/status?feature_id=42&project_id=7&project_id=8",
                "PLUGIN_BINDING_DENIED",
            ),
            // `+` is a space in a query: `42+` is not 42, and `feature+id` is
            // another key the handler ignores too.
            (
                status,
                "/api/git/status?feature_id=42+",
                "PLUGIN_BINDING_DENIED",
            ),
            // An encoded `+` is a sign, parsed exactly as the handler parses it.
            (status, "/api/git/status?feature_id=%2B42", "OK"),
            (status, "/api/git/status?feature+id=43&feature_id=42", "OK"),
            (
                status,
                "/api/git/status?feature%20id=43&feature_id=42",
                "OK",
            ),
        ] {
            assert_eq!(
                check(&store, &token, "GET", template, uri).await,
                expected,
                "{uri}"
            );
        }
    }

    #[tokio::test]
    async fn workspace_scope_unbinds_the_shared_reads_and_self_routes_need_no_scope() {
        let (store, token) = store_with(vec![Scope::WorkspaceRead]);
        for (method, template, uri, expected) in [
            ("GET", "/api/features", "/api/features?project_id=9", "OK"),
            ("GET", "/api/projects", "/api/projects", "OK"),
            (
                "GET",
                "/api/git/status",
                "/api/git/status?feature_id=42",
                "PLUGIN_SCOPE_DENIED",
            ),
            (
                "PUT",
                "/api/plugin-tabs/self/storage/{key}",
                "/api/plugin-tabs/self/storage/a",
                "OK",
            ),
            (
                "DELETE",
                "/api/plugin-tabs/grants/current",
                "/api/plugin-tabs/grants/current",
                "OK",
            ),
            // A self route still refuses another feature named in its query.
            (
                "DELETE",
                "/api/plugin-tabs/grants/current",
                "/api/plugin-tabs/grants/current?feature_id=1",
                "PLUGIN_BINDING_DENIED",
            ),
        ] {
            assert_eq!(
                check(&store, &token, method, template, uri).await,
                expected,
                "{method} {uri}"
            );
        }
        let mut parts = parts("GET", "/api/projects", "/api/projects").await;
        let principal = authorize(&store, &token, &mut parts).await.unwrap();
        assert_eq!(
            (principal.plugin_id.as_str(), principal.project_id),
            ("graph", 7)
        );
        assert_eq!(principal.permissions_hash, "h");
    }
}
