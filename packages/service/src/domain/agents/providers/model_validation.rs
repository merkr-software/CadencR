use std::collections::BTreeSet;
use std::fmt;

use sqlx::SqlitePool;

use super::{provider_catalog_entry_live_for_settings, runtime_adapter};
use crate::domain::agents::adapter::AgentRuntimeAdapter;
use crate::domain::agents::runtime::ProviderCatalogEntry;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderModelValidationError {
    UnknownProvider {
        provider_id: String,
    },
    UnknownModel {
        provider_id: String,
        model_id: String,
        available_models: Vec<String>,
    },
}

impl fmt::Display for ProviderModelValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownProvider { provider_id } => {
                write!(formatter, "unknown provider '{provider_id}'")
            }
            Self::UnknownModel {
                provider_id,
                model_id,
                available_models,
            } => write!(
                formatter,
                "unknown model '{model_id}' for provider '{provider_id}'. Available models: {}",
                available_models.join(", ")
            ),
        }
    }
}

pub async fn validate_provider_model(
    read_pool: &SqlitePool,
    provider_id: &str,
    model_id: &str,
) -> Result<(), ProviderModelValidationError> {
    let Some(adapter) = runtime_adapter(provider_id) else {
        return Err(ProviderModelValidationError::UnknownProvider {
            provider_id: provider_id.to_string(),
        });
    };

    let catalog = provider_catalog_entry_live_for_settings(read_pool, None, None, adapter).await;
    if catalog.models.iter().any(|model| model.id == model_id)
        || adapter
            .catalog_entry()
            .models
            .iter()
            .any(|model| model.id == model_id)
    {
        return Ok(());
    }

    Err(ProviderModelValidationError::UnknownModel {
        provider_id: provider_id.to_string(),
        model_id: model_id.to_string(),
        available_models: available_model_ids(&catalog, adapter),
    })
}

fn available_model_ids(
    catalog: &ProviderCatalogEntry,
    adapter: &dyn AgentRuntimeAdapter,
) -> Vec<String> {
    catalog
        .models
        .iter()
        .chain(adapter.catalog_entry().models.iter())
        .map(|model| model.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
