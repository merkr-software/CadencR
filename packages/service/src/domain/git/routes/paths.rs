//! Endpoints about how the Git tab's repository-relative paths map onto the
//! feature's directory, and about the Git that produces them.

use axum::extract::{Json, Query, State};

use crate::app_state::AppState;
use crate::domain::git::models::{
    FileBlobSha, GetFileBlobShasParams, GetGitPathPrefixParams, GitPathPrefixResponse,
    GitVersionResponse, UnsupportedGitFeature,
};
use crate::domain::git::service;
use crate::error::AppError;
use crate::shared::git_cli::version;

#[utoipa::path(get, path = "/api/git/file-blob-shas", params(("feature_id" = i64, Query,)), responses((status = 200, body = Vec<FileBlobSha>)))]
pub async fn get_file_blob_shas_handler(
    State(state): State<AppState>,
    Query(params): Query<GetFileBlobShasParams>,
) -> Result<Json<Vec<FileBlobSha>>, AppError> {
    Ok(Json(service::get_file_blob_shas(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/path-prefix", params(("feature_id" = i64, Query,)), responses((status = 200, body = GitPathPrefixResponse)))]
pub async fn get_git_path_prefix_handler(
    State(state): State<AppState>,
    Query(params): Query<GetGitPathPrefixParams>,
) -> Result<Json<GitPathPrefixResponse>, AppError> {
    Ok(Json(service::get_git_path_prefix(&state, params).await?))
}

/// The installed Git and the features it is too old for. Detected once at
/// startup, so this never spawns Git again.
#[utoipa::path(get, path = "/api/git/version", responses((status = 200, body = GitVersionResponse)))]
pub async fn get_git_version_handler() -> Result<Json<GitVersionResponse>, AppError> {
    let detected = tokio::task::spawn_blocking(version::detect)
        .await
        .map_err(|error| AppError::internal(format!("git version detection failed: {error}")))?;
    Ok(Json(match detected {
        Ok(installed) => GitVersionResponse {
            version: Some(installed.to_string_dotted()),
            error: None,
            unsupported: version::unsupported(*installed)
                .into_iter()
                .map(|feature| UnsupportedGitFeature {
                    label: feature.label().to_string(),
                    minimum_version: feature.minimum().to_string_dotted(),
                })
                .collect(),
        },
        Err(error) => GitVersionResponse {
            version: None,
            error: Some(error.clone()),
            unsupported: Vec::new(),
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_version_route_reports_the_installed_git() {
        let Json(response) = get_git_version_handler().await.unwrap();
        let installed = version::installed().expect("tests run with Git");
        assert_eq!(response.version, Some(installed.to_string_dotted()));
        assert_eq!(response.error, None);
        assert_eq!(
            response.unsupported.len(),
            version::unsupported(installed).len()
        );
    }
}
