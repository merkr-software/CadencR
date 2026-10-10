use std::process::ExitCode;

use clap::error::ErrorKind;
use clap::Parser as _;
use serde_json::json;

mod args;
mod commands;
mod output;
mod pipeline;
mod publication;
mod signing;

use args::Cli;

pub(crate) struct Diagnostic {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) exit_code: u8,
}

fn main() -> ExitCode {
    let args = std::env::args_os().collect::<Vec<_>>();
    let json_requested = args.iter().any(|argument| argument == "--json");
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error) => return report_parse_error(error, json_requested),
    };
    match commands::run(&cli) {
        Ok(message) => {
            if cli.json && !cli.writes_index_to_stdout() {
                println!(
                    "{}",
                    json!({ "ok": true, "code": "OK", "message": message })
                );
            } else if let Some(message) = message {
                println!("{message}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            if cli.json {
                eprintln!(
                    "{}",
                    json!({ "ok": false, "code": error.code, "message": error.message })
                );
            } else {
                eprintln!("error[{}]: {}", error.code, error.message);
            }
            ExitCode::from(error.exit_code)
        }
    }
}

fn report_parse_error(error: clap::Error, json_requested: bool) -> ExitCode {
    let exit_code = error.exit_code();
    if json_requested
        && !matches!(
            error.kind(),
            ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
        )
    {
        eprintln!(
            "{}",
            json!({ "ok": false, "code": "CLI_USAGE_ERROR", "message": error.to_string() })
        );
    } else if let Err(print_error) = error.print() {
        eprintln!("failed to print command output: {print_error}");
    }
    ExitCode::from(u8::try_from(exit_code).unwrap_or(2))
}

pub(crate) fn operation_error(code: &'static str, error: impl std::fmt::Display) -> Diagnostic {
    Diagnostic {
        code,
        message: error.to_string(),
        exit_code: 1,
    }
}
