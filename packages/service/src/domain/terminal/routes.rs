//! Terminal HTTP routes. The WebSocket that streams a PTY lives in
//! `ws`, its PTY bridge in `bridge`.

mod bridge;
mod ws;

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;

pub fn terminal_router() -> Router<AppState> {
    Router::new()
        .route("/api/terminal/ws", get(ws::terminal_ws_handler))
        .route(
            "/api/terminal/sessions",
            get(list_terminal_sessions_handler),
        )
        .route("/api/terminal/kill", post(kill_terminal_sessions_handler))
        .route(
            "/api/terminal/alacritty-config",
            get(alacritty_config_route),
        )
}

/// A live terminal session a client can attach to (one PTY).
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct TerminalSessionInfo {
    pub pty_id: String,
    pub cwd: String,
    pub alive: bool,
    /// Whether a foreground command is currently running in this shell. The
    /// client uses this to auto-switch an idle terminal to a fresh worktree
    /// while leaving a busy one alone.
    pub foreground_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct TerminalSessionsQuery {
    pub feature_id: i64,
}

/// List the live PTYs for a feature so another device can attach to the same
/// shells (and type into them) instead of spawning a fresh terminal. Only live
/// shells are returned, since attaching to an exited one would just replay
/// scrollback and close.
#[utoipa::path(
    get,
    path = "/api/terminal/sessions",
    params(("feature_id" = i64, Query, description = "Feature whose terminal sessions to list")),
    responses((status = 200, description = "Live terminal sessions", body = [TerminalSessionInfo])),
)]
pub async fn list_terminal_sessions_handler(
    Query(query): Query<TerminalSessionsQuery>,
    State(state): State<AppState>,
) -> Json<Vec<TerminalSessionInfo>> {
    let sessions = state
        .pty_manager
        .feature_ptys(query.feature_id)
        .into_iter()
        .filter(|session| session.alive)
        .map(|session| TerminalSessionInfo {
            pty_id: session.pty_id,
            cwd: session.cwd,
            alive: session.alive,
            foreground_active: session.foreground_active,
        })
        .collect();
    Json(sessions)
}

/// How many shells were terminated by a kill request.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct KillTerminalsResponse {
    pub killed: u32,
}

/// Kill every live shell belonging to a feature. Used when archiving or deleting
/// a feature so its terminals don't keep running in a worktree that may be about
/// to be removed.
///
/// Shells only: the feature's Neovim PTY is `PtyKind::Neovim` and is left
/// running, because this route is also the sidebar's "close activity" action on
/// a feature the user still has open. Neovim teardown belongs to the paths that
/// actually destroy the worktree (`delete_worktree`, `delete_feature`).
#[utoipa::path(
    post,
    path = "/api/terminal/kill",
    params(("feature_id" = i64, Query, description = "Feature whose live terminals to kill")),
    responses((status = 200, description = "Number of shells killed", body = KillTerminalsResponse)),
)]
pub async fn kill_terminal_sessions_handler(
    Query(query): Query<TerminalSessionsQuery>,
    State(state): State<AppState>,
) -> Json<KillTerminalsResponse> {
    let killed = state.pty_manager.kill_feature_ptys(query.feature_id);
    Json(KillTerminalsResponse {
        killed: killed as u32,
    })
}

/// `GET /api/terminal/alacritty-config` — the user's parsed Alacritty
/// config (font, colors, cursor style, scrollback depth), or Alacritty's
/// own documented defaults when there's nothing to read.
#[utoipa::path(
    get,
    path = "/api/terminal/alacritty-config",
    responses((status = 200, body = crate::domain::terminal::alacritty_config::AlacrittyConfigResponse))
)]
pub async fn alacritty_config_route(
    State(state): State<AppState>,
) -> Json<crate::domain::terminal::alacritty_config::AlacrittyConfigResponse> {
    Json(
        crate::domain::terminal::alacritty_config::read_alacritty_config_response(
            state.fallback_palette.clone(),
        ),
    )
}
