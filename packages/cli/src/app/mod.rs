//! User-facing commands: open CadencR, a project or a file, add a project,
//! update CadencR, and run its service headless for remote devices.
//!
//! The desktop app keeps its service token in memory, so these commands never
//! call a desktop-launched service: they hand the request to the app through
//! its command line (`launch`). Only a service started by `cadencr serve`,
//! whose token this CLI minted, is called over HTTP (`connection`).

use std::path::PathBuf;

use clap::Subcommand;

use crate::Diagnostic;

mod connection;
mod install;
mod launch;
mod project;
mod resources;
mod serve;
mod service_api;
mod service_process;
mod update;

pub(crate) const ABOUT: &str = "Open CadencR projects and files, run CadencR headless, \
update it, and package plugins";

/// The loopback port of the packaged app's service. `cadencr serve` always
/// binds the same one, so the desktop app and a headless service can never
/// both run on the production database (they would fire the same schedules
/// twice). That is why it is not configurable.
pub(crate) const SERVICE_PORT: u16 = 5004;
const REMOTE_PORT: u16 = 5006;

#[derive(Debug, Subcommand)]
pub(crate) enum AppCommand {
    /// Open CadencR on a project folder or a file of a project already added.
    Open {
        /// A project folder, a folder inside one, or a file. Defaults to opening
        /// CadencR as it was.
        path: Option<PathBuf>,
        /// Line to reveal when PATH is a file.
        #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
        line: Option<u32>,
    },
    /// Add a folder as a CadencR project, then open it.
    Add {
        /// The project folder. Defaults to the current directory.
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    /// Update CadencR to the latest release.
    Update {
        /// Only report whether a newer release is available.
        #[arg(long)]
        check: bool,
        /// Server installations: install this downloaded server archive
        /// instead of downloading the latest release.
        #[arg(long, conflicts_with = "check")]
        archive: Option<PathBuf>,
    },
    /// Run the CadencR service without the desktop app, for remote devices.
    Serve {
        /// Port remote devices connect to over HTTPS.
        #[arg(long, default_value_t = REMOTE_PORT)]
        remote_port: u16,
        /// Serve the loopback API only, and turn remote access off.
        #[arg(long)]
        no_remote: bool,
    },
    /// Print a new link to pair a device with the running `cadencr serve`.
    Pair,
}

pub(crate) fn run(command: Option<&AppCommand>, json: bool) -> Result<Option<String>, Diagnostic> {
    match command {
        None => launch::open(None, None),
        Some(AppCommand::Open { path, line }) => launch::open(path.as_deref(), *line),
        Some(AppCommand::Add { path }) => project::add(path),
        Some(AppCommand::Update { check, archive }) => update::run(*check, archive.as_deref()),
        Some(AppCommand::Serve {
            remote_port,
            no_remote,
        }) => serve::run(
            &serve::Options {
                remote_port: *remote_port,
                remote: !no_remote,
            },
            json,
        ),
        Some(AppCommand::Pair) => serve::pair(json),
    }
}

/// `pair` prints its pairing link as its JSON result, so no `{"ok":true}`
/// envelope follows it.
pub(crate) fn prints_own_json(cli: &crate::args::Cli) -> bool {
    matches!(
        cli.command,
        Some(crate::args::Command::App(AppCommand::Pair))
    )
}

/// One tokio runtime per command: the commands are short-lived, and `serve`
/// owns its runtime for the life of the service.
fn block_on<F: std::future::Future>(future: F) -> Result<F::Output, Diagnostic> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| crate::operation_error("CLI_RUNTIME_FAILED", error))?;
    Ok(runtime.block_on(future))
}

/// A command line the parser accepts but the command cannot act on; exits 2
/// like clap's own usage errors.
fn usage(message: &str) -> Diagnostic {
    Diagnostic {
        code: "CLI_USAGE_ERROR",
        message: message.to_string(),
        exit_code: 2,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Prints one line on stdout, reporting a closed pipe instead of panicking
/// like `println!` (`cadencr --json serve | head -1`, a gone journal).
fn say(line: &str) -> Result<(), Diagnostic> {
    crate::output::write_stdout(
        format!("{line}\n").as_bytes(),
        &mut std::io::stdout().lock(),
    )
}

/// Prints one JSON event on one line of stdout.
fn emit(event: &serde_json::Value) -> Result<(), Diagnostic> {
    crate::output::write_receipt(event, "CLI_OUTPUT_INVALID").map(drop)
}
