use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use utoipa::OpenApi;

use crate::app_state::AppState;
use crate::domain::agents::claude_code::routes as claude_code_routes;
use crate::domain::agents::discovery::routes as discovery_routes;
use crate::domain::agents::providers::development::routes as provider_development_routes;
use crate::domain::agents::providers::installed::managed::routes as managed_provider_routes;
use crate::domain::agents::providers::installed::routes as installed_provider_routes;
use crate::domain::custom_actions::models as custom_actions_models;
use crate::domain::custom_actions::routes as custom_actions_routes;
use crate::domain::diff_comments::models as diff_comments_models;
use crate::domain::diff_comments::routes as diff_comments_routes;
use crate::domain::editor::mutation_routes as editor_mutation_routes;
use crate::domain::editor::routes as editor_routes;
use crate::domain::feature_layouts::models as feature_layouts_models;
use crate::domain::feature_layouts::routes as feature_layouts_routes;
use crate::domain::features::auto_name_route as features_auto_name_route;
use crate::domain::features::models as features_models;
use crate::domain::features::routes as features_routes;
use crate::domain::imports::models as imports_models;
use crate::domain::imports::routes as imports_routes;
use crate::domain::lsp::routes as lsp_routes;
use crate::domain::ports::models as ports_models;
use crate::domain::ports::routes as ports_routes;
use crate::domain::projects::icon as projects_icon;
use crate::domain::projects::models as projects_models;
use crate::domain::projects::routes as projects_routes;
use crate::domain::push::models as push_models;
use crate::domain::push::routes as push_routes;
use crate::domain::remote::models as remote_models;
use crate::domain::remote::routes as remote_routes;
use crate::domain::schedules::models as schedules_models;
use crate::domain::schedules::recurrence as schedules_recurrence;
use crate::domain::schedules::routes as schedules_routes;
use crate::domain::sessions::models as sessions_models;
use crate::domain::sessions::routes as sessions_routes;
use crate::domain::terminal::routes as terminal_routes;
use crate::domain::themes::chrome as themes_chrome;
use crate::domain::themes::models as themes_models;
use crate::domain::themes::routes as themes_routes;
use crate::domain::usage_stats::health as usage_stats_health;
use crate::domain::usage_stats::models as usage_stats_models;
use crate::domain::usage_stats::routes as usage_stats_routes;
use crate::domain::workspace::models as workspace_models;
use crate::domain::workspace::routes as workspace_routes;
use crate::domain::ws_session::protocol as ws_protocol;
use crate::domain::ws_session::routes as ws_routes;

#[derive(OpenApi)]
#[openapi(
    info(title = "Cadencr Service API", version = "0.1.0"),
    paths(
        health,
        openapi_spec,
        editor_routes::read_file_handler,
        // `read-image` and `diff-image` are intentionally NOT exposed to orval: their responses
        // is a binary blob that the OpenAPI spec can't usefully describe,
        // so the generated react-query hook would just take a `customInstance<unknown>`
        // round-trip. The frontend calls the endpoint directly via Axios instead.
        editor_routes::write_file_handler,
        crate::domain::editor::format::format_handler,
        editor_routes::tree_handler,
        editor_routes::tree_all_handler,
        editor_routes::tree_count_handler,
        editor_routes::content_search_handler,
        editor_routes::search_handler,
        editor_mutation_routes::create_editor_file_handler,
        editor_mutation_routes::create_editor_folder_handler,
        editor_mutation_routes::rename_editor_path_handler,
        editor_mutation_routes::move_editor_path_handler,
        editor_mutation_routes::trash_editor_path_handler,
        editor_mutation_routes::get_editor_root_handler,
        workspace_routes::list_settings_handler,
        workspace_routes::get_setting_handler,
        workspace_routes::set_setting_handler,
        workspace_routes::get_settings_file_handler,
        workspace_routes::put_settings_file_handler,
        workspace_routes::get_model_settings_handler,
        workspace_routes::set_model_setting_handler,
        workspace_routes::get_provider_settings_handler,
        workspace_routes::set_provider_setting_handler,
        projects_routes::list_projects_handler,
        projects_routes::create_project_handler,
        projects_routes::delete_project_handler,
        projects_routes::get_project_settings_handler,
        projects_routes::set_project_setting_handler,
        projects_routes::get_project_settings_file_handler,
        projects_routes::put_project_settings_file_handler,
        projects_routes::get_project_model_settings_handler,
        projects_routes::set_project_model_setting_handler,
        projects_routes::get_project_provider_settings_handler,
        projects_routes::set_project_provider_setting_handler,
        projects_icon::scan_project_icons_handler,
        features_routes::list_features_handler,
        features_routes::list_feature_activity_handler,
        ports_routes::list_feature_ports_handler,
        features_routes::list_pinned_features_handler,
        features_routes::create_feature_handler,
        features_routes::get_feature_handler,
        features_routes::delete_feature_handler,
        features_routes::update_feature_title_handler,
        features_routes::update_feature_status_handler,
        features_routes::update_feature_label_handler,
        features_routes::update_feature_pinned_handler,
        features_routes::is_empty_handler,
        features_routes::get_feature_settings_handler,
        features_routes::set_feature_setting_handler,
        features_routes::get_feature_model_settings_handler,
        features_routes::set_feature_model_setting_handler,
        features_routes::get_feature_provider_settings_handler,
        features_routes::set_feature_provider_setting_handler,
        features_routes::get_working_dir_handler,
        crate::domain::features::pending_gate::get_pending_gate_handler,
        crate::domain::features::pending_gate::respond_gate_handler,
        features_auto_name_route::auto_name_feature_handler,
        custom_actions_routes::list_actions_handler,
        custom_actions_routes::create_action_handler,
        custom_actions_routes::update_action_handler,
        custom_actions_routes::delete_action_handler,
        custom_actions_routes::list_variables_handler,
        custom_actions_routes::set_variable_handler,
        custom_actions_routes::run_action_handler,
        custom_actions_routes::resolve_command_handler,
        custom_actions_routes::list_runs_handler,
        custom_actions_routes::cancel_run_handler,
        custom_actions_routes::get_schedule_handler,
        custom_actions_routes::set_schedule_handler,
        schedules_routes::list_schedules_handler,
        schedules_routes::create_schedule_handler,
        schedules_routes::get_schedule_by_id_handler,
        schedules_routes::update_schedule_handler,
        schedules_routes::delete_schedule_handler,
        schedules_routes::set_schedule_enabled_handler,
        schedules_routes::run_schedule_handler,
        ws_routes::get_prompt_commands,
        feature_layouts_routes::list_layouts_handler,
        feature_layouts_routes::create_layout_handler,
        feature_layouts_routes::update_layout_handler,
        feature_layouts_routes::delete_layout_handler,
        feature_layouts_routes::set_default_layout_handler,
        diff_comments_routes::list_diff_comments_handler,
        diff_comments_routes::create_diff_comment_handler,
        diff_comments_routes::update_diff_comment_handler,
        diff_comments_routes::delete_diff_comment_handler,
        diff_comments_routes::mark_diff_comments_sent_handler,
        diff_comments_routes::delete_pending_diff_comments_handler,
        diff_comments_routes::list_diff_viewed_handler,
        diff_comments_routes::mark_diff_viewed_handler,
        diff_comments_routes::unmark_diff_viewed_handler,
        diff_comments_routes::clear_all_diff_viewed_handler,
        sessions_routes::get_sessions_handler,
        sessions_routes::list_conversation_references_handler,
        sessions_routes::get_feature_agent_state_handler,
        sessions_routes::get_unified_agents_handler,
        sessions_routes::get_draft_handler,
        sessions_routes::save_draft_handler,
        sessions_routes::refresh_session_handler,
        sessions_routes::get_message_full_content_handler,
        sessions_routes::get_message_preview_handler,
        terminal_routes::list_terminal_sessions_handler,
        terminal_routes::kill_terminal_sessions_handler,
        super::get_agent_catalog,
        super::get_agent_selection,
        discovery_routes::binary_discovery_handler,
        provider_development_routes::create_provider_workspace_handler,
        installed_provider_routes::installed_providers_handler,
        installed_provider_routes::install_provider_handler,
        installed_provider_routes::set_provider_enabled_handler,
        installed_provider_routes::remove_provider_handler,
        managed_provider_routes::inventory_handler,
        managed_provider_routes::install_handler,
        managed_provider_routes::update_handler,
        managed_provider_routes::rollback_handler,
        managed_provider_routes::enabled_handler,
        managed_provider_routes::remove_handler,
        managed_provider_routes::refresh_blocklist_handler,
        claude_code_routes::list_profiles_handler,
        claude_code_routes::upsert_profile_handler,
        claude_code_routes::delete_profile_handler,
        claude_code_routes::set_active_profile_handler,
        claude_code_routes::list_custom_models_handler,
        claude_code_routes::upsert_custom_model_handler,
        claude_code_routes::delete_custom_model_handler,
        lsp_routes::open_session_handler,
        lsp_routes::list_servers_handler,
        usage_stats_routes::get_usage_stats_handler,
        usage_stats_routes::dismiss_usage_recording_issue_handler,
        crate::domain::maintenance::routes::run_archived_cleanup_handler,
        crate::domain::lsp::root::lsp_root_handler,
        imports_routes::list_claude_code_conversations_handler,
        imports_routes::list_provider_conversations_handler,
        imports_routes::start_claude_code_import_handler,
        imports_routes::start_provider_import_handler,
        imports_routes::get_import_job_handler,
        remote_routes::status_handler,
        remote_routes::enable_handler,
        remote_routes::disable_handler,
        remote_routes::pairing_code_handler,
        remote_routes::revoke_handler,
        remote_routes::set_tunnel_host_handler,
        remote_routes::pair_handler,
        themes_routes::list_themes_handler,
        themes_routes::create_theme_handler,
        themes_routes::write_theme_handler,
        themes_routes::delete_theme_handler,
        themes_routes::theme_workspace_handler,
        push_routes::vapid_key_handler,
        push_routes::subscribe_handler,
        push_routes::unsubscribe_handler,
    ),
    components(schemas(
        HealthResponse,
        themes_models::UserTheme,
        themes_models::ThemeDocument,
        themes_models::ThemeAppearance,
        themes_chrome::ThemeChrome,
        themes_chrome::ThemeChassis,
        themes_chrome::ThemeTabs,
        themes_chrome::ThemeTexture,
        themes_chrome::ThemeHalo,
        themes_chrome::ThemeGrain,
        themes_chrome::ThemeImage,
        themes_chrome::ThemeBlend,
        themes_chrome::ThemeImageFit,
        themes_models::ThemeIssue,
        themes_models::XtermPalette,
        themes_models::CreateThemeRequest,
        themes_models::WriteThemeRequest,
        themes_models::WriteThemeResponse,
        themes_models::DeleteThemeResponse,
        crate::domain::themes::workspace::ThemeWorkspace,
        crate::domain::agents::runtime::AgentCatalogResponse,
        crate::domain::agents::runtime::ProviderCatalogResponseEntry,
        crate::domain::agents::runtime::ProviderOrigin,
        crate::domain::agents::runtime::ProviderCatalogEntry,
        crate::domain::agents::runtime::ModelCatalogEntry,
        crate::domain::agents::runtime::ProviderStatus,
        discovery_routes::BinaryDiscoveryResponse,
        discovery_routes::ProviderDiscovery,
        discovery_routes::DiscoveredCandidate,
        discovery_routes::DiscoveredSource,
        crate::domain::agents::providers::development::CreateProviderWorkspaceRequest,
        crate::domain::agents::providers::development::ProviderWorkspace,
        installed_provider_routes::InstalledProvidersResponse,
        installed_provider_routes::InstalledProviderEntry,
        installed_provider_routes::InstalledProviderRejection,
        installed_provider_routes::SetInstalledProviderEnabledRequest,
        installed_provider_routes::InstalledProviderMutationResponse,
        managed_provider_routes::InstallManagedProviderRequest,
        managed_provider_routes::UpdateManagedProviderRequest,
        managed_provider_routes::RollbackManagedProviderRequest,
        managed_provider_routes::SetManagedProviderEnabledRequest,
        managed_provider_routes::RefreshManagedBlocklistResponse,
        crate::domain::agents::providers::installed::managed::service::ManagedProvidersInventory,
        crate::domain::agents::providers::installed::managed::service::ManagedBlocklistInventory,
        crate::domain::agents::providers::installed::managed::service::ManagedBlocklistCacheStatus,
        crate::domain::agents::providers::installed::managed::service::ManagedBlocklistRefreshInventory,
        crate::domain::agents::providers::installed::managed::service::ManagedBlocklistRefreshOutcome,
        crate::domain::agents::providers::installed::managed::service::ManagedTrustInventory,
        crate::domain::agents::providers::installed::managed::service::ManagedTrustConfigurationStatus,
        crate::domain::agents::providers::installed::managed::service::ManagedProviderInventoryEntry,
        crate::domain::agents::providers::installed::managed::history::ManagedHistoryEntry,
        crate::domain::agents::providers::installed::managed::history::ManagedHistoryAction,
        crate::domain::agents::providers::installed::managed::quarantine::ManagedQuarantineRecord,
        crate::domain::agents::providers::installed::managed::quarantine::ManagedFailureStage,
        crate::domain::agents::providers::installed::managed::process_policy::ManagedProcessPolicyOutcome,
        crate::domain::agents::providers::installed::managed::process_policy::ManagedProcessControlOutcome,
        crate::domain::agents::providers::installed::managed::SignedManagedProviderIndex,
        crate::domain::agents::providers::installed::managed::ManagedProviderIndex,
        crate::domain::agents::providers::installed::managed::ManagedProviderPackage,
        crate::domain::agents::providers::installed::managed::ManagedProviderHost,
        crate::domain::agents::providers::installed::managed::ManagedAppCompatibility,
        crate::domain::agents::providers::installed::managed::ManagedPackageAssets,
        crate::domain::agents::providers::installed::managed::ManagedIndexSignature,
        crate::domain::agents::providers::installed::managed::ManagedSignatureAlgorithm,
        crate::domain::agents::providers::installed::descriptor::ProviderDescriptor,
        crate::domain::agents::providers::installed::descriptor::AcpAgentEntry,
        crate::domain::agents::providers::installed::descriptor::AcpDistribution,
        crate::domain::agents::providers::installed::descriptor::AcpBinaryTarget,
        crate::domain::agents::providers::installed::descriptor::AcpPackageDistribution,
        crate::domain::agents::providers::installed::descriptor::HostInstallationSpec,
        crate::domain::agents::providers::installed::descriptor::LocalExecutableSpec,
        editor_routes::ReadFileResponse,
        editor_routes::WriteFileRequest,
        editor_routes::WriteFileResponse,
        crate::domain::editor::format::FormatRequest,
        crate::domain::editor::format::FormatResponse,
        editor_routes::FileTreeEntry,
        editor_routes::TreeCountResponse,
        editor_routes::ContentMatch,
        editor_routes::ContentSearchResponse,
        editor_routes::FileMatchResult,
        editor_routes::FileSearchResponse,
        editor_mutation_routes::CreateFileRequest,
        editor_mutation_routes::CreateFileResponse,
        editor_mutation_routes::CreateFolderRequest,
        editor_mutation_routes::CreateFolderResponse,
        editor_mutation_routes::RenamePathRequest,
        editor_mutation_routes::RenamePathResponse,
        editor_mutation_routes::MovePathRequest,
        editor_mutation_routes::MovePathResponse,
        editor_mutation_routes::TrashPathRequest,
        editor_mutation_routes::TrashPathResponse,
        editor_mutation_routes::EditorRootResponse,
        workspace_models::Setting,
        workspace_models::ModelSettings,
        workspace_models::AgentProviderSettings,
        workspace_models::SetSettingRequest,
        workspace_models::SetModelSettingRequest,
        workspace_models::SetProviderSettingRequest,
        workspace_routes::SettingValueResponse,
        workspace_routes::SettingsFileResponse,
        workspace_routes::WriteSettingsFileRequest,
        workspace_routes::WriteSettingsFileResponse,
        crate::domain::settings_store::SettingWarning,
        projects_models::Project,
        projects_models::CreateProjectRequest,
        projects_models::ProjectSetting,
        projects_models::SetProjectSettingRequest,
        projects_models::ProjectModelSettings,
        projects_models::ProjectProviderSettings,
        projects_models::SetProjectModelSettingRequest,
        projects_models::SetProjectProviderSettingRequest,
        projects_routes::SuccessResponse,
        projects_icon::ProjectIconCandidate,
        features_models::Feature,
        features_models::FeatureStatus,
        features_models::CreateFeatureRequest,
        features_models::CreateFeatureResponse,
        features_models::UpdateTitleRequest,
        features_models::UpdateStatusRequest,
        features_models::UpdateLabelRequest,
        features_models::UpdatePinnedRequest,
        features_models::IsEmptyResponse,
        features_models::WorkingDirResponse,
        features_models::FeatureSetting,
        features_models::SetFeatureSettingRequest,
        features_models::FeatureModelSettings,
        features_models::FeatureProviderSettings,
        features_models::SetFeatureModelSettingRequest,
        features_models::SetFeatureProviderSettingRequest,
        features_routes::SuccessResponse,
        ports_models::AllocatedPort,
        ports_models::FeaturePorts,
        ports_models::PortSource,
        crate::domain::features::pending_gate::FeaturePendingGateResponse,
        crate::domain::features::pending_gate::FeatureRespondGateRequest,
        crate::domain::features::pending_gate::FeatureRespondGateResponse,
        crate::domain::features::pending_gate::FeatureGateDecision,
        crate::domain::features::pending_gate::FeaturePermissionAction,
        crate::domain::features::pending_gate::FeaturePlanAction,
        custom_actions_models::CustomAction,
        custom_actions_models::CustomActionVariable,
        custom_actions_models::CustomActionRun,
        custom_actions_models::CustomActionSchedule,
        custom_actions_models::CreateCustomActionRequest,
        custom_actions_models::UpdateCustomActionRequest,
        custom_actions_models::SetCustomActionVariableRequest,
        custom_actions_models::SetCustomActionScheduleRequest,
        custom_actions_models::LastRunSummary,
        custom_actions_models::RunResponse,
        custom_actions_models::ResolvedCommand,
        custom_actions_models::Scope,
        custom_actions_models::TriggeredBy,
        custom_actions_models::SuccessResponse,
        schedules_models::Schedule,
        schedules_models::ScheduleTarget,
        schedules_models::ScheduleContext,
        schedules_models::ScheduleLastRun,
        schedules_models::TargetKind,
        schedules_models::SaveScheduleRequest,
        schedules_models::RecurrenceInput,
        schedules_models::SetScheduleEnabledRequest,
        schedules_models::ScheduleDeleted,
        schedules_models::ScheduleRunResult,
        ws_routes::PromptCommandsResponse,
        ws_protocol::SlashCommandPayload,
        ws_protocol::SlashCommandKindPayload,
        ws_protocol::PromptCommandPolicyPayload,
        ws_protocol::PromptCommandPlacementPayload,
        ws_protocol::SkillReferenceTriggerPayload,
        schedules_recurrence::Recurrence,
        schedules_recurrence::RecurrenceKind,
        feature_layouts_models::FeatureLayout,
        feature_layouts_models::CreateFeatureLayoutRequest,
        feature_layouts_models::UpdateFeatureLayoutRequest,
        feature_layouts_models::SuccessResponse,
        diff_comments_models::DiffComment,
        diff_comments_models::CreateDiffCommentRequest,
        diff_comments_models::UpdateDiffCommentRequest,
        diff_comments_models::UpdatedResponse,
        diff_comments_models::DeletedResponse,
        diff_comments_models::DiffViewedFile,
        diff_comments_models::MarkViewedRequest,
        diff_comments_routes::SuccessResponse,
        sessions_models::AgentSessionRow,
        sessions_models::AgentBlock,
        sessions_models::SessionState,
        sessions_models::FeatureAgentStateResponse,
        sessions_models::UnifiedAgentsMode,
        sessions_models::UnifiedAgentProject,
        sessions_models::UnifiedAgentFeature,
        sessions_models::UnifiedAgentEntry,
        sessions_models::UnifiedAgentsResponse,
        sessions_models::DraftResponse,
        sessions_models::SaveDraftRequest,
        sessions_models::SaveDraftResponse,
        sessions_models::MessageFullContentResponse,
        sessions_models::MessagePreviewResponse,
        sessions_models::RefreshSessionResponse,
        terminal_routes::TerminalSessionInfo,
        terminal_routes::KillTerminalsResponse,
        claude_code_routes::ProfileView,
        claude_code_routes::ProfilesResponse,
        claude_code_routes::UpsertProfileRequest,
        claude_code_routes::SetActiveProfileRequest,
        claude_code_routes::CustomModelsResponse,
        claude_code_routes::UpsertCustomModelRequest,
        claude_code_routes::SuccessResponse,
        lsp_routes::OpenLspSessionRequest,
        lsp_routes::OpenLspSessionResponse,
        lsp_routes::ListServersResponse,
        usage_stats_health::UsageRecordingIssue,
        usage_stats_models::UsageStatsEntry,
        usage_stats_models::UsageStatsResponse,
        crate::domain::maintenance::routes::ArchivedCleanupRunStatus,
        crate::domain::maintenance::routes::ArchivedCleanupRunResponse,
        crate::domain::lsp::root::LspRootResponse,
        crate::domain::lsp::probe::ServerProbe,
        crate::domain::lsp::probe::ServerProbeStatus,
        crate::domain::lsp::catalog::ServerRole,
        imports_models::ImportConversationSummary,
        imports_models::ListImportConversationsResponse,
        imports_models::StartImportRequest,
        imports_models::StartImportResponse,
        imports_models::ImportJobState,
        imports_models::ImportJobStatus,
        imports_models::ImportedRecord,
        imports_models::SkippedRecord,
        imports_models::SkipReason,
        remote_models::RemoteStatus,
        crate::remote::pairing::PairingState,
        remote_models::RemoteDevice,
        remote_models::RemoteAuditEntry,
        remote_models::PairingCodeResponse,
        remote_models::PairRequest,
        remote_models::PairResponse,
        remote_models::TunnelHostRequest,
        push_models::VapidKeyResponse,
        push_models::PushSubscribeRequest,
        push_models::PushUnsubscribeRequest,
        push_models::PushSubscriptionKeys,
        push_models::PushSubscriptionResponse,
        ws_protocol::WsSessionAction,
        ws_protocol::PermissionDecision,
        ws_protocol::SessionInitPayload,
        ws_protocol::PromptSendPayload,
        ws_protocol::PermissionRespondPayload,
        ws_protocol::GateClosePayload,
        ws_protocol::SessionActionPayload,
        ws_protocol::ProviderSetPayload,
        ws_protocol::ModelSetPayload,
        ws_protocol::ModeSetPayload,
        ws_protocol::EffortSetPayload,
        ws_protocol::SessionConfigSetPayload,
        ws_protocol::FastModeSetPayload,
        ws_protocol::ProfileSetPayload,
        ws_protocol::GateClosedPayload,
        ws_protocol::PromptReceivedPayload,
        ws_protocol::PromptReceiptState,
        ws_protocol::UserMessagePayload,
        ws_protocol::UserMessageDeliveryState,
        ws_protocol::PermissionRequestPayload,
        ws_protocol::ProviderSetOkPayload,
        ws_protocol::ModeChangedPayload,
        ws_protocol::ModelSetOkPayload,
        ws_protocol::EffortSetOkPayload,
        ws_protocol::SessionConfigSnapshotPayload,
        ws_protocol::FastModeSetOkPayload,
        ws_protocol::ProfileChangedPayload,
        ws_protocol::RuntimeSessionIdPayload,
        ws_protocol::BranchRewoundPayload,
        ws_protocol::BranchForkedPayload,
        ws_protocol::SessionStreamStatusPayload,
        ws_protocol::StreamStatusState,
        ws_protocol::CommandsGetPayload,
        ws_protocol::CommandsListPayload,
        ws_protocol::CommandsUpdatedPayload,
        super::AgentSelectionResponse,
        crate::domain::agents::ResolvedSelection,
        crate::domain::agents::SelectionOrigin,
    ))
)]
struct ApiDoc;

#[derive(Serialize, utoipa::ToSchema)]
struct HealthResponse {
    status: String,
    /// Fixed identifier; the desktop shell checks this to reject an imposter
    /// that grabbed our port before we could bind.
    service: &'static str,
}

#[utoipa::path(
    get,
    path = "/api/health",
    responses((status = 200, description = "Service is healthy", body = HealthResponse))
)]
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        service: "cadencr",
    })
}

#[utoipa::path(
    get,
    path = "/api/openapi.json",
    responses((status = 200, description = "OpenAPI specification"))
)]
async fn openapi_spec() -> Json<utoipa::openapi::OpenApi> {
    Json(api_doc())
}

/// Returns the full OpenAPI spec. Used by the runtime endpoint above and by the
/// `dump-openapi` binary that emits the spec for orval client generation.
pub fn api_doc() -> utoipa::openapi::OpenApi {
    let mut document = ApiDoc::openapi();
    document.merge(crate::domain::git::openapi::api_doc());
    document
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/openapi.json", get(openapi_spec))
}

#[cfg(test)]
mod tests {
    use super::api_doc;

    #[test]
    fn descriptor_optional_properties_are_not_advertised_as_nullable() {
        let document = serde_json::to_value(api_doc()).expect("OpenAPI should serialize");
        for (schema, fields) in [
            (
                "AcpAgentEntry",
                &["repository", "website", "license", "icon", "distribution"][..],
            ),
            ("AcpDistribution", &["binary", "npx", "uvx"][..]),
            ("AcpBinaryTarget", &["sha256"][..]),
        ] {
            for field in fields {
                let property = &document["components"]["schemas"][schema]["properties"][field];
                assert!(
                    !contains_null_schema(property),
                    "{schema}.{field} must allow omission but reject explicit null: {property}"
                );
            }
        }
    }

    fn contains_null_schema(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(object) => {
                object.get("nullable") == Some(&serde_json::Value::Bool(true))
                    || object
                        .get("type")
                        .is_some_and(|schema_type| match schema_type {
                            serde_json::Value::String(value) => value == "null",
                            serde_json::Value::Array(values) => {
                                values.iter().any(|value| value == "null")
                            }
                            _ => false,
                        })
                    || object.values().any(contains_null_schema)
            }
            serde_json::Value::Array(values) => values.iter().any(contains_null_schema),
            _ => false,
        }
    }
}
