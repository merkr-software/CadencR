mod api;
mod app_state;
mod config;
mod domain;
mod error;
mod shared;

use axum::http::header::{HeaderName, CONTENT_TYPE};
use axum::http::Method;
use clap::Parser;
use std::path::{Path, PathBuf};
use tower_http::cors::CorsLayer;
use tracing::info;

use app_state::AppState;
use config::{Command, Config};
use shared::db;

const SERVICE_DOTENV_DISPLAY_PATH: &str = "packages/service/.env";
const SERVICE_DOTENV_EXAMPLE_PATH: &str = "packages/service/.env.example";
const REQUIRED_DEV_ENV_KEYS: [&str; 4] = [
    "CADENCR_DB_PATH",
    "CADENCR_RUST_PORT",
    "CADENCR_FRONTEND_PORT",
    "CADENCR_AUTH_TOKEN",
];

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Only debug builds touch the dev `.env`. Release binaries shipped inside
    // the desktop app must not pick up whatever happens to live next to the
    // source tree on the developer machine — that is exactly how the prod
    // database used to get repointed at the dev DB on the user's laptop.
    let dotenv_path = if cfg!(debug_assertions) {
        load_optional_package_dotenv(env!("CARGO_MANIFEST_DIR"))?
    } else {
        None
    };

    let config = Config::parse();

    let is_mcp = config.command.is_some();
    init_tracing(is_mcp);

    match &config.command {
        Some(Command::McpServe {
            agent_type,
            feature_id,
        }) => {
            let db_path = config
                .db_path
                .clone()
                .expect("--db-path or CADENCR_DB_PATH env var required for mcp-serve");

            domain::mcp::stdio::run_mcp_stdio(&db_path, agent_type, *feature_id).await?;
        }
        None => {
            if cfg!(debug_assertions) {
                let dotenv_path = require_dev_env_file(dotenv_path)?;
                validate_required_env_keys(SERVICE_DOTENV_DISPLAY_PATH, &REQUIRED_DEV_ENV_KEYS)?;
                info!("Loaded env from {}", dotenv_path.display());
            } else if let Some(dotenv_path) = dotenv_path.as_deref() {
                info!("Loaded env from {}", dotenv_path.display());
            }

            // Hydrate process env from the user's login shell BEFORE any
            // subprocesses (git, gpg, ssh, agent CLIs, PTY shells) get
            // spawned. Without this, a Electron/launchd-launched binary
            // inherits a stripped-down env (`PATH=/usr/bin:/bin:...`, no
            // `GPG_TTY`, no `SSH_AUTH_SOCK`) and `git commit -S` fails for
            // anyone who configured signing or agent sockets in their
            // `.zshrc` / `.zprofile`. Best-effort: warns on failure,
            // never blocks startup.
            shared::login_env::hydrate_from_login_shell().await;

            let db_path = config
                .db_path
                .clone()
                .expect("--db-path or CADENCR_DB_PATH env var required");

            let write_pool = db::create_write_pool(&db_path).await?;
            shared::migrate::run_migrations(&shared::migrate::MigrationContext {
                pool: &write_pool,
                db_path: Some(std::path::Path::new(&db_path)),
                app_version: config.app_version.as_deref(),
            })
            .await?;
            let read_pool = db::create_read_pool(&db_path).await?;

            // Mark any sessions left as 'running' from a previous crash as 'paused'
            domain::ws_session::persistence::WsSessionPersistence::cleanup_stale_sessions(
                &write_pool,
            )
            .await;

            let (session_status_tx, _) = tokio::sync::broadcast::channel(64);
            let (file_change_tx, _) = tokio::sync::broadcast::channel(16);

            let auth_token = config.auth_token.ok_or_else(|| {
                anyhow::anyhow!(
                    "CADENCR_AUTH_TOKEN is required. Pass --auth-token <tok> or set the env \
                     var. Dev runs: set it in `packages/service/.env`. \
                     Production runs: the desktop shell generates one per launch and passes it \
                     as a CLI flag."
                )
            })?;

            let state = AppState {
                read_pool,
                write_pool,
                max_parallel_agents: AppState::max_parallel_from_env(),
                agent_timeout_minutes: AppState::agent_timeout_minutes_from_env(),
                session_status_tx: domain::session_status::SessionStatusBroadcaster::new(
                    session_status_tx,
                    std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
                ),
                pty_manager: domain::terminal::service::PtyManager::new(),
                file_change_tx,
                file_watcher: domain::editor::watcher::new_shared(),
                auth_token,
                frontend_port: config.frontend_port,
                port: config.port,
                custom_action_scheduler:
                    domain::custom_actions::scheduler::CustomActionScheduler::new(),
                git_watcher: std::sync::Arc::new(domain::git::watcher::GitWatcherRegistry::new()),
                push_sessions: std::sync::Arc::new(
                    domain::git::push_sessions::PushSessionRegistry::new(),
                ),
                ws_feature_senders:
                    domain::ws_session::sender_registry::WsFeatureSenderRegistry::new(),
                auto_name_runs: std::sync::Arc::new(
                    domain::features::run_registry::FeatureRunRegistry::new(),
                ),
            };

            // Push user-selected CLI binary paths into the SDK overrides
            // BEFORE the warmup runs — the opencode warmup spawns the server
            // process, which needs to honor the override on first launch.
            domain::agents::apply_binary_overrides_from_settings(&state.read_pool).await;
            domain::agents::spawn_runtime_startup_warmups();

            // Resume periodic custom-action schedules from a previous launch.
            state.custom_action_scheduler.bootstrap(&state).await;

            let pty_manager = state.pty_manager.clone();
            let app = api::build_router(state).layer(build_cors_layer(config.frontend_port));

            let addr = format!("127.0.0.1:{}", config.port);
            info!("Cadencr service listening on {addr}");

            let listener = tokio::net::TcpListener::bind(&addr).await?;
            // Wrap in a `Listener` that disables Nagle's algorithm on every
            // accepted connection. Nagle is the default on `tokio::net::TcpStream`
            // and silently coalesces small frames for ~200 ms — which turns
            // a real-time WebSocket stream (commit output, agent output) into
            // a "dump everything at the end" feed. We never want that here.
            axum::serve(NoDelayListener(listener), app)
                .with_graceful_shutdown(shutdown_signal(pty_manager))
                .await?;
        }
    }

    Ok(())
}

/// `tokio::net::TcpListener` wrapper that disables Nagle's algorithm on every
/// accepted connection. Without this, small WebSocket frames (single
/// command-output chunks, agent stream lines) sit in the OS TCP buffer for
/// up to ~200 ms before being flushed, which destroys the live-streaming UX
/// the commit dialog and agent panes depend on.
struct NoDelayListener(tokio::net::TcpListener);

impl axum::serve::Listener for NoDelayListener {
    type Io = tokio::net::TcpStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.0.accept().await {
                Ok((stream, addr)) => {
                    // Best-effort: a `set_nodelay` failure on a localhost
                    // TCP stream is exotic and not worth aborting the
                    // connection over — log it and continue.
                    if let Err(err) = stream.set_nodelay(true) {
                        tracing::warn!("set_nodelay failed: {err}");
                    }
                    return (stream, addr);
                }
                Err(err) => {
                    // Mirror axum's own retry-with-backoff behavior on
                    // transient accept errors; without this an EMFILE / per-
                    // process FD exhaustion would tight-loop.
                    tracing::warn!("accept failed: {err}");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

fn service_dotenv_path(manifest_dir: impl AsRef<Path>) -> PathBuf {
    manifest_dir.as_ref().join(".env")
}

fn load_optional_package_dotenv(manifest_dir: impl AsRef<Path>) -> anyhow::Result<Option<PathBuf>> {
    let dotenv_path = service_dotenv_path(manifest_dir);
    if !dotenv_path.is_file() {
        return Ok(None);
    }

    // `from_path_override` so a parent process leaking CADENCR_* vars (the
    // most common case: an in-app agent shell running `cargo run` from a
    // worktree) cannot shadow the dev defaults declared in `.env`.
    dotenvy::from_path_override(&dotenv_path).map_err(|error| {
        anyhow::anyhow!("Failed to load `{SERVICE_DOTENV_DISPLAY_PATH}`: {error}")
    })?;

    Ok(Some(dotenv_path))
}

fn require_dev_env_file(dotenv_path: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    dotenv_path.ok_or_else(|| {
        anyhow::anyhow!(
            "Missing required dev env file `{SERVICE_DOTENV_DISPLAY_PATH}`. Copy \
             `{SERVICE_DOTENV_EXAMPLE_PATH}` to `{SERVICE_DOTENV_DISPLAY_PATH}`."
        )
    })
}

fn validate_required_env_keys(display_path: &str, required_keys: &[&str]) -> anyhow::Result<()> {
    let missing = required_keys
        .iter()
        .copied()
        .filter(|key| {
            std::env::var(key)
                .ok()
                .is_none_or(|value| value.trim().is_empty())
        })
        .collect::<Vec<_>>();

    if missing.is_empty() {
        return Ok(());
    }

    anyhow::bail!(
        "Missing required keys in `{display_path}`: {}.",
        missing.join(", ")
    )
}

fn build_cors_layer(frontend_port: u16) -> CorsLayer {
    let mut origins = vec!["null".parse().expect("static origin")];
    if cfg!(debug_assertions) {
        origins.push(
            format!("http://localhost:{frontend_port}")
                .parse()
                .expect("frontend origin"),
        );
        origins.push(
            format!("http://127.0.0.1:{frontend_port}")
                .parse()
                .expect("frontend origin"),
        );
    }

    CorsLayer::new()
        .allow_origin(origins)
        .allow_headers([
            HeaderName::from_static(api::middleware::AUTH_HEADER),
            CONTENT_TYPE,
        ])
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
        ])
}

/// MCP subprocess mode writes to stderr to keep stdout clean for JSON-RPC.
fn init_tracing(to_stderr: bool) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "cadencr_service=info".into());

    if to_stderr {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(std::io::stderr)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
}

async fn shutdown_signal(pty_manager: domain::terminal::service::PtyManager) {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("Shutdown signal received, shutting down gracefully...");

    pty_manager.kill_all();
    crate::domain::agents::shutdown_runtime_servers().await;

    tracing::info!("Runtime servers stopped.");
}

#[cfg(test)]
mod tests {
    use super::{
        load_optional_package_dotenv, require_dev_env_file, service_dotenv_path,
        validate_required_env_keys, REQUIRED_DEV_ENV_KEYS, SERVICE_DOTENV_DISPLAY_PATH,
    };
    use std::fs;
    use std::sync::{Mutex, OnceLock};
    use tempfile::tempdir;

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn clear_env(keys: &[&str]) {
        for key in keys {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn package_dotenv_loads_only_manifest_dir() {
        let _guard = env_lock().lock().unwrap();
        let workspace = tempdir().unwrap();
        let manifest_dir = workspace.path().join("service");
        let env_path = service_dotenv_path(&manifest_dir);

        std::env::remove_var("SERVICE_TEST_ONLY");
        fs::create_dir(&manifest_dir).unwrap();

        assert_eq!(load_optional_package_dotenv(&manifest_dir).unwrap(), None);

        fs::write(&env_path, "SERVICE_TEST_ONLY=loaded-from-manifest\n").unwrap();

        let loaded = load_optional_package_dotenv(&manifest_dir).unwrap();

        assert_eq!(loaded, Some(env_path));
        assert_eq!(
            std::env::var("SERVICE_TEST_ONLY").unwrap(),
            "loaded-from-manifest"
        );

        std::env::remove_var("SERVICE_TEST_ONLY");
    }

    #[test]
    fn missing_dev_env_file_is_fatal() {
        let error = require_dev_env_file(None).unwrap_err();

        assert!(error.to_string().contains("packages/service/.env"));
    }

    #[test]
    fn missing_required_local_keys_are_fatal() {
        let _guard = env_lock().lock().unwrap();
        let workspace = tempdir().unwrap();
        let manifest_dir = workspace.path().join("service");
        let env_path = service_dotenv_path(&manifest_dir);
        fs::create_dir(&manifest_dir).unwrap();
        clear_env(&REQUIRED_DEV_ENV_KEYS);
        fs::write(
            &env_path,
            "CADENCR_DB_PATH=./cadencr.local.db\nCADENCR_RUST_PORT=5005\nCADENCR_AUTH_TOKEN=\n",
        )
        .unwrap();
        load_optional_package_dotenv(&manifest_dir).unwrap();

        let error = validate_required_env_keys(SERVICE_DOTENV_DISPLAY_PATH, &REQUIRED_DEV_ENV_KEYS)
            .unwrap_err();

        let message = error.to_string();
        assert!(message.contains("CADENCR_FRONTEND_PORT"));
        assert!(message.contains("CADENCR_AUTH_TOKEN"));
        clear_env(&REQUIRED_DEV_ENV_KEYS);
    }
}
