//! Per-language preferences resolve project fields over global fields without rewriting legacy choices.
mod preferences;
mod suggestions;
use super::{catalog::ServerRole, managed, probe::ServerProbe};
use crate::{app_state::AppState, domain::settings_store, error::AppError};
use axum::{
    extract::{Query, State},
    Json,
};
pub use preferences::valid_preferences;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Deserialize, IntoParams)]
pub struct LspResolveParams {
    pub project_id: Option<i64>,
    pub language_id: Option<String>,
    pub file_path: Option<String>,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct LspSuggestion {
    pub lsp_id: String,
    pub version: String,
    pub reason: String,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct LspResolveResponse {
    pub language_id: String,
    pub servers: Vec<ServerProbe>,
    pub candidates: Vec<ServerProbe>,
    pub primary: Option<String>,
    pub linters: Vec<String>,
    pub primary_disabled: bool,
    pub ignored: bool,
    pub suggestions: Vec<LspSuggestion>,
    pub error: Option<String>,
    pub catalog_warning: Option<String>,
}
#[utoipa::path(get, path="/api/lsp/resolve", params(LspResolveParams), responses((status=200, body=LspResolveResponse)))]
pub async fn resolve_handler(
    State(state): State<AppState>,
    Query(params): Query<LspResolveParams>,
) -> Result<Json<LspResolveResponse>, AppError> {
    let (_, global, global_warnings) = settings_store::global_map();
    let (project, warnings) = if let Some(id) = params.project_id {
        let (_, map, warnings) = settings_store::project_map(&state.read_pool, id).await?;
        (map, warnings)
    } else {
        (BTreeMap::new(), vec![])
    };
    let installed = managed::inventory().await?;
    // Only a current authenticated disk cache can supply suggestions. File opens never fetch.
    let cached = crate::domain::themes::managed::catalog::cached_catalog().await;
    let (index, catalog_error) = match cached {
        Ok(index) => (index, None),
        Err(error) => (None, Some(error.to_string())),
    };
    let language = resolve_language(&params, &installed, index.as_ref());
    let mut response = resolve(&language, &global, &project, installed)?;
    if let Some(index) = index {
        if suggestions::needed(&response) {
            suggestions::add(&mut response, index).await?;
        }
    }
    let mut errors = global_warnings
        .into_iter()
        .chain(warnings)
        .map(|warning| warning.message)
        .collect::<Vec<_>>();
    if let Some(error) = response.error.take() {
        errors.push(error);
    }
    // Catalog availability cannot turn a usable installed runtime into an error.
    response.catalog_warning = catalog_error;
    response.error = (!errors.is_empty()).then(|| errors.join("; "));
    Ok(Json(response))
}
fn resolve_language(
    params: &LspResolveParams,
    installed: &[ServerProbe],
    index: Option<&crate::domain::themes::managed::models::SignedMixedCatalog>,
) -> String {
    if let Some(language) = params
        .language_id
        .as_ref()
        .filter(|id| !id.is_empty() && id.as_str() != "plaintext")
    {
        return language.clone();
    }
    let Some(path) = &params.file_path else {
        return String::new();
    };
    if let Some(language) = detect_language(path, installed) {
        return language;
    }
    let servers = index
        .map(|index| {
            cadencr_registry_core::catalog_members(&index.signed.packages)
                .filter(|entry| entry["kind"] == "lsp")
                .filter_map(|entry| {
                    managed::storage::probe(
                        &entry["package"],
                        super::probe::ServerProbeStatus::Managed,
                    )
                    .ok()
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    detect_language(path, &servers).unwrap_or_default()
}
fn detect_language(path: &str, servers: &[ServerProbe]) -> Option<String> {
    let filename = Path::new(path).file_name()?.to_str()?;
    let languages = || servers.iter().flat_map(|server| &server.languages);
    if let Some(language) =
        languages().find(|language| language.filenames.iter().any(|name| name == filename))
    {
        return Some(language.id.clone());
    }
    languages()
        .flat_map(|language| {
            language
                .extensions
                .iter()
                .map(move |extension| (language, extension))
        })
        .filter(|(_, extension)| {
            filename
                .strip_suffix(extension.as_str())
                .is_some_and(|prefix| prefix.ends_with('.'))
        })
        .max_by_key(|(_, extension)| extension.len())
        .map(|(language, _)| language.id.clone())
}
fn is_primary(server: &ServerProbe) -> bool {
    matches!(server.role, ServerRole::TypeChecker | ServerRole::General)
}
pub(super) fn resolve(
    language: &str,
    global: &BTreeMap<String, String>,
    project: &BTreeMap<String, String>,
    installed: Vec<ServerProbe>,
) -> Result<LspResolveResponse, AppError> {
    let preferences = preferences::read(language, global, project)?;
    let primary_value = preferences.primary_value;
    let primary_disabled = preferences.primary_disabled;
    let candidates = installed
        .iter()
        .filter(|server| server.language_ids.iter().any(|id| id == language))
        .cloned()
        .collect::<Vec<_>>();
    let primary = primary_value
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .filter(|id| *id != "off")
        .map(str::to_string)
        .or_else(|| {
            let ready = candidates
                .iter()
                .filter(|server| server.error.is_none() && is_primary(server))
                .collect::<Vec<_>>();
            (!primary_disabled && ready.len() == 1).then(|| ready[0].lsp_id.clone())
        });
    let linters = preferences.linters;
    let ignored = preferences.ignored;
    // Primary owns editor navigation and must precede all diagnostics-only peers.
    let mut servers = Vec::new();
    if let Some(server) = candidates.iter().find(|server| {
        primary.as_ref() == Some(&server.lsp_id) && is_primary(server) && server.error.is_none()
    }) {
        servers.push(server.clone());
    }
    for id in &linters {
        if let Some(server) = candidates.iter().find(|server| {
            &server.lsp_id == id && server.role == ServerRole::Linter && server.error.is_none()
        }) {
            if !servers
                .iter()
                .any(|existing| existing.lsp_id == server.lsp_id)
            {
                servers.push(server.clone());
            }
        }
    }
    let mut errors = installed
        .iter()
        .filter(|server| {
            primary.as_ref() == Some(&server.lsp_id) || linters.contains(&server.lsp_id)
        })
        .filter_map(|server| server.error.as_ref())
        .cloned()
        .collect::<Vec<_>>();
    if primary.is_none()
        && !primary_disabled
        && candidates
            .iter()
            .filter(|server| is_primary(server) && server.error.is_none())
            .count()
            > 1
    {
        errors.push(super::catalog::SELECTION_REQUIRED.into());
    }
    Ok(LspResolveResponse {
        language_id: language.into(),
        servers,
        candidates,
        primary,
        linters,
        primary_disabled,
        ignored,
        suggestions: vec![],
        catalog_warning: None,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::lsp::probe::{LspLanguage, ServerProbeStatus};

    pub(super) fn server(id: &str, role: ServerRole) -> ServerProbe {
        ServerProbe {
            lsp_id: id.into(),
            name: id.into(),
            description: String::new(),
            bin_name: id.into(),
            args: vec![],
            language_ids: vec!["typescript".into()],
            root_markers: vec![],
            role,
            languages: vec![LspLanguage {
                id: "typescript".into(),
                extensions: vec!["ts".into()],
                filenames: vec![],
            }],
            status: ServerProbeStatus::Managed,
            path: Some("/installed/server".into()),
            version: Some("1.0.0".into()),
            downloadable: false,
            initialization_options: serde_json::json!({}),
            error: None,
        }
    }
    #[test]
    fn primary_precedes_alphabetically_earlier_linters_and_preserves_selection_order() {
        let global = BTreeMap::from([(
            "editor_lsp_languages".into(),
            r#"{"typescript":{"primary":"tsgo","linters":["eslint","biome","eslint"]}}"#.into(),
        )]);
        let installed = vec![
            server("biome", ServerRole::Linter),
            server("eslint", ServerRole::Linter),
            server("tsgo", ServerRole::TypeChecker),
        ];
        let result = resolve("typescript", &global, &BTreeMap::new(), installed).unwrap();
        assert_eq!(
            result
                .servers
                .iter()
                .map(|server| server.lsp_id.as_str())
                .collect::<Vec<_>>(),
            ["tsgo", "eslint", "biome"]
        );
    }
    #[test]
    fn multiple_primary_peers_require_choice_but_a_unique_server_starts_automatically() {
        let settings = BTreeMap::new();
        let installed = vec![
            server("one", ServerRole::General),
            server("two", ServerRole::TypeChecker),
        ];
        let result = resolve("typescript", &settings, &settings, installed.clone()).unwrap();
        assert_eq!(result.primary, None);
        assert!(result.servers.is_empty());
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(
            resolve(
                "typescript",
                &settings,
                &settings,
                vec![installed[0].clone()]
            )
            .unwrap()
            .primary
            .as_deref(),
            Some("one")
        );
    }
    #[test]
    fn broken_explicit_selection_does_not_fall_back_and_surfaces_the_error() {
        let settings = BTreeMap::from([(
            "editor_lsp_languages".into(),
            r#"{"typescript":{"primary":"broken"}}"#.into(),
        )]);
        let mut broken = server("broken", ServerRole::TypeChecker);
        broken.error = Some("Signed receipt has been changed".into());
        let result = resolve(
            "typescript",
            &settings,
            &BTreeMap::new(),
            vec![broken, server("other", ServerRole::TypeChecker)],
        )
        .unwrap();
        assert!(result.servers.is_empty());
        assert_eq!(result.primary.as_deref(), Some("broken"));
        assert!(result.error.unwrap().contains("receipt"));
    }
    #[test]
    fn selections_are_constrained_by_language_and_role() {
        let settings = BTreeMap::from([(
            "editor_lsp_languages".into(),
            r#"{"rust":{"primary":"tsgo","linters":["tsgo"]}}"#.into(),
        )]);
        let installed = vec![server("tsgo", ServerRole::TypeChecker)];
        assert!(
            resolve("rust", &settings, &BTreeMap::new(), installed.clone())
                .unwrap()
                .servers
                .is_empty()
        );
    }
    #[test]
    fn ignoring_suggestions_does_not_disable_installed_primary_or_linters() {
        let settings = BTreeMap::from([(
            "editor_lsp_ignored_languages".into(),
            r#"["typescript"]"#.into(),
        )]);
        let project = BTreeMap::from([(
            "editor_lsp_languages".into(),
            r#"{"typescript":{"primary":"tsgo","linters":["eslint"]}}"#.into(),
        )]);
        let installed = vec![
            server("tsgo", ServerRole::TypeChecker),
            server("eslint", ServerRole::Linter),
        ];
        let result = resolve("typescript", &settings, &project, installed).unwrap();
        assert!(result.ignored);
        assert_eq!(
            result
                .servers
                .iter()
                .map(|server| server.lsp_id.as_str())
                .collect::<Vec<_>>(),
            ["tsgo", "eslint"]
        );
        assert!(!suggestions::needed(&result));
    }
    #[test]
    fn filename_wins_and_longest_multi_dot_extension_wins_independent_of_order() {
        let mut entry = server("mixed", ServerRole::General);
        entry.languages.push(LspLanguage {
            id: "declaration".into(),
            extensions: vec!["d.ts".into()],
            filenames: vec![],
        });
        entry.languages.push(LspLanguage {
            id: "config".into(),
            extensions: vec![],
            filenames: vec!["settings.d.ts".into()],
        });
        assert_eq!(
            detect_language("/project/types.d.ts", &[entry.clone()]).as_deref(),
            Some("declaration")
        );
        assert_eq!(
            detect_language("/project/settings.d.ts", &[entry.clone()]).as_deref(),
            Some("config")
        );
        assert_eq!(detect_language("/project/not-ts", &[entry]), None);
    }
}
