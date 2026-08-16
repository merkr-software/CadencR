//! Diagnostics and durable lifecycle operations for local ACP descriptors.
//!
//! Rejections and quarantines have to be visible somewhere the user can reach.
//! A rejected descriptor never gets a catalog entry (registering an id we could
//! not verify is exactly what rejection prevents), so without this endpoint the
//! only trace would be a log line the user never sees. Quarantined installs do
//! reach the catalog, as unavailable — they are repeated here so both failure
//! shapes are readable from one place.
//!
//! Environment values are deliberately absent from the response: they are host
//! launch policy and may carry secrets.

use axum::extract::rejection::JsonRejection;
use axum::extract::Path;
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::domain::agents::providers::provider_registry;
use crate::error::AppError;

use super::descriptor::ProviderDescriptor;
use super::installation::HostInstallation;
use super::lifecycle::{install_descriptor, remove_descriptor, set_descriptor_enabled};
use super::rejection::{DescriptorRejection, RejectionCode};
use super::{descriptors_dir, load_descriptors};

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct InstalledProvidersResponse {
    /// Directory the descriptors were read from. Present even when empty so the
    /// user knows where to put one.
    pub directory: String,
    pub installed: Vec<InstalledProviderEntry>,
    pub rejected: Vec<InstalledProviderRejection>,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct InstalledProviderEntry {
    /// Catalog id, owned by the portable ACP registry entry.
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// A non-fatal packaging problem that prevented the declared icon from
    /// loading. Runtime availability is independent from visual metadata.
    pub icon_issue: Option<String>,
    pub source_path: String,
    pub enabled: bool,
    /// Whether the provider actually joined the runtime registry this boot.
    pub registered: bool,
    /// Stable SCREAMING_SNAKE code when the install cannot launch; `null` when
    /// it can. This is the only availability signal — the catalog's
    /// `unavailable` status is derived from the same fact.
    pub quarantine_code: Option<String>,
    /// Why the install cannot launch, when it cannot.
    pub quarantine_message: Option<String>,
    /// The resolved program. The argument vector is deliberately absent: an
    /// argument can carry a credential (`--token …`) and, unlike a fixed set of
    /// env names, there is no generic way to redact one safely.
    pub executable: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct InstalledProviderRejection {
    pub source_path: String,
    /// The id the descriptor claimed, when it parsed far enough to claim one.
    pub provider_id: Option<String>,
    /// Stable SCREAMING_SNAKE code.
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct SetInstalledProviderEnabledRequest {
    pub enabled: bool,
}

/// A descriptor mutation is durable immediately, while runtime activation is
/// intentionally deferred until restart so the registry stays immutable.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct InstalledProviderMutationResponse {
    pub provider_id: String,
    pub enabled_after_restart: bool,
    pub active_now: bool,
    pub active_after_restart: bool,
    /// Whether the durable next-boot activation differs from this process.
    pub restart_required: bool,
}

#[utoipa::path(
    get,
    path = "/api/agents/installed-providers",
    responses((status = 200, body = InstalledProvidersResponse))
)]
pub async fn installed_providers_handler() -> Result<Json<InstalledProvidersResponse>, AppError> {
    // Rescan durable files for diagnostics so a successful lifecycle mutation
    // is immediately visible. The process registry remains the authority for
    // `registered`, and is deliberately never mutated by this read.
    let directory = descriptors_dir();
    let outcome = tokio::task::spawn_blocking(move || load_descriptors(&directory))
        .await
        .map_err(|error| AppError::Internal(format!("provider descriptor scan failed: {error}")))?;
    let registry = provider_registry();
    Ok(Json(InstalledProvidersResponse {
        directory: outcome.directory.display().to_string(),
        installed: outcome
            .installations
            .iter()
            .map(|installation| entry(installation, registry.contains(installation.provider_id())))
            .collect(),
        rejected: outcome.rejections.iter().map(rejection).collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/api/agents/installed-providers",
    request_body = ProviderDescriptor,
    responses(
        (status = 200, body = InstalledProviderMutationResponse),
        (status = 400, description = "Descriptor is invalid"),
        (status = 409, description = "Provider id is already installed or reserved")
    )
)]
pub async fn install_provider_handler(
    payload: Result<Json<ProviderDescriptor>, JsonRejection>,
) -> Result<Json<InstalledProviderMutationResponse>, AppError> {
    let Json(descriptor) = payload.map_err(descriptor_json_rejection)?;
    let provider_id = descriptor.agent.id.clone();
    let enabled = descriptor.installation.enabled;
    let registry = provider_registry();
    let active_now = registry.contains(&provider_id);
    install_descriptor(&descriptors_dir(), descriptor, &registry.provider_ids()).await?;
    Ok(Json(mutation_response(provider_id, active_now, enabled)))
}

#[utoipa::path(
    put,
    path = "/api/agents/installed-providers/{provider_id}/enabled",
    params(("provider_id" = String, Path, description = "ACP Registry provider id")),
    request_body = SetInstalledProviderEnabledRequest,
    responses(
        (status = 200, body = InstalledProviderMutationResponse),
        (status = 400, description = "Descriptor is invalid"),
        (status = 404, description = "Provider is not installed"),
        (status = 409, description = "Provider id conflicts with a reserved identifier")
    )
)]
pub async fn set_provider_enabled_handler(
    Path(provider_id): Path<String>,
    Json(request): Json<SetInstalledProviderEnabledRequest>,
) -> Result<Json<InstalledProviderMutationResponse>, AppError> {
    let active_now = provider_registry().contains(&provider_id);
    set_descriptor_enabled(&descriptors_dir(), &provider_id, request.enabled).await?;
    Ok(Json(mutation_response(
        provider_id,
        active_now,
        request.enabled,
    )))
}

#[utoipa::path(
    delete,
    path = "/api/agents/installed-providers/{provider_id}",
    params(("provider_id" = String, Path, description = "ACP Registry provider id")),
    responses(
        (status = 200, body = InstalledProviderMutationResponse),
        (status = 400, description = "Descriptor is invalid"),
        (status = 404, description = "Provider is not installed")
    )
)]
pub async fn remove_provider_handler(
    Path(provider_id): Path<String>,
) -> Result<Json<InstalledProviderMutationResponse>, AppError> {
    let active_now = provider_registry().contains(&provider_id);
    remove_descriptor(&descriptors_dir(), &provider_id).await?;
    Ok(Json(mutation_response(provider_id, active_now, false)))
}

fn mutation_response(
    provider_id: String,
    active_now: bool,
    active_after_restart: bool,
) -> InstalledProviderMutationResponse {
    InstalledProviderMutationResponse {
        provider_id,
        enabled_after_restart: active_after_restart,
        active_now,
        active_after_restart,
        restart_required: active_now != active_after_restart,
    }
}

fn descriptor_json_rejection(rejection: JsonRejection) -> AppError {
    let code = match rejection {
        JsonRejection::JsonDataError(_) | JsonRejection::MissingJsonContentType(_) => {
            RejectionCode::DescriptorSchemaViolation
        }
        JsonRejection::JsonSyntaxError(_) | JsonRejection::BytesRejection(_) => {
            RejectionCode::DescriptorInvalidJson
        }
        _ => RejectionCode::DescriptorInvalidJson,
    };
    AppError::coded(
        axum::http::StatusCode::BAD_REQUEST,
        code.as_str(),
        format!("invalid provider descriptor request: {rejection}"),
    )
}

fn entry(installation: &HostInstallation, registered: bool) -> InstalledProviderEntry {
    let agent = installation.agent();
    let quarantine = installation.quarantine();
    InstalledProviderEntry {
        id: agent.id.clone(),
        name: agent.name.clone(),
        version: agent.version.clone(),
        description: agent.description.clone(),
        icon_issue: installation.icon_issue().map(str::to_string),
        source_path: installation.source_path().display().to_string(),
        enabled: installation.enabled(),
        registered,
        quarantine_code: quarantine.map(|quarantine| quarantine.code.as_str().to_string()),
        quarantine_message: quarantine.map(|quarantine| quarantine.message.clone()),
        executable: installation.executable().command.display().to_string(),
    }
}

fn rejection(rejection: &DescriptorRejection) -> InstalledProviderRejection {
    InstalledProviderRejection {
        source_path: rejection.source_path.display().to_string(),
        provider_id: rejection.provider_id.clone(),
        code: rejection.code.as_str().to_string(),
        message: rejection.message.clone(),
    }
}

pub fn installed_providers_router() -> Router<AppState> {
    Router::new().route(
        "/api/agents/installed-providers",
        get(installed_providers_handler),
    )
}

/// Host-policy mutations are loopback-only. A paired remote client may inspect
/// provider diagnostics, but it must never be able to install an executable or
/// change the environment and arguments used to launch one.
pub fn installed_provider_lifecycle_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/agents/installed-providers",
            axum::routing::post(install_provider_handler),
        )
        .route(
            "/api/agents/installed-providers/{provider_id}/enabled",
            put(set_provider_enabled_handler),
        )
        .route(
            "/api/agents/installed-providers/{provider_id}",
            delete(remove_provider_handler),
        )
}

#[cfg(test)]
mod tests {
    use super::{entry, mutation_response, rejection};
    use crate::domain::agents::providers::installed::descriptor::ProviderDescriptor;
    use crate::domain::agents::providers::installed::installation::HostInstallation;
    use crate::domain::agents::providers::installed::rejection::{
        DescriptorRejection, RejectionCode,
    };
    use serde_json::json;
    use std::path::Path;

    fn installation(command: &str) -> HostInstallation {
        let descriptor: ProviderDescriptor = serde_json::from_value(json!({
            "schema_version": 1,
            "agent": {
                "id": "acme-agent",
                "name": "Acme Agent",
                "version": "2.1.0",
                "description": "an ACP agent",
            },
            "installation": {
                "executable": {
                    "command": command,
                    "args": ["acp", "--token", "argument-secret"],
                    "env": { "ACME_TOKEN": "super-secret" },
                },
            },
        }))
        .unwrap();
        HostInstallation::from_descriptor(descriptor, Path::new("/p/acme-agent.json"))
            .expect("valid descriptor")
    }

    #[test]
    fn quarantined_installs_report_their_stable_code() {
        let response = entry(&installation("/nonexistent/cadencr/acme"), false);
        assert_eq!(response.id, "acme-agent");
        assert_eq!(response.version, "2.1.0");
        assert_eq!(
            response.quarantine_code.as_deref(),
            Some("EXECUTABLE_NOT_FOUND")
        );
        assert!(response
            .quarantine_message
            .as_deref()
            .is_some_and(|message| message.contains("/nonexistent/cadencr/acme")));
        assert!(!response.registered);
        assert_eq!(response.executable, "/nonexistent/cadencr/acme");
    }

    /// Launch inputs that can hold credentials — environment values and the
    /// argument vector — must not appear anywhere in the serialized entry.
    #[test]
    fn credential_bearing_launch_inputs_never_reach_the_response() {
        let response = entry(&installation("/nonexistent/cadencr/acme"), false);
        let serialized = serde_json::to_string(&response).unwrap();
        for secret in ["super-secret", "ACME_TOKEN", "--token", "argument-secret"] {
            assert!(!serialized.contains(secret), "{secret} in {serialized}");
        }
    }

    #[test]
    fn rejections_carry_their_code_and_reason() {
        let response = rejection(
            &DescriptorRejection::new(
                Path::new("/p/acme-agent.json"),
                RejectionCode::DuplicateProviderId,
                "already registered",
            )
            .with_provider_id("acme-agent"),
        );
        assert_eq!(response.code, "DUPLICATE_PROVIDER_ID");
        assert_eq!(response.provider_id.as_deref(), Some("acme-agent"));
        assert_eq!(response.message, "already registered");
    }

    #[test]
    fn mutations_make_restart_semantics_explicit() {
        let response = mutation_response("acme-agent".into(), true, false);
        assert_eq!(response.provider_id, "acme-agent");
        assert!(response.active_now);
        assert!(!response.active_after_restart);
        assert!(!response.enabled_after_restart);
        assert!(response.restart_required);
    }
}
