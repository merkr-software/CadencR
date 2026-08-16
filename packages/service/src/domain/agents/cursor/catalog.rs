use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tokio::sync::{Mutex, RwLock};

use crate::domain::agents::runtime::{
    ModelCatalogEntry, ProviderCatalogEntry, ProviderModeCatalogEntry, ProviderStatus,
};

use super::PROVIDER_ID;

const PROVIDER_LABEL: &str = "Cursor";
const FALLBACK_MODEL_ID: &str = "auto";
const CATALOG_TTL: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct CatalogCacheEntry {
    fetched_at: Instant,
    catalog: ProviderCatalogEntry,
}

static CATALOG_CACHE: OnceLock<RwLock<Option<CatalogCacheEntry>>> = OnceLock::new();
static CATALOG_REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn catalog_cache() -> &'static RwLock<Option<CatalogCacheEntry>> {
    CATALOG_CACHE.get_or_init(|| RwLock::new(None))
}

fn catalog_refresh_lock() -> &'static Mutex<()> {
    CATALOG_REFRESH_LOCK.get_or_init(|| Mutex::new(()))
}

pub(super) fn catalog_entry() -> ProviderCatalogEntry {
    ProviderCatalogEntry {
        id: PROVIDER_ID.to_string(),
        label: PROVIDER_LABEL.to_string(),
        icon_data: None,
        status: ProviderStatus::Available,
        status_message: None,
        models: vec![model_entry("auto", "Auto")],
        modes: mode_catalog(),
        access_modes: access_mode_catalog(),
        default_model: Some(FALLBACK_MODEL_ID.to_string()),
    }
}

pub(super) async fn catalog_entry_live() -> ProviderCatalogEntry {
    if let Some(catalog) = fresh_cached_catalog().await {
        return catalog;
    }
    let _refresh = catalog_refresh_lock().lock().await;
    if let Some(catalog) = fresh_cached_catalog().await {
        return catalog;
    }
    let catalog = probe_catalog().await;
    *catalog_cache().write().await = Some(CatalogCacheEntry {
        fetched_at: Instant::now(),
        catalog: catalog.clone(),
    });
    catalog
}

async fn fresh_cached_catalog() -> Option<ProviderCatalogEntry> {
    catalog_cache()
        .read()
        .await
        .as_ref()
        .filter(|entry| entry.fetched_at.elapsed() < CATALOG_TTL)
        .map(|entry| entry.catalog.clone())
}

async fn probe_catalog() -> ProviderCatalogEntry {
    match cursor_agent_sdk_rs::list_models_from_cli().await {
        Ok(models) => catalog_from_models(models),
        Err(cursor_agent_sdk_rs::SdkError::CliNotFound { searched }) => {
            ProviderCatalogEntry::unavailable(
                PROVIDER_ID,
                PROVIDER_LABEL,
                format!(
                    "Cursor Agent CLI not found; searched {} location(s)",
                    searched.len()
                ),
            )
        }
        Err(error) => {
            let mut fallback = catalog_entry();
            fallback.status_message = Some(format!(
                "Cursor model discovery unavailable; run `agent login`: {error}"
            ));
            fallback
        }
    }
}

fn catalog_from_models(models: Vec<cursor_agent_sdk_rs::CursorModel>) -> ProviderCatalogEntry {
    let default_model = models
        .iter()
        .find(|model| model.is_current)
        .or_else(|| models.iter().find(|model| model.id == FALLBACK_MODEL_ID))
        .or_else(|| models.first())
        .map(|model| model.id.clone())
        .or_else(|| Some(FALLBACK_MODEL_ID.to_string()));
    ProviderCatalogEntry {
        id: PROVIDER_ID.to_string(),
        label: PROVIDER_LABEL.to_string(),
        icon_data: None,
        status: ProviderStatus::Available,
        status_message: None,
        models: models
            .into_iter()
            .map(|model| model_entry(&model.id, &model.label))
            .collect(),
        modes: mode_catalog(),
        access_modes: access_mode_catalog(),
        default_model,
    }
}

fn access_mode_catalog() -> Vec<ProviderModeCatalogEntry> {
    vec![
        ProviderModeCatalogEntry {
            id: "default".to_string(),
            label: "Default".to_string(),
            description: Some(
                "Enables Cursor's sandbox and uses its configured approval rules. Explicitly allowed calls run and unmatched calls ask for approval."
                    .to_string(),
            ),
        },
        ProviderModeCatalogEntry {
            id: "fullAccess".to_string(),
            label: "Full Access".to_string(),
            description: Some(
                "Starts Cursor with Run Everything enabled and disables the sandbox. Commands run without approval unless an explicit deny rule blocks them."
                    .to_string(),
            ),
        },
        ProviderModeCatalogEntry {
            id: "autoReview".to_string(),
            label: "Auto Review".to_string(),
            description: Some(
                "Sandbox stays enabled. Ordinary shell allowlist misses and MCP calls are preflight-approved; explicit safety-policy requests still ask for approval."
                    .to_string(),
            ),
        },
    ]
}

fn mode_catalog() -> Vec<ProviderModeCatalogEntry> {
    vec![
        ProviderModeCatalogEntry {
            id: "default".to_string(),
            label: "Default".to_string(),
            description: Some("Cursor's default mode with full coding tools.".to_string()),
        },
        ProviderModeCatalogEntry {
            id: "plan".to_string(),
            label: "Plan".to_string(),
            description: Some("Read-only planning and design mode.".to_string()),
        },
        ProviderModeCatalogEntry {
            id: "ask".to_string(),
            label: "Ask".to_string(),
            description: Some("Read-only Q&A without edits or command execution.".to_string()),
        },
    ]
}

fn model_entry(id: &str, label: &str) -> ModelCatalogEntry {
    ModelCatalogEntry {
        id: id.to_string(),
        label: label.to_string(),
        description: None,
        // Cold `agent models` still lists effort/fast as distinct model ids.
        // Live ACP thought-level companions are applied from those ids; the
        // Cadencr effort chip stays off until the catalog publishes levels.
        supports_effort: Some(false),
        supported_effort_levels: None,
        default_effort_level: None,
        supports_adaptive_thinking: None,
        supports_fast_mode: None,
        supports_auto_mode: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{catalog_entry, catalog_from_models};
    use cursor_agent_sdk_rs::CursorModel;

    #[test]
    fn fallback_catalog_uses_auto() {
        let catalog = catalog_entry();
        assert_eq!(catalog.default_model.as_deref(), Some("auto"));
        assert_eq!(catalog.models[0].id, "auto");
        assert_eq!(
            catalog
                .modes
                .iter()
                .map(|mode| mode.id.as_str())
                .collect::<Vec<_>>(),
            vec!["default", "plan", "ask"]
        );
    }

    #[test]
    fn live_catalog_prefers_cli_current_model() {
        let catalog = catalog_from_models(vec![
            CursorModel {
                id: "auto".to_string(),
                label: "Auto".to_string(),
                is_current: false,
            },
            CursorModel {
                id: "composer-2".to_string(),
                label: "Composer 2".to_string(),
                is_current: true,
            },
        ]);
        assert_eq!(catalog.default_model.as_deref(), Some("composer-2"));
        assert_eq!(catalog.models.len(), 2);
        assert_eq!(catalog.models[1].supports_effort, Some(false));
    }
}
