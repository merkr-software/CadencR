mod api;
mod app_state;
mod config;
mod dev_env;
mod domain;
mod error;
mod remote;
mod shared;
mod shutdown;

use axum::http::header::{HeaderName, CONTENT_TYPE};
use axum::http::Method;
use axum::serve::ListenerExt;
use clap::Parser;
use std::path::PathBuf;
use tower_http::cors::CorsLayer;
use tracing::info;

use app_state::AppState;
use config::{Command, Config};
use shared::db;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Only debug builds touch the dev `.env`. Release binaries shipped inside
    // the desktop app must not pick up whatever happens to live next to the
    // source tree on the developer machine — that is exactly how the prod
    // database used to get repointed at the dev DB on the user's laptop.
    let dotenv_path = if cfg!(debug_assertions) {
        dev_env::load_optional_package_dotenv(env!("CARGO_MANIFEST_DIR"))?
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
            session_id,
        }) => {
            let db_path = config
                .db_path
                .clone()
                .expect("--db-path or CADENCR_DB_PATH env var required for mcp-serve");
            let settings_dir = domain::settings_store::dir::resolve_from_config(
                config.settings_dir.as_deref(),
                &db_path,
            );
            domain::settings_store::init(settings_dir);

            domain::mcp::stdio::run_mcp_stdio(&db_path, agent_type, *feature_id, *session_id)
                .await?;
        }
        None => {
            if cfg!(debug_assertions) {
                let dotenv_path = dev_env::require_dev_env_file(dotenv_path)?;
                dev_env::validate_required_env_keys(
                    dev_env::SERVICE_DOTENV_DISPLAY_PATH,
                    &dev_env::REQUIRED_DEV_ENV_KEYS,
                )?;
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

            // Resolve the JSON settings dir, migrate legacy SQLite settings into
            // it (idempotent + non-destructive), and make it the process-wide
            // settings location BEFORE anything reads settings (binary
            // overrides, remote auto-start, agent warmups all do).
            let settings_dir = domain::settings_store::dir::resolve_from_config(
                config.settings_dir.as_deref(),
                &db_path,
            );
            if let Err(e) = std::fs::create_dir_all(&settings_dir) {
                tracing::warn!(dir = %settings_dir.display(), "failed to create settings dir: {e}");
            }
            // Resolve to an absolute path so the "Edit JSON" / "Copy path" UI
            // shows a usable location. In dev the dir derives from a relative
            // `--db-path`, which would otherwise surface as a confusing
            // CWD-relative `./cadencr-settings/settings.json`.
            let settings_dir = std::fs::canonicalize(&settings_dir).unwrap_or(settings_dir);
            domain::settings_store::init(settings_dir.clone());
            domain::settings_store::migrate::migrate_from_sqlite(&read_pool, &settings_dir).await;
            // Claude Code profiles moved out of SQLite into the nested `profiles`
            // section of settings.json — copy any legacy rows over, then drop the
            // table. Needs `write_pool` for the DROP and must run after the dir is
            // initialized so the JSON write lands in the right place.
            domain::agents::claude_code::profiles::migrate_from_sqlite(&write_pool).await;
            // Strip per-device UI state (active tab, sidebar visibility,
            // last-opened feature) that older versions wrote into the global
            // file — it now lives in the frontend's localStorage.
            match domain::settings_store::prune_ephemeral_global().await {
                Ok(true) => info!("pruned legacy per-device UI keys from settings.json"),
                Ok(false) => {}
                Err(e) => tracing::warn!("failed to prune ephemeral settings keys: {e}"),
            }

            // Mark any sessions left as 'running' from a previous crash as 'paused'
            domain::ws_session::persistence::WsSessionPersistence::cleanup_stale_sessions(
                &write_pool,
            )
            .await;
            let recovered_shell_context =
                domain::ws_session::handler::recover_user_shell_context(&write_pool)
                    .await
                    .map_err(anyhow::Error::msg)?;
            if recovered_shell_context > 0 {
                info!(
                    recovered_shell_context,
                    "recovered interrupted user shell context"
                );
            }
            // Import usage stats from conversations that predate the stats
            // table, once per install. The boundary between history and live
            // recording is claimed here, before the service can accept a
            // prompt; the scan itself is backgrounded, since on a large history
            // it reads hundreds of megabytes of message text.
            domain::usage_stats::start_backfill(&write_pool).await;

            let recovered =
                domain::sessions::message_dispatch::recover_orphaned_claims(&write_pool).await?;
            if recovered > 0 {
                info!(recovered, "recovered orphaned message delivery claims");
            }

            let auth_token = config.auth_token.ok_or_else(|| {
                anyhow::anyhow!(
                    "CADENCR_AUTH_TOKEN is required. Pass --auth-token <tok> or set the env \
                     var. Dev runs: set it in `packages/service/.env`. \
                     Production runs: the desktop shell generates one per launch and passes it \
                     as a CLI flag."
                )
            })?;
            // The launch token belongs to the service process only. Keep the
            // owned copy in AppState, but remove the ambient environment copy
            // before any user-controlled terminal/action/git child can inherit
            // it. Individual spawn choke points also scrub it defensively.
            std::env::remove_var(shared::security::SERVICE_AUTH_TOKEN_ENV);

            let remote_data_dir = remote::paths::remote_data_dir()?;
            let remote_controller =
                std::sync::Arc::new(remote::RemoteController::new(remote::RemoteConfig {
                    renderer_dir: config.renderer_dir.clone().map(PathBuf::from),
                    remote_port: config.remote_port,
                    data_dir: remote_data_dir.clone(),
                }));

            let state = AppState::for_server(
                read_pool,
                write_pool,
                db_path.clone(),
                auth_token,
                config.frontend_port,
                config.port,
                remote_controller,
                &remote_data_dir,
            );

            // Watch the settings dir so external edits to the JSON files push a
            // live refresh to connected clients.
            domain::settings_store::watcher::start(&settings_dir, state.settings_events_tx.clone());

            // Background Web Push dispatcher: turns agent finished / needs-input
            // transitions into native push for backgrounded remote PWAs. Cheap
            // when no subscriptions exist; runs for the process lifetime.
            tokio::spawn(domain::push::dispatcher::run(state.clone()));

            // Push user-selected CLI binary paths into the SDK overrides
            // BEFORE the warmup runs — the opencode warmup spawns the server
            // process, which needs to honor the override on first launch.
            domain::agents::apply_binary_overrides_from_settings(&state.read_pool).await;
            domain::agents::spawn_runtime_startup_warmups();

            // Reconcile custom-action runs orphaned by the previous exit: their
            // processes died with the old service instance, so finalize them
            // instead of leaving the UI stuck "running" and unable to re-run.
            match domain::custom_actions::repository::fail_orphaned_runs(&state.write_pool).await {
                Ok(n) if n > 0 => info!(count = n, "reconciled orphaned custom action runs"),
                Ok(_) => {}
                Err(e) => tracing::warn!("failed to reconcile orphaned custom action runs: {e}"),
            }

            // Resume periodic custom-action schedules from a previous launch.
            state.custom_action_scheduler.bootstrap(&state).await;

            // Background dispatcher for user-scheduled messages (one poll loop
            // for the process lifetime; survives client disconnects).
            domain::scheduled_messages::scheduler::spawn(state.clone());
            domain::mcp::control::message_queue::spawn(state.clone());
            domain::git::forge::spawn(state.clone());

            // Auto-start remote access if the user left it enabled (persisted
            // setting). Failures are non-fatal — the loopback server must come
            // up regardless, and the UI surfaces the error on next toggle.
            if remote::is_enabled(&state.read_pool).await {
                match state.remote.start(&state).await {
                    Ok(info) => info!("Remote access auto-started on port {}", info.port),
                    Err(err) => tracing::warn!("Remote access auto-start failed: {err}"),
                }
            }

            let pty_manager = state.pty_manager.clone();
            let remote_for_shutdown = state.remote.clone();
            // Shutdown drains the usage writes still in flight; a loss it can't
            // drain is persisted, so it needs the write pool.
            let write_pool_for_shutdown = state.write_pool.clone();
            let app = api::build_router(state).layer(build_cors_layer(config.frontend_port));

            let addr = format!("127.0.0.1:{}", config.port);
            info!("Cadencr service listening on {addr}");

            let listener = tokio::net::TcpListener::bind(&addr).await?;
            // Disable Nagle's algorithm on every accepted connection. Nagle is
            // the default on `tokio::net::TcpStream` and silently coalesces
            // small frames for ~200 ms, which destroys real-time WS streaming.
            let listener = listener.tap_io(|stream| {
                if let Err(err) = stream.set_nodelay(true) {
                    tracing::warn!("set_nodelay failed: {err}");
                }
            });
            // Shutdown ordering lives in `shutdown`: the signal future only
            // closes the listener, then the teardown and the HTTP drain run
            // together, and the usage drain runs last.
            let (drain_tx, drain_rx) = tokio::sync::oneshot::channel();
            let server = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown::stop_admitting_on_signal(drain_tx));
            shutdown::serve_then_flush(
                server,
                drain_rx,
                pty_manager,
                remote_for_shutdown,
                write_pool_for_shutdown,
            )
            .await?;
        }
    }

    Ok(())
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
