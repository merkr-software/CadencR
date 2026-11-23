//! OpenCode 2.x model catalog: `GET /api/model` and `GET /api/model/default`.
//!
//! 2.x dropped `opencode models --verbose`. Its API lists `Model.Info`
//! records whose `id` is the model id inside its provider (it may itself hold
//! a `/`, as OpenRouter ids do) and whose `providerID` names the provider; ACP
//! refers to a model as `<providerID>/<id>`.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use crate::error::SdkError;
use crate::models::group_by_provider;
use crate::standalone_api::StandaloneApi;
use crate::types::{ConfigModelLimit, ConfigProviderModel, ConfigProvidersResponse};

#[derive(Debug, Deserialize)]
struct ModelInfo {
    id: String,
    #[serde(rename = "providerID")]
    provider_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    limit: Option<ConfigModelLimit>,
    #[serde(default)]
    variants: Vec<Variant>,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct Variant {
    id: String,
}

fn enabled_by_default() -> bool {
    true
}

/// The 2.x catalog of `binary`, read through a short-lived private server.
pub async fn list_models_from_api(
    binary: &Path,
    cwd: Option<&Path>,
) -> Result<ConfigProvidersResponse, SdkError> {
    let api = StandaloneApi::new(binary.to_path_buf(), cwd.map(Path::to_path_buf));
    // One after the other: each request boots OpenCode on the shared
    // database, and the first boot after an upgrade migrates it.
    let models = api.models().await?;
    // No default model is a normal state (no provider connected yet).
    let default = match api.default_model().await {
        Ok(default) => Some(default),
        Err(SdkError::HttpStatus { status: 404, .. }) => None,
        Err(error) => return Err(error),
    };
    parse_models_response(&models, default.as_ref())
}

pub fn parse_models_response(
    models: &Value,
    default: Option<&Value>,
) -> Result<ConfigProvidersResponse, SdkError> {
    let data = models
        .get("data")
        .cloned()
        .ok_or_else(|| SdkError::Protocol("OpenCode model list has no data".to_string()))?;
    let infos: Vec<ModelInfo> = serde_json::from_value(data)?;
    let providers = group_by_provider(infos.into_iter().filter(|info| info.enabled).map(|info| {
        (
            info.provider_id,
            ConfigProviderModel {
                id: info.id,
                name: info.name,
                limit: info.limit,
                variants: info
                    .variants
                    .into_iter()
                    .map(|variant| variant.id)
                    .collect(),
            },
        )
    }));
    let default = default
        .and_then(|default| default.get("data"))
        .and_then(|data| {
            Some((
                data.get("providerID")?.as_str()?.to_string(),
                data.get("id")?.as_str()?.to_string(),
            ))
        })
        .into_iter()
        .collect();
    Ok(ConfigProvidersResponse { providers, default })
}

#[cfg(test)]
mod tests {
    use super::parse_models_response;
    use serde_json::json;

    #[test]
    fn groups_models_by_provider_with_windows_variants_and_default() {
        let models = json!({
            "location": { "directory": "/repo" },
            "data": [
                {
                    "id": "anthropic/claude-haiku-5.5",
                    "providerID": "openrouter",
                    "name": "Claude Haiku 5.5",
                    "limit": { "context": 1000000, "output": 64000 },
                    "variants": [{ "id": "low", "settings": {} }, { "id": "high", "settings": {} }],
                    "enabled": true
                },
                { "id": "big-pickle", "providerID": "opencode", "name": "Big Pickle" },
                { "id": "retired", "providerID": "opencode", "enabled": false }
            ]
        });
        let default = json!({ "data": { "id": "big-pickle", "providerID": "opencode" } });

        let response = parse_models_response(&models, Some(&default)).unwrap();

        assert_eq!(response.providers.len(), 2);
        let openrouter = &response.providers[0];
        assert_eq!(openrouter.id, "openrouter");
        let haiku = &openrouter.models[0];
        assert_eq!(haiku.id, "anthropic/claude-haiku-5.5");
        assert_eq!(haiku.limit.as_ref().unwrap().context, Some(1_000_000));
        assert_eq!(haiku.variants, vec!["low".to_string(), "high".to_string()]);
        let opencode = &response.providers[1];
        assert_eq!(opencode.models.len(), 1, "disabled models are dropped");
        assert!(opencode.models[0].variants.is_empty());
        assert_eq!(
            response.default.get("opencode").map(String::as_str),
            Some("big-pickle")
        );
    }

    #[test]
    fn a_missing_default_leaves_the_default_map_empty() {
        let models = json!({ "data": [] });
        let response = parse_models_response(&models, None).unwrap();
        assert!(response.providers.is_empty());
        assert!(response.default.is_empty());
    }

    #[test]
    fn a_response_without_data_is_a_protocol_error() {
        assert!(parse_models_response(&json!({}), None).is_err());
    }
}
