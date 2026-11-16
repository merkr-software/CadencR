//! HTTP endpoint that lists every discovered provider CLI install,
//! plus the currently-selected one and the persisted override (if any).
//!
//! Consumed by onboarding so the user can pick a binary explicitly when
//! discovery picks the wrong one or when nothing is found at all.

use std::collections::HashMap;
use std::path::PathBuf;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use cli_discovery::{Candidate, CandidateSource, DiscoverySpec};
use serde::Serialize;

use crate::app_state::AppState;
use crate::domain::agents::providers::provider_registry;
use crate::error::AppError;

use super::read_overrides;

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct DiscoveredCandidate {
    /// Path as discovered (may be a symlink/shim).
    pub path: String,
    /// Resolved through symlinks. Used by the UI to show the user the real
    /// binary behind a shim like nvm/asdf.
    pub canonical: String,
    /// Parsed semver, e.g. `"1.4.3"`. Absent when `--version` couldn't be
    /// parsed.
    pub version: Option<String>,
    /// Where the candidate was found.
    pub source: DiscoveredSource,
}

#[derive(Debug, Clone, Copy, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveredSource {
    Override,
    LoginShellPath,
    EnvPath,
    WellKnown,
}

impl From<CandidateSource> for DiscoveredSource {
    fn from(value: CandidateSource) -> Self {
        match value {
            CandidateSource::Override => Self::Override,
            CandidateSource::LoginShellPath => Self::LoginShellPath,
            CandidateSource::EnvPath => Self::EnvPath,
            CandidateSource::WellKnown => Self::WellKnown,
        }
    }
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ProviderDiscovery {
    pub bin_name: String,
    pub candidates: Vec<DiscoveredCandidate>,
    /// The candidate that would actually be spawned (highest semver, ties
    /// broken on source priority). `None` when the candidate list is empty.
    pub selected: Option<DiscoveredCandidate>,
    /// User-set override path persisted in settings. `None` if unset.
    pub override_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct BinaryDiscoveryResponse {
    /// Keyed by the discovery id declared by each provider registration.
    pub providers: HashMap<String, ProviderDiscovery>,
}

#[utoipa::path(
    get,
    path = "/api/agents/binary-discovery",
    responses((status = 200, body = BinaryDiscoveryResponse))
)]
pub async fn binary_discovery_handler(
    State(state): State<AppState>,
) -> Result<Json<BinaryDiscoveryResponse>, AppError> {
    // Read overrides once, then run discoveries in parallel — they're
    // independent and each spawns subprocesses we don't want to serialize.
    let overrides = read_overrides(&state.read_pool).await;
    let discoveries: Vec<_> = provider_registry()
        .discoveries()
        .map(|(_, discovery)| {
            let id = discovery.discovery_id().to_string();
            let spec = discovery.spec().clone();
            let override_path = overrides.get(&id).cloned();
            (id, spec, override_path)
        })
        .collect();
    let providers = futures::future::join_all(discoveries.into_iter().map(
        |(id, spec, override_path)| async move {
            let candidates = cli_discovery::discover_all(&spec, override_path.as_deref()).await;
            (
                id,
                build_provider_discovery(&spec, candidates, override_path),
            )
        },
    ))
    .await
    .into_iter()
    .collect::<HashMap<_, _>>();

    Ok(Json(BinaryDiscoveryResponse { providers }))
}

fn build_provider_discovery(
    spec: &DiscoverySpec,
    candidates: Vec<Candidate>,
    override_path: Option<PathBuf>,
) -> ProviderDiscovery {
    let selected = cli_discovery::select_best(&candidates).map(to_response);
    let candidates = candidates.iter().map(to_response).collect();
    ProviderDiscovery {
        bin_name: spec.bin_name.to_string(),
        candidates,
        selected,
        override_path: override_path.map(|p| p.display().to_string()),
    }
}

fn to_response(candidate: &Candidate) -> DiscoveredCandidate {
    DiscoveredCandidate {
        path: candidate.path.display().to_string(),
        canonical: candidate.canonical.display().to_string(),
        version: candidate.version.map(|v| v.to_string_dotted()),
        source: candidate.source.into(),
    }
}

pub fn discovery_router() -> Router<AppState> {
    Router::new().route(
        "/api/agents/binary-discovery",
        get(binary_discovery_handler),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use cli_discovery::VersionKey;

    #[test]
    fn build_provider_discovery_picks_highest_version_as_selected() {
        let spec = claude_agent_sdk_rs::claude_discovery_spec();
        let candidates = vec![
            Candidate {
                path: PathBuf::from("/a/claude"),
                canonical: PathBuf::from("/a/claude"),
                version: Some(VersionKey(1, 0, 0)),
                version_text: None,
                source: CandidateSource::EnvPath,
            },
            Candidate {
                path: PathBuf::from("/b/claude"),
                canonical: PathBuf::from("/b/claude"),
                version: Some(VersionKey(2, 0, 0)),
                version_text: None,
                source: CandidateSource::WellKnown,
            },
        ];
        let result = build_provider_discovery(&spec, candidates, None);
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(
            result.selected.expect("selected").version.as_deref(),
            Some("2.0.0")
        );
    }

    #[test]
    fn build_provider_discovery_surfaces_override_path_even_if_no_candidates() {
        let spec = claude_agent_sdk_rs::claude_discovery_spec();
        let result =
            build_provider_discovery(&spec, Vec::new(), Some(PathBuf::from("/some/override")));
        assert!(result.candidates.is_empty());
        assert!(result.selected.is_none());
        assert_eq!(result.override_path.as_deref(), Some("/some/override"));
    }

    #[test]
    fn provider_discovery_can_render_codex_spec() {
        let spec = codex_app_server_sdk_rs::codex_discovery_spec();
        let result = build_provider_discovery(&spec, Vec::new(), None);
        assert_eq!(result.bin_name, "codex");
        assert!(result.candidates.is_empty());
    }
}
