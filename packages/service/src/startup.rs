//! Server-mode startup, in the order it has to happen. `main` only parses the
//! command line and picks a mode; each step lives in its own submodule.
//!
//! 1. Hold the database lock and probe the port before any slow work
//!    ([`run_server`]).
//! 2. Open and migrate the database ([`database`]).
//! 3. Bind the settings directory before anything reads settings
//!    ([`settings`]).
//! 4. Recover work the previous process left mid-flight ([`recovery`]).
//! 5. Build the shared state, start watchers and background tasks
//!    ([`background`]).
//! 6. Bind the listener last and serve until shutdown ([`serve`]).

mod background;
mod database;
mod recovery;
mod serve;
mod settings;

use std::path::{Path, PathBuf};

use tracing::info;

use crate::app_state::AppState;
use crate::config::Config;
use crate::{dev_env, domain, remote, shared, shutdown, startup_lock};

/// Run the HTTP/WS service until it is asked to stop.
pub async fn run_server(
    config: Config,
    dotenv_path: Option<PathBuf>,
    parent_watch: Option<shutdown::ParentWatch>,
) -> anyhow::Result<()> {
    report_dev_env(dotenv_path)?;

    let db_path = config
        .db_path
        .clone()
        .expect("--db-path or CADENCR_DB_PATH env var required");
    // Before login_env, migrations or VACUUM: a second instance on the same
    // database fails here instead of racing this one's startup.
    let db_lock = startup_lock::acquire_db_lock(Path::new(&db_path))?;
    // Probe the port before slow startup work, then drop so `/api/health` gets
    // ECONNREFUSED until ready: the real listener is bound in `serve`.
    let addr = format!("127.0.0.1:{}", config.port);
    drop(serve::bind_listener(&addr).await?);

    let pools = database::prepare(&config, &db_path).await?;
    let settings_dir = settings::prepare(&config, &db_path, &pools).await?;
    recovery::recover_interrupted_work(&pools.write, config.app_version.as_deref()).await?;

    let state = build_state(&config, pools, db_path)?;
    // Stale `running` rows were reset above; restore the status book
    // every client reads before any of them can connect.
    domain::session_status::restore_at_boot(&state).await?;
    background::start_watchers(&state, &settings_dir);
    background::spawn_background_work(&state).await?;
    remote::restore_at_startup(&state, config.skip_remote_restore).await;

    serve::serve(state, &config, &addr, parent_watch).await?;
    drop(db_lock);
    Ok(())
}

/// Run the MCP stdio server an agent CLI spawned for one session.
pub async fn run_mcp_serve(
    config: &Config,
    agent_type: &str,
    feature_id: i64,
    session_id: Option<i64>,
) -> anyhow::Result<()> {
    let db_path = config
        .db_path
        .clone()
        .expect("--db-path or CADENCR_DB_PATH env var required for mcp-serve");
    let settings_dir =
        domain::settings_store::dir::resolve_from_config(config.settings_dir.as_deref(), &db_path);
    domain::settings_store::dir::secure(&settings_dir)?;
    domain::settings_store::init(settings_dir);
    domain::agents::providers::installed::managed::trust::initialize_pinned_registry_trust()
        .await?;
    domain::mcp::stdio::run_mcp_stdio(&db_path, agent_type, feature_id, session_id).await
}

/// Debug builds require the dev `.env` and its keys. Release builds never
/// load it (`main` passes `None`), so the second branch only guards a future
/// caller that does.
fn report_dev_env(dotenv_path: Option<PathBuf>) -> anyhow::Result<()> {
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
    Ok(())
}

fn build_state(
    config: &Config,
    pools: database::Pools,
    db_path: String,
) -> anyhow::Result<AppState> {
    let auth_token = config.auth_token.clone().ok_or_else(|| {
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
        .read_pool(pools.read)
        .write_pool(pools.write)
        .db_path(db_path)
        .auth_token(auth_token)
        .frontend_port(config.frontend_port)
        .port(config.port)
        .remote(remote_controller)
        .remote_data_dir(&remote_data_dir)
        .build();
    // AppState now owns the Browser bridge credentials too (read from
    // the env at construction): no child may inherit them.
    shared::security::remove_service_only_env();
    Ok(state)
}
