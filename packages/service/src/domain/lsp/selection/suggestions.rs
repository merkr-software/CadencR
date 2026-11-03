//! Installation prompts are for missing tooling, never for choosing between installed peers.
use super::{is_primary, managed, LspResolveResponse, LspSuggestion};
use crate::{
    domain::themes::managed::{catalog, models::SignedMixedCatalog},
    error::AppError,
};

pub(super) fn needed(response: &LspResolveResponse) -> bool {
    !response.language_id.is_empty()
        && !response.primary_disabled
        && !response.ignored
        && !response
            .candidates
            .iter()
            .any(|server| is_primary(server) && server.error.is_none())
}

pub(super) async fn add(
    response: &mut LspResolveResponse,
    index: SignedMixedCatalog,
) -> Result<(), AppError> {
    let root = managed::storage::root()?;
    let recommendations = managed::recommendations(index.clone()).await?;
    for (id, version) in recommendations {
        if managed::storage::removed(&root, &id)
            || response.candidates.iter().any(|server| server.lsp_id == id)
            || response
                .primary
                .as_ref()
                .is_some_and(|primary| primary != &id)
        {
            continue;
        }
        let package = catalog::resolve_kind(&index, &id, &version, "lsp")?;
        let probe = managed::storage::probe(
            &package,
            crate::domain::lsp::probe::ServerProbeStatus::Managed,
        )?;
        if probe.language_ids.contains(&response.language_id) && is_primary(&probe) {
            response.suggestions.push(LspSuggestion {
                lsp_id: id,
                version,
                reason: "Install language intelligence for this file".into(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::lsp::{
        catalog::ServerRole,
        selection::{resolve, tests::server},
    };
    use std::collections::BTreeMap;

    #[test]
    fn installed_peers_require_selection_instead_of_reinstallation() {
        let settings = BTreeMap::new();
        let installed = vec![
            server("one", ServerRole::General),
            server("two", ServerRole::TypeChecker),
        ];
        let unresolved = resolve("typescript", &settings, &settings, installed.clone()).unwrap();
        assert!(!needed(&unresolved));
        assert!(unresolved.error.unwrap().contains("Editor settings"));
        let settings = BTreeMap::from([(
            "editor_lsp_languages".into(),
            r#"{"typescript":{"primary":"two"}}"#.into(),
        )]);
        let selected = resolve("typescript", &settings, &BTreeMap::new(), installed).unwrap();
        assert!(!needed(&selected));
        assert_eq!(selected.servers.len(), 1);
        assert_eq!(selected.servers[0].lsp_id, "two");
        assert!(selected.error.is_none());
    }

    #[test]
    fn unknown_files_and_ignored_languages_never_evaluate_installation_recommendations() {
        let settings = BTreeMap::new();
        let unknown = resolve("", &settings, &settings, vec![]).unwrap();
        assert!(!needed(&unknown));
        let missing = resolve("typescript", &settings, &settings, vec![]).unwrap();
        assert!(needed(&missing));
        let settings = BTreeMap::from([(
            "editor_lsp_ignored_languages".into(),
            r#"["typescript"]"#.into(),
        )]);
        let ignored = resolve("typescript", &settings, &BTreeMap::new(), vec![]).unwrap();
        assert!(!needed(&ignored));
    }
}
