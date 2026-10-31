use std::collections::BTreeMap;

use axum::extract::{Json, Query, State};
use axum::routing::{get, put};
use axum::Router;

use super::auth::{
    forge_to_app_error, host_configs, normalize_hostname, normalized_optional, resolve_credentials,
    save_host_config,
};
use super::poller::refresh_all;
use super::provider::{
    FeaturePrParams, ForgeAuthContext, ForgeAuthSource, ForgeAuthStatus, ForgeCredentials,
    ForgeHostConfig, ForgeTokenDeleteParams, ForgeTokenDeleteResponse, ForgeTokenRequest,
    PrCommentsParams, PrCommentsResponse, PrStatusSnapshot, PrSummary,
};
use super::repository::{detected_project_remotes, feature_forge_context};
use super::{api_base_url, effective_kind, provider_for};
use crate::app_state::AppState;
use crate::domain::git::host::GitHost;
use crate::error::AppError;

const STATUS_STALE_MS: i64 = 60_000;

#[utoipa::path(get, path = "/api/git/forge/auth-status", responses((status = 200, body = Vec<ForgeAuthStatus>)))]
pub async fn get_forge_auth_status_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<ForgeAuthStatus>>, AppError> {
    let configs = host_configs()?;
    let mut hosts = BTreeMap::<String, GitHost>::new();
    for remote in detected_project_remotes(&state).await? {
        hosts.entry(remote.hostname).or_insert(remote.host);
    }
    for (hostname, config) in &configs {
        hosts.entry(hostname.clone()).or_insert(config.kind);
    }
    let mut statuses = Vec::with_capacity(hosts.len());
    for (hostname, detected_kind) in hosts {
        statuses.push(
            auth_status_for_host(
                &state,
                hostname.clone(),
                detected_kind,
                configs.get(&hostname),
            )
            .await,
        );
    }
    Ok(Json(statuses))
}

#[utoipa::path(put, path = "/api/git/forge/token", request_body = ForgeTokenRequest, responses((status = 200, body = ForgeAuthStatus)))]
pub async fn put_forge_token_handler(
    State(state): State<AppState>,
    Json(body): Json<ForgeTokenRequest>,
) -> Result<Json<ForgeAuthStatus>, AppError> {
    let hostname = normalize_hostname(&body.hostname).map_err(forge_to_app_error)?;
    let config = ForgeHostConfig {
        kind: body.kind,
        api_base_url: normalized_optional(body.api_base_url),
        use_cli_auth: body.use_cli_auth,
        username: normalized_optional(body.username),
    };
    let api_base_url = api_base_url(&hostname, body.kind, Some(&config))
        .map_err(forge_to_app_error)?
        .ok_or_else(|| AppError::BadRequest("An API base URL is required for this forge".into()))?;
    let provider = provider_for(body.kind).ok_or_else(|| {
        AppError::BadRequest("Choose GitHub, GitLab, or Bitbucket as the forge kind".into())
    })?;
    let credentials = if let Some(token) = normalized_optional(body.token) {
        ForgeCredentials {
            token,
            username: config.username.clone(),
            source: ForgeAuthSource::Stored,
        }
    } else {
        resolve_credentials(&state.forge_auth, &hostname, body.kind, Some(&config))
            .await
            .map_err(forge_to_app_error)?
            .ok_or_else(|| {
                AppError::BadRequest("Enter an API token or enable CLI token reuse".into())
            })?
    };
    let context = ForgeAuthContext {
        api_base_url: api_base_url.clone(),
        credentials: credentials.clone(),
        http: state.forge_http.clone(),
    };
    let user = provider
        .validate_token(&context)
        .await
        .map_err(forge_to_app_error)?;
    if credentials.source == ForgeAuthSource::Stored {
        state
            .forge_auth
            .save(&hostname, &credentials.token, credentials.username.clone())
            .await
            .map_err(forge_to_app_error)?;
    }
    save_host_config(&hostname, config.clone()).await?;
    let refresh_error = refresh_all(&state)
        .await
        .err()
        .map(|error| format!("Connected, but pull request statuses could not refresh: {error}"));
    let token_present = has_stored_credentials(Some(&credentials));
    Ok(Json(ForgeAuthStatus {
        hostname,
        kind: body.kind,
        api_base_url: Some(api_base_url),
        token_present,
        source: Some(credentials.source),
        validated_user: Some(user),
        error: refresh_error,
        use_cli_auth: config.use_cli_auth,
        cli_auth_available: cli_auth_available(body.kind),
        username_required: body.kind == GitHost::Bitbucket,
        username: config.username,
    }))
}

#[utoipa::path(delete, path = "/api/git/forge/token", params(ForgeTokenDeleteParams), responses((status = 200, body = ForgeTokenDeleteResponse)))]
pub async fn delete_forge_token_handler(
    State(state): State<AppState>,
    Query(params): Query<ForgeTokenDeleteParams>,
) -> Result<Json<ForgeTokenDeleteResponse>, AppError> {
    let hostname = normalize_hostname(&params.hostname).map_err(forge_to_app_error)?;
    let deleted = state
        .forge_auth
        .delete(&hostname)
        .await
        .map_err(forge_to_app_error)?;
    let mut configs = host_configs()?;
    let cli_auth_disabled = disable_cli_auth(configs.get_mut(&hostname));
    if cli_auth_disabled {
        let config = configs
            .remove(&hostname)
            .expect("disabled CLI auth config remains present");
        save_host_config(&hostname, config).await?;
    }
    Ok(Json(ForgeTokenDeleteResponse {
        deleted: deleted || cli_auth_disabled,
    }))
}

#[utoipa::path(get, path = "/api/git/pr-statuses", responses((status = 200, body = Vec<PrStatusSnapshot>)))]
pub async fn get_pr_statuses_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<PrStatusSnapshot>>, AppError> {
    let mut snapshots = state.forge_status.list().await;
    if snapshots.is_empty() {
        refresh_all(&state).await?;
        snapshots = state.forge_status.list().await;
    }
    Ok(Json(snapshots))
}

#[utoipa::path(get, path = "/api/git/pr", params(FeaturePrParams), responses((status = 200, body = PrStatusSnapshot)))]
pub async fn get_pr_handler(
    State(state): State<AppState>,
    Query(params): Query<FeaturePrParams>,
) -> Result<Json<PrStatusSnapshot>, AppError> {
    refresh_if_stale(&state, params.feature_id).await?;
    state
        .forge_status
        .get(params.feature_id)
        .await
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("Feature not found: {}", params.feature_id)))
}

#[utoipa::path(get, path = "/api/git/pr/comments", params(PrCommentsParams), responses((status = 200, body = PrCommentsResponse)))]
pub async fn get_pr_comments_handler(
    State(state): State<AppState>,
    Query(params): Query<PrCommentsParams>,
) -> Result<Json<PrCommentsResponse>, AppError> {
    refresh_if_stale(&state, params.feature_id).await?;
    let Some(status) = state.forge_status.get(params.feature_id).await else {
        return Err(AppError::NotFound(format!(
            "Feature not found: {}",
            params.feature_id
        )));
    };
    let Some(pr_number) = requested_pr_number(&status, params.pr_number)? else {
        return Ok(Json(PrCommentsResponse {
            feature_id: params.feature_id,
            threads: Vec::new(),
            fetched_at: chrono::Utc::now().timestamp_millis(),
        }));
    };
    let forge = feature_forge_context(&state, params.feature_id).await?;
    let threads = forge
        .provider
        .comments(&forge.context, pr_number)
        .await
        .map_err(forge_to_app_error)?;
    Ok(Json(PrCommentsResponse {
        feature_id: params.feature_id,
        threads,
        fetched_at: chrono::Utc::now().timestamp_millis(),
    }))
}

/// The proposal whose comments to read: the requested one when it belongs to
/// the conversation, else the current branch's.
fn requested_pr_number(
    status: &PrStatusSnapshot,
    requested: Option<u64>,
) -> Result<Option<u64>, AppError> {
    let Some(requested) = requested else {
        return Ok(status.pr.as_ref().map(|pr| pr.number));
    };
    conversation_pr(status, requested).map(|pr| Some(pr.number))
}

/// One of the conversation's own proposals. The forge snapshot is what vouches
/// for them, so a request can never read or act on an arbitrary number in the
/// repository.
pub(super) fn conversation_pr(
    status: &PrStatusSnapshot,
    pr_number: u64,
) -> Result<PrSummary, AppError> {
    status
        .pr
        .iter()
        .chain(status.other_prs.iter().map(|other| &other.pr))
        .find(|pr| pr.number == pr_number)
        .cloned()
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "#{pr_number} is not one of this conversation's pull requests"
            ))
        })
}

pub fn forge_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/git/forge/auth-status",
            get(get_forge_auth_status_handler),
        )
        .route(
            "/api/git/forge/token",
            put(put_forge_token_handler).delete(delete_forge_token_handler),
        )
        .route("/api/git/pr-statuses", get(get_pr_statuses_handler))
        .route("/api/git/pr", get(get_pr_handler))
        .route("/api/git/pr/comments", get(get_pr_comments_handler))
        .route(
            "/api/git/pr/lookup",
            get(super::pr_lookup::lookup_feature_repo_pr),
        )
        .merge(super::merge_routes::merge_router())
        .route(
            "/api/git/forge/image",
            get(super::image_routes::get_forge_image_handler),
        )
}

pub(super) async fn refresh_if_stale(state: &AppState, feature_id: i64) -> Result<(), AppError> {
    let stale = state
        .forge_status
        .get(feature_id)
        .await
        .is_none_or(|status| {
            chrono::Utc::now()
                .timestamp_millis()
                .saturating_sub(status.fetched_at)
                >= STATUS_STALE_MS
        });
    if stale {
        refresh_all(state).await?;
    }
    Ok(())
}

async fn auth_status_for_host(
    state: &AppState,
    hostname: String,
    detected_kind: GitHost,
    config: Option<&ForgeHostConfig>,
) -> ForgeAuthStatus {
    let kind = effective_kind(detected_kind, config);
    let stored_credentials = state.forge_auth.stored_credentials(&hostname).await;
    let token_present = match stored_credentials {
        Ok(credentials) => has_stored_credentials(credentials.as_ref()),
        Err(store_error) => {
            return ForgeAuthStatus {
                hostname,
                kind,
                api_base_url: None,
                token_present: false,
                source: None,
                validated_user: None,
                error: Some(store_error.to_string()),
                use_cli_auth: config.is_some_and(|value| value.use_cli_auth),
                cli_auth_available: cli_auth_available(kind),
                username_required: kind == GitHost::Bitbucket,
                username: config.and_then(|value| value.username.clone()),
            };
        }
    };
    let (api, mut error) = match api_base_url(&hostname, kind, config) {
        Ok(api) => (api, None),
        Err(api_error) => (None, Some(api_error.to_string())),
    };
    let resolved = if error.is_none() {
        resolve_credentials(&state.forge_auth, &hostname, kind, config).await
    } else {
        Ok(None)
    };
    let (credentials, auth_error) = match resolved {
        Ok(credentials) => (credentials, None),
        Err(auth_error) => (None, Some(auth_error.to_string())),
    };
    if error.is_none() {
        error = auth_error;
    }
    let mut validated_user = None;
    if error.is_none() {
        if let (Some(provider), Some(api), Some(credentials)) =
            (provider_for(kind), api.as_ref(), credentials.as_ref())
        {
            let context = ForgeAuthContext {
                api_base_url: api.clone(),
                credentials: credentials.clone(),
                http: state.forge_http.clone(),
            };
            match provider.validate_token(&context).await {
                Ok(user) => validated_user = Some(user),
                Err(validation_error) => error = Some(validation_error.to_string()),
            }
        } else if kind == GitHost::Other {
            error = Some("Choose a forge kind for this self-hosted remote".into());
        }
    }
    ForgeAuthStatus {
        hostname,
        kind,
        api_base_url: api,
        token_present,
        source: credentials.as_ref().map(|value| value.source),
        validated_user,
        error,
        use_cli_auth: config.is_some_and(|value| value.use_cli_auth),
        cli_auth_available: cli_auth_available(kind),
        username_required: kind == GitHost::Bitbucket,
        username: config.and_then(|value| value.username.clone()),
    }
}

fn has_stored_credentials(credentials: Option<&ForgeCredentials>) -> bool {
    credentials.is_some_and(|value| value.source == ForgeAuthSource::Stored)
}

fn disable_cli_auth(config: Option<&mut ForgeHostConfig>) -> bool {
    let Some(config) = config.filter(|config| config.use_cli_auth) else {
        return false;
    };
    config.use_cli_auth = false;
    true
}

#[cfg(test)]
mod tests {
    use super::{conversation_pr, disable_cli_auth, has_stored_credentials, requested_pr_number};
    use crate::domain::git::forge::provider::{
        ForgeAuthSource, ForgeCredentials, ForgeHostConfig, ForgeUser, PrState, PrStatusSnapshot,
        PrSummary, ReviewState,
    };
    use crate::domain::git::forge::BranchPr;
    use crate::domain::git::host::GitHost;

    fn summary(number: u64) -> PrSummary {
        PrSummary {
            author: ForgeUser {
                username: "author".into(),
                display_name: None,
                avatar_url: None,
            },
            body_markdown: String::new(),
            head_sha: "abc".into(),
            number,
            pr_label: "Pull request".into(),
            review_state: ReviewState::None,
            source_branch: "fix/b".into(),
            state: PrState::Open,
            target_branch: "main".into(),
            title: "Proposal".into(),
            updated_at: "2026-10-16T00:00:00Z".into(),
            url: "https://example.test/pr".into(),
        }
    }

    #[test]
    fn comments_are_read_only_for_the_conversations_own_proposals() {
        let mut status = PrStatusSnapshot::unpolled(1, None, false);
        assert_eq!(requested_pr_number(&status, None).unwrap(), None);

        status.pr = Some(summary(12));
        status.other_prs = vec![BranchPr {
            branch: "feature/a".into(),
            pr: summary(10),
            ci: None,
            unresolved_threads: None,
        }];
        assert_eq!(requested_pr_number(&status, None).unwrap(), Some(12));
        assert_eq!(requested_pr_number(&status, Some(10)).unwrap(), Some(10));
        assert!(requested_pr_number(&status, Some(99)).is_err());
        // The merge endpoints act through the same gate.
        assert_eq!(conversation_pr(&status, 10).unwrap().number, 10);
        assert!(conversation_pr(&status, 99).is_err());
    }

    fn credentials(source: ForgeAuthSource) -> ForgeCredentials {
        ForgeCredentials {
            token: "token".into(),
            username: None,
            source,
        }
    }

    #[test]
    fn token_present_only_describes_persisted_credentials() {
        let stored = credentials(ForgeAuthSource::Stored);
        let cli = credentials(ForgeAuthSource::Cli);

        assert!(has_stored_credentials(Some(&stored)));
        assert!(!has_stored_credentials(Some(&cli)));
        assert!(!has_stored_credentials(None));
    }

    #[test]
    fn disconnect_disables_cli_only_authentication() {
        let mut config = ForgeHostConfig {
            kind: GitHost::GitLab,
            api_base_url: Some("https://git.example.com/api/v4".into()),
            use_cli_auth: true,
            username: None,
        };

        assert!(disable_cli_auth(Some(&mut config)));
        assert!(!config.use_cli_auth);
        assert!(!disable_cli_auth(Some(&mut config)));
        assert!(!disable_cli_auth(None));
    }
}

fn cli_auth_available(kind: GitHost) -> bool {
    matches!(kind, GitHost::GitHub | GitHost::GitLab)
}
