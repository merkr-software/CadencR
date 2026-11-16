use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::mcp::McpServerConfig;
use crate::permissions::{CanUseTool, PermissionMode};

/// Configuration for a Claude query.
#[derive(bon::Builder)]
#[builder(on(String, into))]
pub struct Options {
    /// Working directory for the CLI process.
    #[builder(default = default_cwd(), into)]
    pub cwd: PathBuf,
    /// Permission mode (default, plan, acceptEdits, bypassPermissions, dontAsk).
    pub permission_mode: Option<PermissionMode>,
    /// Override path to the `claude` CLI binary.
    #[builder(into)]
    pub path_to_cli: Option<PathBuf>,
    /// Model name (e.g. "claude-opus-4-5").
    pub model: Option<String>,
    /// Model effort level for effort-capable models.
    pub effort: Option<String>,
    /// System prompt prepended to every turn.
    pub system_prompt: Option<String>,
    /// Session ID to resume an existing conversation.
    pub resume: Option<String>,
    /// Tool names that are auto-approved without prompting.
    pub allowed_tools: Option<Vec<String>>,
    /// Allow entering `bypassPermissions` later without starting in that
    /// mode. This maps to Claude Code's
    /// `--allow-dangerously-skip-permissions` capability flag.
    #[builder(default)]
    pub allow_dangerously_skip_permissions: bool,
    /// MCP server configurations, keyed by server name.
    pub mcp_servers: Option<HashMap<String, McpServerConfig>>,
    /// Claude Code's user file (`.claude.json`), whose user and per-project
    /// MCP servers are listed as configured before the CLI reports them. The
    /// caller resolves it for the environment the CLI runs with; `None` lists
    /// none from it.
    pub user_config_file: Option<PathBuf>,
    /// Settings sources (default: ["user", "project", "local"]).
    #[builder(default = default_setting_sources())]
    pub setting_sources: Vec<String>,
    /// Always `true` — Cadencr always uses streaming partial messages.
    /// Hardcoded in `to_cli_args` via `--output-format stream-json`.
    #[builder(skip = true)]
    pub include_partial_messages: bool,
    /// Re-emit stdin user messages on stdout so hosts can acknowledge
    /// when a steering prompt has actually reached Claude Code. Enabled by
    /// default; tests may disable it for mock CLIs that exit without draining
    /// every startup/control stdin frame.
    #[builder(default = true)]
    pub replay_user_messages: bool,
    /// Language / locale override passed to the CLI.
    pub language: Option<String>,

    // --- Runtime-only fields (not serialised to CLI flags) ---
    /// Permission handler. When set, every permission control_request from
    /// the CLI is dispatched to this trait method on a *separate* task so
    /// the SDK reader keeps processing other inbound messages (notably the
    /// `control_response`s for `set_permission_mode` issued from inside
    /// the callback itself, e.g. after `ExitPlanMode` approval). `Arc` so
    /// the reader can clone the handle into the spawned task.
    pub can_use_tool: Option<Arc<dyn CanUseTool>>,
    /// Cancellation token for aborting a running query.
    pub abort_signal: Option<CancellationToken>,
    /// Start the CLI as the leader of a new process group (Unix), so signals
    /// sent to the host's own group (a terminal's Ctrl-C) do not reach it,
    /// and the host can signal what the CLI leaves in its group through
    /// [`Query::pid`](crate::Query::pid) once it has exited.
    #[builder(default)]
    pub own_process_group: bool,
    /// Extra environment variables layered on top of the inherited parent env
    /// before spawning the CLI. Use this to switch Claude Code between
    /// Anthropic / Bedrock / Vertex / custom proxies without relaunching the
    /// host process.
    pub env: Option<HashMap<String, String>>,
}

impl Default for Options {
    fn default() -> Self {
        Self::builder().build()
    }
}

fn default_cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn default_setting_sources() -> Vec<String> {
    vec!["user".into(), "project".into(), "local".into()]
}

#[allow(clippy::new_without_default)]
impl OptionsBuilder {
    /// Start building [`Options`].
    ///
    /// Prefer [`Options::builder`] in new code.
    #[deprecated(since = "0.9.0", note = "use Options::builder()")]
    pub fn new() -> Self {
        Options::builder()
    }
}

impl Options {
    /// Construct CLI arguments to pass to the `claude` binary.
    ///
    /// Runtime-only fields (`can_use_tool`, `abort_signal`) are never
    /// included here.
    pub fn to_cli_args(&self) -> Vec<String> {
        let mut args = Vec::new();

        // Print mode is required for non-interactive (SDK) usage.
        args.push("--print".to_string());

        // Streaming JSON I/O is always required for the bidirectional protocol.
        args.push("--output-format".to_string());
        args.push("stream-json".to_string());
        args.push("--input-format".to_string());
        args.push("stream-json".to_string());
        // --verbose is required by the CLI when using stream-json output.
        args.push("--verbose".to_string());
        // Include partial streaming events (content_block_delta) for real-time UI.
        args.push("--include-partial-messages".to_string());
        // Re-emit stdin user messages on stdout so hosts can acknowledge
        // when a steering prompt has actually reached Claude Code.
        if self.replay_user_messages {
            args.push("--replay-user-messages".to_string());
        }
        // Force summarized thinking output. Opus 4.7 disables thinking display by
        // default, but Cadencr surfaces thinking summaries in the UI, so we
        // enforce `summarized` regardless of the model's default.
        args.push("--thinking-display".to_string());
        args.push("summarized".to_string());

        // When canUseTool is provided, tell the CLI to delegate permission
        // prompts (including AskUserQuestion) over the stdin/stdout control
        // protocol instead of handling them in the terminal.
        if self.can_use_tool.is_some() {
            args.push("--permission-prompt-tool".to_string());
            args.push("stdio".to_string());
        }

        if let Some(mode) = &self.permission_mode {
            args.push("--permission-mode".to_string());
            args.push(mode.as_cli_flag().to_string());
        }

        if let Some(model) = &self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        if let Some(effort) = &self.effort {
            args.push("--effort".to_string());
            args.push(effort.clone());
        }

        if let Some(session_id) = &self.resume {
            args.push("--resume".to_string());
            args.push(session_id.clone());
        }

        if let Some(prompt) = &self.system_prompt {
            args.push("--system-prompt".to_string());
            args.push(prompt.clone());
        }

        if let Some(tools) = &self.allowed_tools {
            for tool in tools {
                args.push("--allowedTools".to_string());
                args.push(tool.clone());
            }
        }

        if self.allow_dangerously_skip_permissions {
            args.push("--allow-dangerously-skip-permissions".to_string());
        }

        if let Some(lang) = &self.language {
            args.push("--language".to_string());
            args.push(lang.clone());
        }

        // MCP servers are serialised as JSON and passed via --mcp-config.
        if let Some(servers) = &self.mcp_servers {
            if !servers.is_empty() {
                let wrapper = serde_json::json!({ "mcpServers": servers });
                match serde_json::to_string(&wrapper) {
                    Ok(json) => {
                        args.push("--mcp-config".to_string());
                        args.push(json);
                    }
                    Err(e) => {
                        tracing::warn!("Failed to serialize MCP server config: {e}");
                    }
                }
            }
        }

        args
    }
}
