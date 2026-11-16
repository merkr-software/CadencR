use clap::{Parser, Subcommand};

#[derive(Parser, Debug, Clone)]
#[command(name = "cadencr-service", about = "Cadencr Rust backend service")]
pub struct Config {
    /// Path to the SQLite database file
    #[arg(long, global = true, env = "CADENCR_DB_PATH")]
    pub db_path: Option<String>,

    /// Directory holding the JSON settings files (`settings.json` and
    /// `<project>.settings.json`). The desktop shell passes
    /// `~/.cadencr/settings`; dev/CLI runs derive it from `--db-path` when
    /// unset (see `settings_store::dir::resolve_from_config`).
    #[arg(long, env = "CADENCR_SETTINGS_DIR")]
    pub settings_dir: Option<String>,

    /// Port to listen on (overridable via CADENCR_RUST_PORT env var)
    #[arg(long, default_value = "5005", env = "CADENCR_RUST_PORT")]
    pub port: u16,

    /// Frontend dev server port used for local-origin allowlists.
    #[arg(long, default_value = "1420", env = "CADENCR_FRONTEND_PORT")]
    pub frontend_port: u16,

    /// Per-launch bearer token. Required when running the HTTP server; unused
    /// in `mcp-serve` mode. The desktop shell mints one at launch; dev runs read
    /// it from `packages/service/.env`.
    #[arg(long, env = "CADENCR_AUTH_TOKEN", hide_env_values = true)]
    pub auth_token: Option<String>,

    /// Version string used to name pre-migration backups. The desktop shell
    /// passes its `package.json` version; dev runs leave it unset.
    #[arg(long, env = "CADENCR_APP_VERSION")]
    pub app_version: Option<String>,

    /// Directory holding the built SPA assets, served over HTTPS to remote
    /// devices. The desktop shell passes its packaged `renderer` dir; dev runs
    /// leave it unset (Vite serves the renderer, so remote access is a
    /// packaged-build-only feature — see `remote::RemoteError::NoRendererDir`).
    #[arg(long, env = "CADENCR_RENDERER_DIR")]
    pub renderer_dir: Option<String>,

    /// Port for the remote-access TLS listener, bound on `0.0.0.0` only while
    /// remote access is enabled. Distinct from `--port` (the loopback listener)
    /// because both interfaces can't share one port.
    #[arg(long, default_value = "5006", env = "CADENCR_REMOTE_PORT")]
    pub remote_port: u16,

    /// Shut down when stdin reaches end-of-file. The desktop shell spawns the
    /// service with a stdin pipe it never writes to, so the pipe closes when
    /// the shell exits however it exits (crash and force-quit included),
    /// instead of leaving an orphan holding the port. Dev and standalone runs
    /// leave it unset.
    #[arg(long)]
    pub exit_with_parent: bool,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug, Clone)]
pub enum Command {
    /// Run as an MCP stdio server. Each subprocess is pinned to one feature:
    /// tool calls read the id from `McpContext` (see `mcp/context.rs`) rather
    /// than from caller-supplied arguments, closing the confused-deputy vector
    /// across features. A task-local scope would be cleaner but `rmcp`
    /// occasionally dispatches handlers on fresh tokio tasks that do not
    /// inherit task-locals, so the id is stored on the shared context instead.
    McpServe {
        /// MCP server to serve. Only `browser` is supported.
        #[arg(long)]
        agent_type: String,

        #[arg(long)]
        feature_id: i64,

        /// Source CadencR agent session id for provenance and orchestration
        /// controls. Optional for older browser-only MCP launches.
        #[arg(long)]
        session_id: Option<i64>,
    },

    /// Validate a theme folder and print what the app would refuse to apply.
    ///
    /// This is the app's own gate, run on demand. It exists for whoever is
    /// editing a theme — in practice an agent, which cannot see the theme
    /// library where the verdict is otherwise shown. Needs no database, no
    /// settings and no running server; exits non-zero when the theme has
    /// problems.
    CheckTheme {
        /// The theme's folder. Defaults to the working directory, which is
        /// where the agent editing a theme already is.
        #[arg(default_value = ".")]
        path: std::path::PathBuf,
    },
}

#[cfg(test)]
mod tests {
    use super::Config;
    use clap::Parser;

    #[test]
    fn the_desktop_shell_lifetime_flag_is_opt_in() {
        let shell = Config::try_parse_from(["cadencr-service", "--exit-with-parent"]).unwrap();
        assert!(shell.exit_with_parent);
        let standalone = Config::try_parse_from(["cadencr-service"]).unwrap();
        assert!(!standalone.exit_with_parent);
    }
}
