use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};

pub fn unauthorized() -> Response {
    let mut resp = (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    resp.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Cadencr-Token"),
    );
    resp
}

pub fn misdirected() -> Response {
    (StatusCode::MISDIRECTED_REQUEST, "host not allowed").into_response()
}

pub fn forbidden(reason: &'static str) -> Response {
    (StatusCode::FORBIDDEN, reason).into_response()
}

/// 429 with a `Retry-After` (seconds) hint. Used by listener rate limiters.
pub fn too_many_requests(retry_after_secs: u64) -> Response {
    let mut resp = (StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded").into_response();
    if let Ok(value) = HeaderValue::from_str(&retry_after_secs.to_string()) {
        resp.headers_mut().insert(header::RETRY_AFTER, value);
    }
    resp
}

pub fn connection_metadata_unavailable() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "connection metadata unavailable",
    )
        .into_response()
}
