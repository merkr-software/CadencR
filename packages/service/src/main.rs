//! Thin binary entry point. Every module lives in the `cadencr_service` lib so
//! the crate compiles (and its unit tests run) once; declaring them again here
//! with `mod` would build a second full copy of the service.

use cadencr_service::{api, app_state, config, dev_env, domain, remote, shared, shutdown};

use anyhow::Context;
use axum::serve::ListenerExt;
use clap::Parser;
use std::path::PathBuf;
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
            domain::settings_store::dir::secure(&settings_dir)?;
            domain::settings_store::init(settings_dir);
            domain::agents::providers::installed::managed::trust::initialize_pinned_registry_trust(
            )
            .await?;

            domain::mcp::stdio::run_mcp_stdio(&db_path, agent_type, *feature_id, *session_id)
                .await?;
        }
        Some(Command::CheckTheme { path }) => {
            // Deliberately no database and no settings dir: the check reads one
            // folder and answers about it, so it has to work from an agent's
            // shell with nothing configured.
            let report = domain::themes::check::run(path).await;
            print!("{}", report.text());
            if !report.applicable {
                std::process::exit(1);
            }
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

            let addr = format!("127.0.0.1:{}", config.port);
            let listener = tokio::net::TcpListener::bind(&addr)
                .await
                .with_context(|| format!("failed to bind Cadencr service listener on {addr}"))?;

            // Freeze the data roots from Electron's launch env, then hydrate the
            // login-shell env before any git, agent or PTY subprocess spawns.
            shared::app_paths::pin_roots()
                .map_err(anyhow::Error::msg)
                .context("could not resolve Cadencr's data directories")?;
            shared::login_env::hydrate_from_login_shell().await;

            let db_path = config
                .db_path
                .clone()
                .expect("--db-path or CADENCR_DB_PATH env var required");

            let write_pool = db::create_write_pool(&db_path).await?;
            shared::migrate::run_migrations(&shared::migrate::MigrationContext {
                pool: &write_pool,
                db_path: dev_env::migration_backup_path(std::path::Path::new(&db_path)),
                app_version: config.app_version.as_deref(),
            })
            .await?;
            dev_env::consume_fresh_clone_marker(std::path::Path::new(&db_path))?;
            // The one-time image backfill needs its destination before it can
            // run. Production uses `~/.cadencr/blobs`; an ad-hoc/dev database
            // gets an isolated directory named after that exact database.
            let blob_dir = domain::blobs::dir::derive_from_db_path(&db_path);
            if let Err(error) = domain::blobs::store::ensure_root(&blob_dir) {
                // Blob writes repeat the durable-directory check and fail open:
                // inline content stays in SQLite if storage is unavailable.
                tracing::warn!(dir = %blob_dir.display(), "failed to prepare blob dir: {error}");
            }
            domain::blobs::dir::init(blob_dir);

            // Reclaim pages requested by a completed background maintenance
            // pass. An incomplete initial optimization keeps the request set
            // for a later startup instead of delaying this one.
            match domain::maintenance::database_compaction::run_if_requested(
                &write_pool,
                std::path::Path::new(&db_path),
            )
            .await
            {
                Ok(_) => {}
                Err(
                    domain::maintenance::database_compaction::DatabaseCompactionError::Integrity(
                        error,
                    ),
                ) => {
                    return Err(anyhow::Error::new(error).context(
                        "Database integrity verification failed. Cadencr stopped before accepting new writes. Restore a recent safety backup or contact support.",
                    ));
                }
                Err(
                    domain::maintenance::database_compaction::DatabaseCompactionError::Operational(
                        error,
                    ),
                ) => {
                    // Compaction is an optimization, never a startup dependency. A
                    // failed VACUUM leaves SQLite's original file intact and the
                    // persisted request set so a later launch can retry safely.
                    tracing::warn!("database compaction skipped: {error}");
                }
            }
            domain::usage_stats::history_import::run_once(&write_pool).await;
            let read_pool = db::create_read_pool(&db_path).await?;

            // Resolve the JSON settings dir, migrate legacy SQLite settings into
            // it (idempotent + non-destructive), and make it the process-wide
            // settings location BEFORE anything reads settings (binary
            // overrides, remote auto-start, agent warmups all do).
            let settings_dir = domain::settings_store::dir::resolve_from_config(
                config.settings_dir.as_deref(),
                &db_path,
            );
            domain::settings_store::dir::secure(&settings_dir)?;
            // Resolve to an absolute path so the "Edit JSON" / "Copy path" UI
            // shows a usable location. In dev the dir derives from a relative
            // `--db-path`, which would otherwise surface as a confusing
            // CWD-relative `./cadencr-settings/settings.json`.
            let settings_dir = std::fs::canonicalize(&settings_dir).unwrap_or(settings_dir);
            domain::settings_store::init(settings_dir.clone());
            domain::agents::providers::installed::managed::trust::initialize_pinned_registry_trust(
            )
            .await?;
            // Bind the provider registry to that settings dir immediately: it
            // scans `<settings-dir>/providers` exactly once, and a lazy first
            // lookup before this point would cache an empty scan of the
            // uninitialized fallback path for the life of the process.
            domain::agents::providers::provider_registry();
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

            // Turns a crash left 'running' are captured for resume, then paused.
            let app_version = config.app_version.as_deref();
            domain::restart_continuations::recover_at_startup(&write_pool, app_version).await;
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
            let recovered =
                domain::sessions::message_dispatch::recover_orphaned_claims(&write_pool).await?;
            if recovered > 0 {
                info!(recovered, "recovered orphaned message delivery claims");
            }
            let interrupted_prompts =
                domain::prompt_queue::store::recover_interrupted_deliveries(&write_pool).await?;
            if interrupted_prompts > 0 {
                info!(
                    interrupted_prompts,
                    "marked interrupted queued prompts as failed"
                );
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

            let state = AppState::for_server()
                .read_pool(read_pool)
                .write_pool(write_pool)
                .db_path(db_path.clone())
                .auth_token(auth_token)
                .frontend_port(config.frontend_port)
                .port(config.port)
                .remote(remote_controller)
                .remote_data_dir(&remote_data_dir)
                .build();

            // Gates persisted by the previous process must still show: seed the
            // live status book (the snapshot every client reads) before any
            // client can connect. Stale `running` rows were reset above.
            let persisted_statuses =
                domain::sessions::repository::get_session_status_snapshot(&state.read_pool)
                    .await
                    .map_err(|error| anyhow::anyhow!("failed to seed session statuses: {error}"))?;
            state
                .session_status_tx
                .seed(persisted_statuses.into_values());

            // Watch the settings dir so external edits to the JSON files push a
            // live refresh to connected clients.
            domain::settings_store::watcher::start(&settings_dir, state.settings_events_tx.clone());

            // Same idea for user themes: editing `theme.json` in your own editor
            // re-injects the tokens live, with no reload.
            domain::themes::watcher::start(
                &domain::themes::paths::themes_dir(),
                state.theme_events_tx.clone(),
            );

            domain::plugin_tabs::watcher::start(
                &domain::plugin_tabs::paths::tabs_dir(),
                state.plugin_tab_events_tx.clone(),
            );
            // Permission changes and revocations revoke live grants (blocked: backends stop first).
            tokio::spawn(domain::plugin_tabs::grants::revoke_on_manifest_change(
                state.plugin_tab_grants.clone(),
                state.plugin_tab_backends.clone(),
                state.plugin_tab_events_tx.subscribe(),
            ));
            state
                .plugin_tab_backends
                .spawn_reaper(&state.plugin_tab_presence);

            // A theme is built in a project named after it, and renaming a theme
            // is editing its file — so the same event that reloads the theme
            // renames the project in the sidebar.
            tokio::spawn(domain::themes::workspace::watch_renames(
                state.write_pool.clone(),
                state.theme_events_tx.subscribe(),
                state.theme_events_tx.clone(),
            ));

            // Watch alacritty.toml so external edits push a live refresh to
            // connected clients, the same way the settings watcher above does
            // for the settings directory.
            domain::terminal::alacritty_config::start_watcher(
                state.alacritty_config_events_tx.clone(),
            );

            // Background Web Push dispatcher: turns agent finished / needs-input
            // transitions into native push for backgrounded remote PWAs. Cheap
            // when no subscriptions exist; runs for the process lifetime.
            tokio::spawn(domain::push::dispatcher::run(state.clone()));
            // Push user-selected CLI binary paths into the SDK overrides
            // BEFORE the warmup runs — the opencode warmup spawns the server
            // process, which needs to honor the override on first launch.
            domain::agents::apply_binary_overrides_from_settings(&state.read_pool).await;
            domain::agents::spawn_runtime_startup_warmups();
            state.provider_updates.spawn_periodic_checks();
            domain::agents::providers::installed::managed::service::spawn_startup_blocklist_refresh(
            );

            // Reconcile custom-action runs orphaned by the previous exit: their
            // processes died with the old service instance, so finalize them
            // instead of leaving the UI stuck "running" and unable to re-run.
            match domain::custom_actions::repository::fail_orphaned_runs(&state.write_pool).await {
                Ok(n) if n > 0 => info!(count = n, "reconciled orphaned custom action runs"),
                Ok(_) => {}
                Err(e) => tracing::warn!("failed to reconcile orphaned custom action runs: {e}"),
            }
            // Same for sub-agents: none outlives the service that ran it.
            domain::subagents::stop_runs_orphaned_by_restart(&state.write_pool).await;

            // Background dispatcher for user schedules (one poll loop for the
            // process lifetime; survives client disconnects).
            domain::schedules::scheduler::spawn(state.clone());
            domain::restart_continuations::spawn_startup_pass(state.clone());
            domain::mcp::control::message_queue::spawn(state.clone());
            domain::git::forge::spawn(state.clone());
            domain::git::linked_branches::spawn(state.clone());

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
            let backends_for_shutdown = state.plugin_tab_backends.clone();
            let write_pool_for_shutdown = state.write_pool.clone();
            let maintenance_pool = state.write_pool.clone();
            let maintenance_events = state.storage_maintenance_events_tx.clone();
            let app =
                api::build_router(state).layer(api::cors::build_cors_layer(config.frontend_port));

            info!("Cadencr service listening on {addr}");
            // Disable Nagle's algorithm on every accepted connection. Nagle is
            // the default on `tokio::net::TcpStream` and silently coalesces
            // small frames for ~200 ms, which destroys real-time WS streaming.
            let listener = listener.tap_io(|stream| {
                if let Err(err) = stream.set_nodelay(true) {
                    tracing::warn!("set_nodelay failed: {err}");
                }
            });
            // Start maintenance only after the listener is ready. The scheduler
            // adds its own delay so it cannot compete with session restore or
            // the user's first active turn.
            domain::maintenance::spawn(maintenance_pool, maintenance_events);
            // Shutdown ordering lives in `shutdown`: the signal future only
            // closes the listener, then teardown and the HTTP drain run together.
            let (drain_tx, drain_rx) = tokio::sync::oneshot::channel();
            let server = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown::stop_admitting_on_signal(drain_tx));
            shutdown::serve_then_shutdown(
                server,
                drain_rx,
                pty_manager,
                remote_for_shutdown,
                backends_for_shutdown,
                write_pool_for_shutdown,
            )
            .await?;
        }
    }

    Ok(())
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
