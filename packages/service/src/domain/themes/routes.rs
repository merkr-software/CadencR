use axum::extract::{Json, Path, State};
use axum::routing::{get, post, put};
use axum::Router;

use crate::app_state::AppState;
use crate::error::AppError;

use super::models::{
    CreateThemeRequest, CreateThemeResponse, DeleteThemeResponse, UserTheme, WriteThemeRequest,
    WriteThemeResponse,
};
use super::store;
use super::workspace::{self, ThemeWorkspace};

pub fn themes_router() -> Router<AppState> {
    Router::new()
        .merge(super::managed::routes::router())
        .route(
            "/api/themes",
            get(list_themes_handler).post(create_theme_handler),
        )
        .route(
            "/api/themes/{id}",
            put(write_theme_handler).delete(delete_theme_handler),
        )
        .route("/api/themes/{id}/workspace", post(theme_workspace_handler))
}

#[utoipa::path(get, path = "/api/themes", responses((status = 200, body = Vec<UserTheme>)))]
pub async fn list_themes_handler() -> Result<Json<Vec<UserTheme>>, AppError> {
    Ok(Json(store::list().await?))
}

#[utoipa::path(post, path = "/api/themes", request_body = CreateThemeRequest, responses((status = 200, body = CreateThemeResponse)))]
pub async fn create_theme_handler(
    State(state): State<AppState>,
    Json(body): Json<CreateThemeRequest>,
) -> Result<Json<CreateThemeResponse>, AppError> {
    Ok(Json(create_theme(&state.write_pool, body).await?))
}

async fn create_theme(
    pool: &sqlx::SqlitePool,
    body: CreateThemeRequest,
) -> Result<CreateThemeResponse, AppError> {
    let theme = store::create()
        .label(&body.label)
        .appearance(body.appearance)
        .css_vars(body.css_vars)
        .xterm(body.xterm)
        .chrome(body.chrome)
        .maybe_copy_assets_from(body.copy_assets_from.as_deref())
        .call()
        .await?;
    let workspace = workspace::ensure(pool, &theme.id)
        .await
        .map_err(|error| {
            AppError::coded(
                axum::http::StatusCode::CONFLICT,
                "THEME_PROJECT_SETUP_FAILED",
                format!(
                    "theme `{}` was created, but its project could not be prepared: {error}. Retry by opening the theme or POST /api/themes/{}/workspace",
                    theme.id, theme.id
                ),
            )
        })?;
    Ok(CreateThemeResponse { theme, workspace })
}

#[utoipa::path(
    put,
    path = "/api/themes/{id}",
    params(("id" = String, Path,)),
    request_body = WriteThemeRequest,
    responses((status = 200, body = WriteThemeResponse))
)]
pub async fn write_theme_handler(
    Path(id): Path<String>,
    Json(body): Json<WriteThemeRequest>,
) -> Result<Json<WriteThemeResponse>, AppError> {
    Ok(Json(WriteThemeResponse {
        theme: store::write(&id, &body.content).await?,
    }))
}

#[utoipa::path(
    delete,
    path = "/api/themes/{id}",
    params(("id" = String, Path,)),
    responses((status = 200, body = DeleteThemeResponse))
)]
pub async fn delete_theme_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<DeleteThemeResponse>, AppError> {
    // The project goes first: if that fails the theme is still on disk, so the
    // user can simply delete it again. The other order would leave a project
    // pointing at a folder that is already in the trash.
    workspace::remove(&state.write_pool, &id).await?;
    store::delete(&id).await?;
    Ok(Json(DeleteThemeResponse { success: true }))
}

/// The project this theme is edited in, created on first use. A POST because it
/// can create a project, a conversation and a git repository; repeating it
/// always returns the same ids.
#[utoipa::path(
    post,
    path = "/api/themes/{id}/workspace",
    params(("id" = String, Path,)),
    responses((status = 200, body = ThemeWorkspace))
)]
pub async fn theme_workspace_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ThemeWorkspace>, AppError> {
    Ok(Json(workspace::ensure(&state.write_pool, &id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::themes::models::ThemeAppearance;
    use crate::domain::themes::test_support::{dracula_css_vars, dracula_xterm};

    fn create_request(label: &str) -> CreateThemeRequest {
        CreateThemeRequest {
            label: label.into(),
            appearance: ThemeAppearance::Dark,
            css_vars: dracula_css_vars(),
            xterm: dracula_xterm(),
            chrome: Default::default(),
            copy_assets_from: None,
        }
    }

    #[tokio::test]
    async fn create_response_includes_a_marked_ready_workspace() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        let response = create_theme(&pool, create_request("2026 Route Theme"))
            .await
            .expect("creates complete authoring workspace");

        let marker: (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT kind, authoring_target, plugin_id FROM projects WHERE id = ?")
                .bind(response.workspace.project_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(response.theme.id, "2026-route-theme");
        assert_eq!(
            marker,
            ("user".into(), Some("theme".into()), Some(response.theme.id))
        );
    }

    #[tokio::test]
    async fn retained_theme_can_retry_project_setup_after_creation_failure() {
        let failed_pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        failed_pool.close().await;

        let error = create_theme(&failed_pool, create_request("Retained Route Theme"))
            .await
            .expect_err("closed pool must fail project setup after retaining the theme");
        assert!(matches!(
            error,
            AppError::Coded {
                code: "THEME_PROJECT_SETUP_FAILED",
                ..
            }
        ));
        let retained = store::get("retained-route-theme")
            .await
            .expect("theme remains available for retry");

        let healthy_pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&healthy_pool),
        )
        .await
        .unwrap();
        let first = workspace::ensure(&healthy_pool, &retained.id)
            .await
            .expect("retained theme project setup retries successfully");
        let second = workspace::ensure(&healthy_pool, &retained.id)
            .await
            .expect("project setup retry is idempotent");

        assert_eq!(first.project_id, second.project_id);
        assert_eq!(first.feature_id, second.feature_id);
        let marker: (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT kind, authoring_target, plugin_id FROM projects WHERE id = ?")
                .bind(first.project_id)
                .fetch_one(&healthy_pool)
                .await
                .unwrap();
        assert_eq!(
            marker,
            ("user".into(), Some("theme".into()), Some(retained.id))
        );
    }
}
