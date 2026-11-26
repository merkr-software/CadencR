//! Thin binary entry point. Every module lives in the `cadencr_service` lib so
//! the crate compiles (and its unit tests run) once; declaring them again here
//! with `mod` would build a second full copy of the service.
#![deny(clippy::let_underscore_must_use, clippy::unused_result_ok)] // as in lib.rs

use std::path::Path;

use cadencr_service::{config, dev_env, domain, shutdown, startup};

use clap::Parser;

use config::{Command, Config};

fn main() -> anyhow::Result<()> {
    if let Some(result) = cli_discovery::process_session_entrypoint() {
        return result.map_err(Into::into);
    }
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() == Some(std::ffi::OsStr::new("--internal-desktop-quit-cleanup")) {
        let (Some(database), Some(epoch), None) = (args.next(), args.next(), args.next()) else {
            anyhow::bail!("expected a database path and a desktop quit epoch");
        };
        let epoch = epoch
            .into_string()
            .map_err(|_| anyhow::anyhow!("invalid desktop quit epoch"))?
            .parse()?;
        return run_quit_cleanup(Path::new(&database), epoch);
    }
    run_service()
}

#[tokio::main(flavor = "current_thread")]
async fn run_quit_cleanup(database: &Path, epoch: uuid::Uuid) -> anyhow::Result<()> {
    startup::run_desktop_quit_cleanup(database, epoch).await
}

#[tokio::main]
async fn run_service() -> anyhow::Result<()> {
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
    // Before anything can spawn a child: the watch also hands fd 0 back to
    // `/dev/null`, so children never inherit the shell's open pipe.
    let parent_watch = (!is_mcp && config.exit_with_parent).then(shutdown::watch_parent);

    match &config.command {
        Some(Command::McpServe {
            agent_type,
            feature_id,
            session_id,
        }) => {
            startup::run_mcp_serve(&config, agent_type, *feature_id, *session_id).await?;
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
        None => startup::run_server(config, dotenv_path, parent_watch).await?,
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
