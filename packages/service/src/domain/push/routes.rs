//! HTTP surface for Web Push.
//!
//! `GET /api/push/vapid-key` is mounted on the shared API surface (the frontend
//! fetches the public key before subscribing). `subscribe`/`unsubscribe` are
//! mounted on the **remote** router only: they key state to the authenticated
//! device id (injected by `remote_auth_middleware`), which the loopback router
//! never carries.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};

use super::models::{
    PushSubscribeRequest, PushSubscriptionResponse, PushUnsubscribeRequest, VapidKeyResponse,
};
use super::repo;
use crate::api::middleware::DeviceId;
use crate::app_state::AppState;
use crate::error::AppError;

/// Shared (loopback + remote): exposes the VAPID public key.
pub fn vapid_key_router() -> Router<AppState> {
    Router::new().route("/api/push/vapid-key", get(vapid_key_handler))
}

/// Remote-only: device-authenticated subscription management.
pub fn remote_router() -> Router<AppState> {
    Router::new().route(
        "/api/push/subscribe",
        post(subscribe_handler).delete(unsubscribe_handler),
    )
}

#[utoipa::path(
    get,
    path = "/api/push/vapid-key",
    responses((status = 200, body = VapidKeyResponse))
)]
pub async fn vapid_key_handler(State(state): State<AppState>) -> Json<VapidKeyResponse> {
    Json(VapidKeyResponse {
        public_key: state.push.public_key_b64().to_string(),
    })
}

#[utoipa::path(
    post,
    path = "/api/push/subscribe",
    request_body = PushSubscribeRequest,
    responses((status = 200, body = PushSubscriptionResponse))
)]
pub async fn subscribe_handler(
    State(state): State<AppState>,
    Extension(device): Extension<DeviceId>,
    Json(req): Json<PushSubscribeRequest>,
) -> Result<Json<PushSubscriptionResponse>, AppError> {
    repo::upsert_subscription(
        &state.write_pool,
        device.0,
        &req.endpoint,
        &req.keys.p256dh,
        &req.keys.auth,
    )
    .await?;
    Ok(Json(PushSubscriptionResponse { ok: true }))
}

#[utoipa::path(
    delete,
    path = "/api/push/subscribe",
    request_body = PushUnsubscribeRequest,
    responses((status = 200, body = PushSubscriptionResponse))
)]
pub async fn unsubscribe_handler(
    State(state): State<AppState>,
    Extension(device): Extension<DeviceId>,
    Json(req): Json<PushUnsubscribeRequest>,
) -> Result<Json<PushSubscriptionResponse>, AppError> {
    let removed = repo::delete_subscription(&state.write_pool, device.0, &req.endpoint).await?;
    Ok(Json(PushSubscriptionResponse { ok: removed }))
}
