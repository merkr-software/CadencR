use axum::extract::{Json, Query, State};
use axum::routing::get;
use axum::Router;

use super::models::{ConversationIndexEntry, MessageSearchHit, SearchMessagesParams};
use super::repository::{self, MessageSearch};
use crate::app_state::AppState;
use crate::error::AppError;

const DEFAULT_MESSAGE_HITS: i64 = 8;
const MAX_MESSAGE_HITS: i64 = 30;

/// Every conversation, active and archived, most recently touched first: the
/// command palette ranks them client-side as the user types.
#[utoipa::path(get, path = "/api/search/conversations",
    responses((status = 200, body = Vec<ConversationIndexEntry>)))]
pub async fn list_conversation_index_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<ConversationIndexEntry>>, AppError> {
    Ok(Json(
        repository::conversation_index(&state.read_pool).await?,
    ))
}

/// Conversations whose prompts or replies contain every word of `q`, one hit
/// (the newest matching message) per conversation, newest first.
#[utoipa::path(get, path = "/api/search/messages",
    params(SearchMessagesParams),
    responses((status = 200, body = Vec<MessageSearchHit>)))]
pub async fn search_messages_handler(
    State(state): State<AppState>,
    Query(params): Query<SearchMessagesParams>,
) -> Result<Json<Vec<MessageSearchHit>>, AppError> {
    let Some(fts_query) = repository::fts_prefix_query(&params.q) else {
        return Ok(Json(Vec::new()));
    };
    let limit = params
        .limit
        .unwrap_or(DEFAULT_MESSAGE_HITS)
        .clamp(1, MAX_MESSAGE_HITS);
    let search = MessageSearch {
        fts_query: &fts_query,
        limit: limit as usize,
        project_id: params.project_id,
        active_only: params.active_only,
    };
    Ok(Json(
        repository::search_messages(&state.read_pool, search).await?,
    ))
}

pub fn search_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/search/conversations",
            get(list_conversation_index_handler),
        )
        .route("/api/search/messages", get(search_messages_handler))
}
