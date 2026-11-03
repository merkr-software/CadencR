//! Explicit marketplace mutations, broadcast through the existing reconciliation event.
use super::{
    managed::{self, InstallLspRequest, LspCatalogResponse, RemoveLspRequest},
    routes::ListServersResponse,
};
use crate::{app_state::AppState, error::AppError};
use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;
use utoipa::IntoParams;
#[derive(Deserialize, IntoParams)]
pub struct CatalogParams {
    #[serde(default)]
    pub refresh: bool,
}
#[utoipa::path(get,path="/api/lsp/catalog",params(CatalogParams),responses((status=200,body=LspCatalogResponse)))]
pub async fn catalog_handler(Query(params): Query<CatalogParams>) -> Json<LspCatalogResponse> {
    Json(managed::catalog(params.refresh).await)
}
#[utoipa::path(post,path="/api/lsp/install",request_body=InstallLspRequest,responses((status=200,body=ListServersResponse)))]
pub async fn install_handler(
    State(state): State<AppState>,
    Json(body): Json<InstallLspRequest>,
) -> Result<Json<ListServersResponse>, AppError> {
    let events = state.settings_events_tx.clone();
    tokio::spawn(async move {
        managed::install(body, false).await?;
        changed(&events);
        Ok::<_, AppError>(())
    })
    .await
    .map_err(managed::invalid)??;
    super::routes::list_servers_handler().await
}
#[utoipa::path(post,path="/api/lsp/update",request_body=InstallLspRequest,responses((status=200,body=ListServersResponse)))]
pub async fn update_handler(
    State(state): State<AppState>,
    Json(body): Json<InstallLspRequest>,
) -> Result<Json<ListServersResponse>, AppError> {
    let events = state.settings_events_tx.clone();
    tokio::spawn(async move {
        managed::install(body, true).await?;
        changed(&events);
        Ok::<_, AppError>(())
    })
    .await
    .map_err(managed::invalid)??;
    super::routes::list_servers_handler().await
}
#[utoipa::path(post,path="/api/lsp/remove",request_body=RemoveLspRequest,responses((status=200,body=ListServersResponse)))]
pub async fn remove_handler(
    State(state): State<AppState>,
    Json(body): Json<RemoveLspRequest>,
) -> Result<Json<ListServersResponse>, AppError> {
    let events = state.settings_events_tx.clone();
    tokio::spawn(async move {
        managed::remove(body.lsp_id).await?;
        changed(&events);
        Ok::<_, AppError>(())
    })
    .await
    .map_err(managed::invalid)??;
    super::routes::list_servers_handler().await
}
fn changed(
    events: &tokio::sync::broadcast::Sender<crate::domain::settings_store::SettingsChangeEvent>,
) {
    // No receivers is expected while the renderer is disconnected.
    let _ = events.send(crate::domain::settings_store::SettingsChangeEvent {
        file: "lsp-marketplace".into(),
    });
}
