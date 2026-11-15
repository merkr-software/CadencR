use std::borrow::Cow;
use std::collections::BTreeSet;
use std::fmt;
use std::path::Path;

use sqlx::SqlitePool;

use super::registry::provider_identifier_key;
use super::{provider_catalog_entry_live_for_settings, provider_registry, runtime_adapter};
use crate::domain::agents::runtime::{ModelCatalogEntry, ProviderCatalogEntry};

/// Human-facing aliases and model guidance for a provider id.
///
/// `Cow` keeps the compiled-in table allocation-free while leaving room for
/// runtime-registered providers to supply owned metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAliasMetadata {
    pub provider_id: Cow<'static, str>,
    pub aliases: Vec<Cow<'static, str>>,
    pub model_guidance: Cow<'static, str>,
}

impl ProviderAliasMetadata {
    fn from_registration(provider: &super::registry::RegisteredProvider) -> Option<Self> {
        let metadata = provider.metadata();
        let model_guidance = metadata.model_guidance()?;
        Some(Self {
            provider_id: Cow::Owned(provider.id().to_string()),
            aliases: metadata.aliases().to_vec(),
            model_guidance: Cow::Owned(model_guidance.to_string()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderModelValidationError {
    UnknownProvider {
        provider_id: String,
        suggested_provider: Option<String>,
        valid_providers: Vec<String>,
    },
    UnknownModel {
        provider_id: String,
        model_id: String,
        available_models: Vec<String>,
    },
    UnsupportedThinkingLevel {
        provider_id: String,
        model_id: String,
        thinking_level: String,
        available_thinking_levels: Vec<String>,
    },
}

impl fmt::Display for ProviderModelValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownProvider {
                provider_id,
                suggested_provider,
                valid_providers,
            } => {
                write!(formatter, "unknown provider '{provider_id}'")?;
                if let Some(suggestion) = suggested_provider {
                    write!(formatter, ". Did you mean '{suggestion}'?")?;
                }
                write!(
                    formatter,
                    ". Valid providers: {}",
                    valid_providers.join(", ")
                )
            }
            Self::UnknownModel {
                provider_id,
                model_id,
                available_models,
            } => {
                write!(
                    formatter,
                    "unknown model '{model_id}' for provider '{provider_id}'"
                )?;
                write!(
                    formatter,
                    ". Available models: {}",
                    available_models.join(", ")
                )
            }
            Self::UnsupportedThinkingLevel {
                provider_id,
                model_id,
                thinking_level,
                available_thinking_levels,
            } => {
                write!(
                    formatter,
                    "unsupported thinking level '{thinking_level}' for model '{model_id}' on provider '{provider_id}'"
                )?;
                if available_thinking_levels.is_empty() {
                    write!(formatter, ". This model advertises no thinking levels")?;
                } else {
                    write!(
                        formatter,
                        ". Available thinking levels: {}",
                        available_thinking_levels.join(", ")
                    )?;
                }
                write!(
                    formatter,
                    ". Call project_list_agent_providers for current model capabilities"
                )
            }
        }
    }
}

pub fn canonical_provider_id(provider_id: &str) -> Option<String> {
    let normalized = provider_identifier_key(provider_id);

    provider_registry()
        .iter()
        .find(|provider| {
            provider_identifier_key(provider.id()) == normalized
                || provider
                    .metadata()
                    .aliases()
                    .iter()
                    .any(|alias| provider_identifier_key(alias) == normalized)
        })
        .map(|provider| provider.id().to_string())
}

pub fn valid_provider_ids() -> Vec<String> {
    provider_registry().provider_ids()
}

pub fn provider_aliases() -> Vec<(String, Vec<String>)> {
    provider_registry()
        .iter()
        .filter(|provider| !provider.metadata().aliases().is_empty())
        .map(|provider| {
            (
                provider.id().to_string(),
                provider
                    .metadata()
                    .aliases()
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            )
        })
        .collect()
}

pub fn provider_alias_metadata(provider_id: &str) -> Option<ProviderAliasMetadata> {
    provider_registry()
        .iter()
        .find(|provider| provider.id() == provider_id)
        .and_then(ProviderAliasMetadata::from_registration)
}

pub fn canonical_provider_or_error(
    provider_id: &str,
) -> Result<String, ProviderModelValidationError> {
    canonical_provider_id(provider_id).ok_or_else(|| {
        ProviderModelValidationError::UnknownProvider {
            provider_id: provider_id.to_string(),
            suggested_provider: suggested_provider_id(provider_id),
            valid_providers: valid_provider_ids(),
        }
    })
}

/// Validate a provider/model pair against the catalog for the session's
/// provider-specific profile.
pub async fn resolve_model_or_error_for_profile(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    provider_id: &str,
    model_id: &str,
    profile: Option<&str>,
) -> Result<(String, ModelCatalogEntry), ProviderModelValidationError> {
    let provider_id = canonical_provider_or_error(provider_id)?;
    let adapter = runtime_adapter(&provider_id).expect("canonical provider has adapter");
    let static_catalog = adapter.catalog_entry();
    let catalog =
        provider_catalog_entry_live_for_settings(read_pool, cwd, profile, adapter.as_adapter())
            .await;
    let known_models =
        super::merge_extra_models(static_catalog.models.clone(), catalog.models.clone());

    // Live/profile-aware entries replace static metadata on id collision while
    // static entries remain the fallback when a provider probe is unavailable.
    let canonical_model = adapter.canonicalize_model_id(model_id, &known_models);

    if let Some(catalog_entry) = known_models
        .iter()
        .find(|model| model.id == canonical_model)
        .cloned()
    {
        return Ok((canonical_model, catalog_entry));
    }

    Err(ProviderModelValidationError::UnknownModel {
        provider_id,
        model_id: model_id.to_string(),
        available_models: available_model_ids(&catalog, &static_catalog),
    })
}

/// Validate a user-selected thinking level against provider-advertised model
/// capabilities. Unknown capability metadata is accepted so a failed provider
/// probe cannot block spawning; explicit `supports_effort: false` and advertised
/// level lists remain authoritative.
pub fn validate_thinking_level_or_error(
    provider_id: &str,
    model: &ModelCatalogEntry,
    thinking_level: &str,
) -> Result<(), ProviderModelValidationError> {
    if model_supports_thinking_level(model, thinking_level) != Some(false) {
        return Ok(());
    }

    let advertised_levels = model.supported_effort_levels.as_deref();
    Err(ProviderModelValidationError::UnsupportedThinkingLevel {
        provider_id: provider_id.to_string(),
        model_id: model.id.clone(),
        thinking_level: thinking_level.to_string(),
        available_thinking_levels: advertised_levels.unwrap_or_default().to_vec(),
    })
}

/// Provider-neutral interpretation of advertised thinking capability. `None`
/// means the CLI did not provide enough metadata to reject the level safely.
pub fn model_supports_thinking_level(
    model: &ModelCatalogEntry,
    thinking_level: &str,
) -> Option<bool> {
    match model.supported_effort_levels.as_deref() {
        Some(levels) => Some(levels.iter().any(|level| level == thinking_level)),
        None if model.supports_effort == Some(false) => Some(false),
        None => None,
    }
}

/// Resolve one model's profile-aware live capability metadata, falling back to
/// the adapter's static catalog when the CLI probe is unavailable. With no
/// model id, selects the provider's advertised default model.
pub async fn provider_model_catalog_entry(
    read_pool: &SqlitePool,
    cwd: Option<&Path>,
    provider_id: &str,
    model_id: Option<&str>,
    profile: Option<&str>,
) -> Option<ModelCatalogEntry> {
    let adapter = runtime_adapter(provider_id)?;
    let live_catalog =
        provider_catalog_entry_live_for_settings(read_pool, cwd, profile, adapter.as_adapter())
            .await;
    let selected_model = model_id.or(live_catalog.default_model.as_deref());
    if let Some(model) = selected_model.and_then(|selected_model| {
        live_catalog
            .models
            .iter()
            .find(|model| model.id == selected_model)
    }) {
        return Some(model.clone());
    }

    let static_catalog = adapter.catalog_entry();
    let selected_model = model_id
        .or(live_catalog.default_model.as_deref())
        .or(static_catalog.default_model.as_deref())?;
    static_catalog
        .models
        .iter()
        .find(|model| model.id == selected_model)
        .cloned()
}

fn suggested_provider_id(provider_id: &str) -> Option<String> {
    let requested = provider_identifier_key(provider_id);
    provider_registry()
        .iter()
        .find(|provider| {
            provider_identifier_key(provider.id()).contains(&requested)
                || provider
                    .metadata()
                    .aliases()
                    .iter()
                    .any(|alias| provider_identifier_key(alias).contains(&requested))
        })
        .map(|provider| provider.id().to_string())
}

fn available_model_ids(
    catalog: &ProviderCatalogEntry,
    static_catalog: &ProviderCatalogEntry,
) -> Vec<String> {
    catalog
        .models
        .iter()
        .chain(static_catalog.models.iter())
        .map(|model| model.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod alias_resolution_tests {
    use super::canonical_provider_id;

    #[test]
    fn builtin_aliases_resolve_to_their_canonical_provider() {
        assert_eq!(
            canonical_provider_id("claude").as_deref(),
            Some("claude_code")
        );
        assert_eq!(
            canonical_provider_id("Claude Code").as_deref(),
            Some("claude_code")
        );
        assert_eq!(
            canonical_provider_id("openai").as_deref(),
            Some("codex_cli")
        );
    }
}
