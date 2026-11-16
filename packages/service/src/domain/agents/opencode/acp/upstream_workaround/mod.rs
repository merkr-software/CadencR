//! Workarounds for limitations in OpenCode's ACP implementation.
//!
//! Each module under this directory exists because something OpenCode
//! does *not* expose over the ACP JSON-RPC wire forces us to fall back
//! to the embedded HTTP backend. The same `opencode acp` subprocess we
//! already spawn for ACP also serves HTTP on its `--hostname --port`
//! flags (see `Server.listen({hostname, port})` in
//! `opencode/src/cli/cmd/acp.ts` upstream — the same flags `acp/mod.rs`
//! passes when spawning the subprocess).
//!
//! ## Current modules
//!
//! - **`root_usage_listener`** — OpenCode ACP only forwards context usage
//!   after `session/prompt` resolves. We poll the root session's HTTP
//!   message snapshot and emit token updates as soon as OpenCode persists
//!   them.
//! - **`subagent_listener`** + **`subagent_permission`** — OpenCode's
//!   `ACPSessionManager` (`opencode/src/acp/agent.ts`) silently drops every
//!   `session/update` and `session/request_permission` for sessions it has
//!   not explicitly registered. Sub-agents spawned via the `Task` tool are
//!   never registered, so their events never reach the ACP wire (upstream
//!   issue sst/opencode#6573). We poll the embedded HTTP backend's
//!   `GET /session/{id}/children`, `GET /session/{id}/message`, and
//!   `GET /permission` to discover sub-agents, tail their messages, and
//!   surface their permission prompts. Permission replies are routed
//!   through `POST /permission/{id}/reply` (see `acp/sse_permission_reply`).
//!   We tried OpenCode's `/event` SSE bus first; it only emits
//!   `server.heartbeat` in `opencode acp` mode, so polling is mandatory.
//!
//! ## Removal criteria
//!
//! Each workaround tracks a specific upstream limitation. When that
//! limitation is fixed:
//!
//! 1. Delete the workaround module here.
//! 2. If no remaining module needs the embedded HTTP backend, the
//!    `--hostname --port` plumbing in `acp/mod.rs` (and the matching
//!    methods on `opencode_sdk_rs::OpenCodeClient`) can also be removed.
//!    Note that `question_sidecar.rs` is *not* a workaround — it's a
//!    designed sidecar for the question tool that uses the same
//!    embedded backend, so it would also need to migrate before the
//!    `--port` flag can go.

mod child_status;
mod pending_subagents;
mod root_usage_listener;
mod side_channel;
mod subagent_listener;
mod subagent_permission;

// Re-export the symbols the OpenCode ACP adapter consumes. Keeping the
// re-exports here (rather than `pub(in …)` on the items themselves) means
// the adapter's import path is `super::upstream_workaround::{…}` — short,
// and a grep for `upstream_workaround::` lands directly on every consumer.
pub(super) use pending_subagents::{PendingSubagentState, PendingSubagentTasks};
pub(super) use side_channel::spawn_side_channel_listeners;
pub(super) use subagent_listener::PermissionRegistry;
