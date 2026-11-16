use std::io::{self, Write as _};
use std::path::PathBuf;

use clap::Subcommand;
use serde_json::json;

use crate::{operation_error, Diagnostic};

#[derive(Debug, Subcommand)]
pub(crate) enum MetadataCommand {
    /// Validate local package/catalog shapes only; signed metadata is NOT authenticated.
    ValidateMetadata {
        #[arg(required = true, num_args = 1..=32)]
        files: Vec<PathBuf>,
    },
    /// Validate local submission documents without executing contributor code.
    ValidateSubmission {
        #[arg(required = true, num_args = 1..=32)]
        files: Vec<PathBuf>,
    },
    /// Report UNAUTHENTICATED expiry scheduling diagnostics; not publication authority.
    CheckMetadataExpiry {
        #[arg(required = true, num_args = 1..=3)]
        files: Vec<PathBuf>,
        #[arg(long, default_value_t = 72, value_parser = clap::value_parser!(u16).range(1..=336))]
        warning_hours: u16,
    },
}

pub(crate) fn run(command: &MetadataCommand) -> Result<Option<String>, Diagnostic> {
    match command {
        MetadataCommand::ValidateMetadata { files } => {
            for file in files {
                cadencr_registry_core::validate_metadata_file(file)
                    .map_err(|error| operation_error("REGISTRY_VALIDATION_FAILED", error))?;
            }
            Ok(Some("valid metadata shapes (not authenticated)".into()))
        }
        MetadataCommand::ValidateSubmission { files } => {
            for file in files {
                cadencr_registry_core::validate_submission_file(file)
                    .map_err(|error| operation_error("REGISTRY_VALIDATION_FAILED", error))?;
            }
            Ok(Some("valid submissions".into()))
        }
        MetadataCommand::CheckMetadataExpiry {
            files,
            warning_hours,
        } => {
            let results = files
                .iter()
                .map(|path| {
                    cadencr_registry_core::check_metadata_expiry()
                        .path(path)
                        .warning_hours(*warning_hours)
                        .call()
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| operation_error("METADATA_EXPIRY_CHECK_FAILED", error))?;
            let unhealthy = results.iter().any(|result| result["status"] != "healthy");
            let report = json!({"diagnostic_only":true,"results":results}).to_string();
            writeln!(io::stdout().lock(), "{report}")
                .map_err(|error| operation_error("OUTPUT_FAILED", error))?;
            if unhealthy {
                Err(operation_error(
                    "METADATA_RENEWAL_DUE",
                    "metadata expired or renewal due; diagnostic only, not authenticated",
                ))
            } else {
                Ok(None)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::args::Cli;
    use clap::Parser as _;

    #[test]
    fn parses_standalone_diagnostics_and_enforces_argument_bounds() {
        for command in [
            "validate-metadata",
            "validate-submission",
            "check-metadata-expiry",
        ] {
            assert!(Cli::try_parse_from(["cadencr", "registry", command, "file.json"]).is_ok());
            assert!(Cli::try_parse_from(["cadencr", "registry", command]).is_err());
        }
        assert!(Cli::try_parse_from([
            "cadencr",
            "registry",
            "check-metadata-expiry",
            "a",
            "b",
            "c",
            "d"
        ])
        .is_err());
        for hours in ["0", "337"] {
            assert!(Cli::try_parse_from([
                "cadencr",
                "registry",
                "check-metadata-expiry",
                "a",
                "--warning-hours",
                hours
            ])
            .is_err());
        }
        let cli = Cli::try_parse_from([
            "cadencr",
            "--json",
            "registry",
            "check-metadata-expiry",
            "a",
        ])
        .unwrap();
        assert!(cli.writes_index_to_stdout());
    }
}
