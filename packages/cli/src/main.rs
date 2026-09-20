use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::error::ErrorKind;
use clap::{Args, Parser, Subcommand};
use serde_json::json;

#[derive(Debug, Parser)]
#[command(name = "cadencr", version, about = "Offline Cadencr package tooling")]
struct Cli {
    /// Emit one JSON diagnostic object instead of human-readable output.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate local provider structure without installing or executing it.
    Plugin(PluginArgs),
    /// Validate or index a local package registry.
    Registry(RegistryArgs),
}

#[derive(Debug, Args)]
struct PluginArgs {
    #[command(subcommand)]
    command: PluginCommand,
}

#[derive(Debug, Subcommand)]
enum PluginCommand {
    /// Validate a provider plugin folder against an explicit descriptor.
    Validate {
        /// Provider workspace containing the existing bin/provider entrypoint.
        folder: PathBuf,
        /// Temporary explicit host descriptor input; never discovered from user state.
        #[arg(long)]
        descriptor: PathBuf,
    },
}

#[derive(Debug, Args)]
struct RegistryArgs {
    #[command(subcommand)]
    command: RegistryCommand,
}

#[derive(Debug, Subcommand)]
enum RegistryCommand {
    /// Validate a candidate contribution relative to a base registry.
    Validate {
        #[arg(long)]
        base: PathBuf,
        #[arg(long)]
        candidate: PathBuf,
    },
    /// Build a deterministic, unsigned index from local packages.
    BuildIndex {
        #[arg(long)]
        packages: PathBuf,
        #[arg(long)]
        generated_at: String,
        #[arg(long)]
        expires_at: String,
        /// Write to a new file instead of stdout. Existing paths are refused.
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Build a deterministic provider archive from a prepared staging tree.
    PackProvider {
        #[arg(long)]
        package: PathBuf,
        #[arg(long)]
        target: String,
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    /// Build a deterministic local publication plan without network access.
    PlanPublication {
        #[arg(long)]
        submission: PathBuf,
        #[arg(long)]
        repository: String,
        #[arg(long)]
        output: PathBuf,
    },
}

struct Diagnostic {
    code: &'static str,
    message: String,
    exit_code: u8,
}

fn main() -> ExitCode {
    let args = std::env::args_os().collect::<Vec<_>>();
    let json_requested = args.iter().any(|argument| argument == "--json");
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(error) => return report_parse_error(error, json_requested),
    };
    match run(&cli) {
        Ok(message) => {
            if cli.json && !writes_index_to_stdout(&cli) {
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

fn writes_index_to_stdout(cli: &Cli) -> bool {
    matches!(
        &cli.command,
        Command::Registry(RegistryArgs {
            command: RegistryCommand::BuildIndex { output: None, .. }
        }) | Command::Registry(RegistryArgs {
            command: RegistryCommand::PackProvider { .. }
        })
    )
}

fn run(cli: &Cli) -> Result<Option<String>, Diagnostic> {
    match &cli.command {
        Command::Plugin(PluginArgs {
            command: PluginCommand::Validate { folder, descriptor },
        }) => validate_plugin(folder, descriptor),
        Command::Registry(RegistryArgs {
            command: RegistryCommand::Validate { base, candidate },
        }) => cadencr_registry_core::validate_contribution(base, candidate)
            .map(|()| {
                Some(format!(
                    "valid registry contribution: {}",
                    candidate.display()
                ))
            })
            .map_err(|error| operation_error("REGISTRY_VALIDATION_FAILED", error)),
        Command::Registry(RegistryArgs {
            command:
                RegistryCommand::BuildIndex {
                    packages,
                    generated_at,
                    expires_at,
                    output,
                },
        }) => {
            let bytes = cadencr_registry_core::build_index()
                .packages_dir(packages)
                .generated_at(generated_at)
                .expires_at(expires_at)
                .call()
                .map_err(|error| operation_error("REGISTRY_INDEX_FAILED", error))?;
            write_index(&bytes, output.as_deref())?;
            Ok(output
                .as_ref()
                .map(|path| format!("wrote registry index: {}", path.display())))
        }
        Command::Registry(RegistryArgs {
            command:
                RegistryCommand::PackProvider {
                    package,
                    target,
                    directory,
                    output,
                },
        }) => {
            let packed = cadencr_registry_core::pack_provider(
                cadencr_registry_core::PackProviderRequest::builder()
                    .package(package)
                    .target(target)
                    .directory(directory)
                    .output(output)
                    .build(),
            )
            .map_err(|error| operation_error("REGISTRY_PACKAGING_FAILED", error))?;
            let mut receipt = serde_json::to_vec(&json!({
                "target": packed.target,
                "archive": packed.archive,
                "sha256": packed.sha256,
                "size": packed.size,
            }))
            .map_err(|error| operation_error("REGISTRY_PACKAGING_FAILED", error))?;
            receipt.push(b'\n');
            write_index_to_stdout(&receipt, &mut io::stdout().lock())?;
            Ok(None)
        }
        Command::Registry(RegistryArgs {
            command:
                RegistryCommand::PlanPublication {
                    submission,
                    repository,
                    output,
                },
        }) => {
            let plan =
                cadencr_registry_core::create_publication_plan_from_file(submission, repository)
                    .map_err(|error| operation_error("PUBLICATION_PLAN_FAILED", error))?;
            let mut bytes = serde_json::to_vec_pretty(&plan)
                .map_err(|error| operation_error("PUBLICATION_PLAN_FAILED", error))?;
            bytes.push(b'\n');
            publish_index(output, |temporary| {
                temporary.write_all(&bytes)?;
                temporary.flush()
            })?;
            Ok(Some(format!("publication plan: {}", output.display())))
        }
    }
}

fn validate_plugin(folder: &Path, descriptor: &Path) -> Result<Option<String>, Diagnostic> {
    cadencr_plugin_core::validate_plugin_folder(folder, descriptor)
        .map(|_| {
            Some(format!(
                "valid local provider structure: {} (publication completeness and theme assets not checked)",
                folder.display()
            ))
        })
        .map_err(|error| Diagnostic {
            code: error.code(),
            message: error.to_string(),
            exit_code: 1,
        })
}

fn write_index(bytes: &[u8], output: Option<&Path>) -> Result<(), Diagnostic> {
    match output {
        Some(path) => publish_index(path, |temporary| {
            temporary.write_all(bytes)?;
            temporary.flush()
        }),
        None => write_index_to_stdout(bytes, &mut io::stdout().lock()),
    }
}

fn write_index_to_stdout(bytes: &[u8], output: &mut impl Write) -> Result<(), Diagnostic> {
    output
        .write_all(bytes)
        .and_then(|()| output.flush())
        .map_err(|error| Diagnostic {
            code: "OUTPUT_WRITE_FAILED",
            message: format!("failed to write index to stdout: {error}"),
            exit_code: 3,
        })
}

fn publish_index(
    path: &Path,
    write_complete: impl FnOnce(&mut tempfile::NamedTempFile) -> io::Result<()>,
) -> Result<(), Diagnostic> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| output_error(path, error))?;
    write_complete(&mut temporary).map_err(|error| output_error(path, error))?;
    temporary
        .persist_noclobber(path)
        .map(|_| ())
        .map_err(|error| output_error(path, error.error))
}

fn operation_error(code: &'static str, error: impl std::fmt::Display) -> Diagnostic {
    Diagnostic {
        code,
        message: error.to_string(),
        exit_code: 1,
    }
}

fn output_error(path: &Path, error: io::Error) -> Diagnostic {
    Diagnostic {
        code: "OUTPUT_WRITE_FAILED",
        message: format!("failed to create {}: {error}", path.display()),
        exit_code: 3,
    }
}

#[cfg(test)]
mod tests {
    use super::{publish_index, write_index_to_stdout};
    use std::io::{self, Write};

    #[test]
    fn failed_write_removes_temporary_and_never_publishes_partial_output() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let output = directory.path().join("index.json");

        let error = publish_index(&output, |temporary| {
            temporary.write_all(b"partial")?;
            Err(io::Error::new(io::ErrorKind::WriteZero, "injected failure"))
        })
        .expect_err("injected write failure must fail publication");

        assert_eq!(error.code, "OUTPUT_WRITE_FAILED");
        assert!(!output.exists());
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("read output directory")
                .count(),
            0,
            "temporary output must be cleaned up"
        );
    }

    #[test]
    fn stdout_flush_failure_is_reported_as_an_output_error() {
        struct FlushFails(Vec<u8>);

        impl Write for FlushFails {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed stdout"))
            }
        }

        let mut output = FlushFails(Vec::new());
        let error = write_index_to_stdout(b"complete bytes", &mut output)
            .expect_err("flush failure must fail the command");
        assert_eq!(output.0, b"complete bytes");
        assert_eq!(error.code, "OUTPUT_WRITE_FAILED");
        assert!(error.message.contains("closed stdout"));
    }
}
