//! The plugin policy table (`docs/CUSTOM_TABS.md` §4.3): the only service
//! routes a plugin token can reach.
//!
//! Deny by default. Each entry names a route exactly as it is registered with
//! axum (`MatchedPath`), the scope the grant must hold, how the request is tied
//! to the grant's feature or project, and its stability tier. A route may be
//! listed more than once — e.g. the features list is project-bound under
//! `features:read` and unbound under `workspace:read`; a request passes when
//! any entry it qualifies for holds.
//!
//! The same table drives `auth_middleware`, the filtered OpenAPI document
//! (`dump-openapi --plugin-surface`) and so the SDK's generated client.

/// A permission a tab requests in `tab.json` (§6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    FeaturesRead,
    GitRead,
    ForgeRead,
    FilesRead,
    AgentObserve,
    WorkspaceRead,
}

impl Scope {
    pub const ALL: [Scope; 6] = [
        Scope::FeaturesRead,
        Scope::GitRead,
        Scope::ForgeRead,
        Scope::FilesRead,
        Scope::AgentObserve,
        Scope::WorkspaceRead,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Scope::FeaturesRead => "features:read",
            Scope::GitRead => "git:read",
            Scope::ForgeRead => "forge:read",
            Scope::FilesRead => "files:read",
            Scope::AgentObserve => "agent:observe",
            Scope::WorkspaceRead => "workspace:read",
        }
    }

    pub fn parse(value: &str) -> Option<Scope> {
        Scope::ALL.into_iter().find(|scope| scope.as_str() == value)
    }

    /// The scopes a manifest's `permissions` grant; unknown names grant none.
    pub fn parse_all(permissions: &[String]) -> Vec<Scope> {
        permissions
            .iter()
            .filter_map(|scope| Scope::parse(scope))
            .collect()
    }
}

/// How a request is tied to the grant. `FeaturePath("id")` = the `{id}` path
/// parameter must equal the grant's feature; `…Query` reads a query parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binding {
    FeaturePath(&'static str),
    FeatureQuery(&'static str),
    ProjectPath(&'static str),
    ProjectQuery(&'static str),
    /// The plugin's own routes (`/api/plugin-tabs/self/…`): the handler scopes
    /// itself by the principal.
    SelfPlugin,
    /// No feature/project parameter (workspace-wide reads).
    Unbound,
}

/// `stable` routes are a promise; `proposed` ones may still change. Local
/// plugins may use both, a future marketplace only `stable`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Stable,
    Proposed,
}

impl Tier {
    pub const fn as_str(self) -> &'static str {
        match self {
            Tier::Stable => "stable",
            Tier::Proposed => "proposed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyEntry {
    pub method: &'static str,
    /// The axum route template, e.g. `/api/features/{id}`.
    pub path: &'static str,
    /// `None` only for `SelfPlugin` routes, which need no scope.
    pub scope: Option<Scope>,
    pub binding: Binding,
    pub tier: Tier,
}

const fn read(path: &'static str, scope: Scope, binding: Binding) -> PolicyEntry {
    PolicyEntry {
        method: "GET",
        path,
        scope: Some(scope),
        binding,
        tier: Tier::Proposed,
    }
}

const fn own(method: &'static str, path: &'static str) -> PolicyEntry {
    PolicyEntry {
        method,
        path,
        scope: None,
        binding: Binding::SelfPlugin,
        tier: Tier::Proposed,
    }
}

use Binding::{FeaturePath, FeatureQuery, ProjectQuery, Unbound};
use Scope::{AgentObserve, FeaturesRead, FilesRead, ForgeRead, GitRead, WorkspaceRead};

const FEATURE_ID: Binding = FeatureQuery("feature_id");
const PROJECT_ID: Binding = ProjectQuery("project_id");

pub static POLICY: &[PolicyEntry] = &[
    // features:read — the bound project and feature.
    read("/api/features/{id}", FeaturesRead, FeaturePath("id")),
    read(
        "/api/features/{id}/working-dir",
        FeaturesRead,
        FeaturePath("id"),
    ),
    read("/api/features", FeaturesRead, PROJECT_ID),
    read("/api/features/activity", FeaturesRead, PROJECT_ID),
    // git:read — the bound feature's worktree, the bound project's branches.
    read("/api/git/status", GitRead, FEATURE_ID),
    read("/api/git/diff", GitRead, FEATURE_ID),
    read("/api/git/file-diff", GitRead, FEATURE_ID),
    read("/api/git/changed-files", GitRead, FEATURE_ID),
    read("/api/git/uncommitted-files", GitRead, FEATURE_ID),
    read("/api/git/stats", GitRead, FEATURE_ID),
    read("/api/git/commit-log", GitRead, FEATURE_ID),
    read("/api/git/commit-graph", GitRead, FEATURE_ID),
    read("/api/git/file-content", GitRead, FEATURE_ID),
    read("/api/git/blame", GitRead, FEATURE_ID),
    // Git paths are checkout-relative, editor paths feature-relative: the
    // prefix converts one into the other in a monorepo subfolder project.
    read("/api/git/path-prefix", GitRead, FEATURE_ID),
    read("/api/git/branches", GitRead, PROJECT_ID),
    read("/api/git/branch", GitRead, PROJECT_ID),
    // forge:read — the bound feature's PR/MR.
    read("/api/git/pr", ForgeRead, FEATURE_ID),
    read("/api/git/pr/comments", ForgeRead, FEATURE_ID),
    // files:read — the bound feature's worktree (project root without one).
    read("/api/editor/root", FilesRead, FEATURE_ID),
    read("/api/editor/tree", FilesRead, FEATURE_ID),
    read("/api/editor/tree-all", FilesRead, FEATURE_ID),
    read("/api/editor/tree-count", FilesRead, FEATURE_ID),
    read("/api/editor/read", FilesRead, FEATURE_ID),
    read("/api/editor/search", FilesRead, FEATURE_ID),
    read("/api/editor/content-search", FilesRead, FEATURE_ID),
    // agent:observe — the bound feature's agent sessions.
    read(
        "/api/features/{feature_id}/sessions",
        AgentObserve,
        FeaturePath("feature_id"),
    ),
    read(
        "/api/features/{feature_id}/agent-state",
        AgentObserve,
        FeaturePath("feature_id"),
    ),
    read(
        "/api/features/{feature_id}/message-preview",
        AgentObserve,
        FeaturePath("feature_id"),
    ),
    read(
        "/api/features/{feature_id}/row-summary",
        AgentObserve,
        FeaturePath("feature_id"),
    ),
    read(
        "/api/features/{id}/pending-gate",
        AgentObserve,
        FeaturePath("id"),
    ),
    // workspace:read — projects and features across the workspace.
    read("/api/projects", WorkspaceRead, Unbound),
    read("/api/features", WorkspaceRead, Unbound),
    read("/api/features/activity", WorkspaceRead, Unbound),
    read("/api/features/recent", WorkspaceRead, Unbound),
    read("/api/features/active", WorkspaceRead, Unbound),
    read("/api/features/pinned", WorkspaceRead, Unbound),
    // The plugin's own routes: no scope, scoped by the principal.
    own("GET", "/api/plugin-tabs/self/configuration"),
    own("GET", "/api/plugin-tabs/self/storage"),
    own("GET", "/api/plugin-tabs/self/storage/{key}"),
    own("PUT", "/api/plugin-tabs/self/storage/{key}"),
    own("DELETE", "/api/plugin-tabs/self/storage/{key}"),
    own("POST", "/api/plugin-tabs/self/net/fetch"),
    // Gated by the manifest instead of a scope: the program must be listed in
    // `commands`, and `backend` must be declared (§4.6, §4.7).
    own("POST", "/api/plugin-tabs/self/exec"),
    own("POST", "/api/plugin-tabs/self/backend"),
    own("DELETE", "/api/plugin-tabs/grants/current"),
];

/// Every entry for `method` + route template, in table order.
pub fn entries_for<'a>(
    method: &'a str,
    matched_path: &'a str,
) -> impl Iterator<Item = &'static PolicyEntry> + 'a {
    POLICY
        .iter()
        .filter(move |entry| entry.method == method && entry.path == matched_path)
}

/// The scoped entries — the plugin's view of the service API, in table order.
pub fn surface() -> impl Iterator<Item = &'static PolicyEntry> {
    POLICY.iter().filter(|entry| entry.scope.is_some())
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    /// §4.3: never reachable with a plugin token, whatever the scope.
    const EXCLUDED_PREFIXES: [&str; 17] = [
        "/api/remote",
        "/api/push",
        "/api/agents",
        "/api/agent-",
        "/api/claude-code",
        "/api/codex",
        "/api/mcp",
        "/internal/",
        "/api/maintenance",
        "/api/workspace",
        "/api/projects/{id}/settings",
        "/api/projects/{id}/publication",
        "/api/features/{id}/settings",
        "/api/features/{id}/model-settings",
        "/api/features/{id}/provider-settings",
        "/api/themes",
        "/api/browser-bridge",
    ];

    #[test]
    fn excluded_surfaces_never_appear() {
        for entry in POLICY {
            for prefix in EXCLUDED_PREFIXES {
                assert!(
                    !entry.path.starts_with(prefix),
                    "{} {} is excluded by §4.3 ({prefix})",
                    entry.method,
                    entry.path
                );
            }
            // Plugin management (enablement, consent, grants, authoring) is the
            // host's; a plugin reaches only its own routes.
            if entry.path.starts_with("/api/plugin-tabs") {
                assert_eq!(entry.binding, Binding::SelfPlugin, "{}", entry.path);
                assert!(
                    entry.path.starts_with("/api/plugin-tabs/self/")
                        || entry.path == "/api/plugin-tabs/grants/current",
                    "{}",
                    entry.path
                );
            }
        }
    }

    #[test]
    fn scoped_entries_are_reads_and_self_entries_are_unscoped() {
        for entry in POLICY {
            match entry.binding {
                Binding::SelfPlugin => assert!(entry.scope.is_none(), "{}", entry.path),
                _ => {
                    assert!(entry.scope.is_some(), "{}", entry.path);
                    assert_eq!(entry.method, "GET", "{} must be read-only", entry.path);
                }
            }
        }
    }

    #[test]
    fn no_duplicate_entries_and_path_bindings_name_a_template_param() {
        let mut seen = HashSet::new();
        for entry in POLICY {
            assert!(
                seen.insert((entry.method, entry.path, entry.scope)),
                "duplicate {} {}",
                entry.method,
                entry.path
            );
            if let Binding::FeaturePath(param) | Binding::ProjectPath(param) = entry.binding {
                assert!(
                    entry.path.contains(&format!("{{{param}}}")),
                    "{} has no {{{param}}}",
                    entry.path
                );
            }
        }
    }

    /// The table cannot rot: every entry is a documented route with that verb.
    #[test]
    fn every_entry_is_a_registered_route() {
        let document = serde_json::to_value(crate::api::openapi::api_doc()).unwrap();
        for entry in POLICY {
            let operation =
                &document["paths"][entry.path][entry.method.to_ascii_lowercase().as_str()];
            assert!(
                operation.is_object(),
                "{} {} is not in the OpenAPI document",
                entry.method,
                entry.path
            );
        }
    }

    /// A tab id equal to a static `/api/plugin-tabs/<segment>` would have its
    /// `/api/plugin-tabs/{id}/…` routes shadowed by the host's own.
    #[test]
    fn every_static_plugin_tabs_segment_is_a_reserved_id() {
        let document = serde_json::to_value(crate::api::openapi::api_doc()).unwrap();
        let documented = document["paths"].as_object().unwrap().keys().cloned();
        let socket = std::iter::once(super::super::socket::SOCKET_PATH.to_string());
        for path in documented.chain(socket) {
            let Some(rest) = path.strip_prefix("/api/plugin-tabs/") else {
                continue;
            };
            let segment = rest.split('/').next().unwrap_or_default();
            if !segment.starts_with('{') {
                assert!(
                    cadencr_plugin_core::tab::RESERVED_IDS.contains(&segment),
                    "`{segment}` ({path}) must be in RESERVED_IDS"
                );
            }
        }
    }

    #[test]
    fn scopes_match_the_manifest_vocabulary() {
        let names: Vec<&str> = Scope::ALL.iter().map(|scope| scope.as_str()).collect();
        assert_eq!(names, cadencr_plugin_core::tab::SCOPES);
        assert_eq!(Scope::parse("git:read"), Some(Scope::GitRead));
        assert_eq!(Scope::parse("git:write"), None);
    }
}
