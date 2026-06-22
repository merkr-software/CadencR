use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// `GET /api/push/vapid-key` response: the server's VAPID public key, base64url,
/// for the browser's `pushManager.subscribe({ applicationServerKey })`.
#[derive(Debug, Serialize, ToSchema)]
pub struct VapidKeyResponse {
    pub public_key: String,
}

/// The `keys` object a browser's `PushSubscription` exposes (base64url).
#[derive(Debug, Deserialize, ToSchema)]
pub struct PushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// Body of `POST /api/push/subscribe`. Mirrors `PushSubscription.toJSON()`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PushSubscribeRequest {
    pub endpoint: String,
    pub keys: PushSubscriptionKeys,
}

/// Body of `DELETE /api/push/subscribe`.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PushUnsubscribeRequest {
    pub endpoint: String,
}

/// Generic ack for the subscribe/unsubscribe mutations.
#[derive(Debug, Serialize, ToSchema)]
pub struct PushSubscriptionResponse {
    pub ok: bool,
}
