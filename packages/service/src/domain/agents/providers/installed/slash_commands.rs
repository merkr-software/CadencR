//! The optional `slash-commands` provider package command, and the per-cwd
//! command catalog the `/` menu reads before (and between) live sessions.
//!
//! `<provider> slash-commands --format cadencr-slash-commands-v1 --cwd <dir>`
//! runs with `<dir>` as its working directory (like `models`) and prints the
//! commands and skills the native agent accepts there. Three outcomes:
//!
//! - a valid list: cached per directory for [`CATALOG_TTL`];
//! - a non-zero exit with a stdout `{"message"}`, or output that fails
//!   validation: an error the composer shows (never silently dropped);
//! - a non-zero exit from a signal or a panic: an error too, so a crash is
//!   never read as "unsupported";
//! - any other non-zero exit: a package without the command (older SDKs),
//!   cached as an empty listing.
//!
//! Failures are cached for [`FAILURE_TTL`], so callers queued behind a failed
//! run (or a menu reopened right away) don't spawn the package again.
//!
//! Whatever the package prints, the last ACP `available_commands_update` a
//! live session sent for that directory is kept too: entries it has that the
//! package did not list (server-side commands, or everything when the package
//! has no `slash-commands`) are appended, so community packages without the
//! command still get a pre-session menu after their first session. A live
//! update also drops the cached listing for that directory, so the next read
//! re-runs the package against the new state.
//! See `docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md#slash-commands-command`.

mod validate;

use std::collections::HashSet;
use std::convert::Infallible;
use std::ffi::OsString;
use std::path::Path;
use std::process::ExitStatus;
use std::time::Duration;

use super::command_capture::run_provider_subcommand;
use super::installation::{HostInstallation, LocalExecutable};
use super::updates::parse_message;
use super::workspace_cache::WorkspaceCache;
use crate::domain::agents::acp::runtime::slash_command_snapshots::SlashCommandSnapshots;
use crate::domain::agents::adapter::{RuntimeError, RuntimeSlashCommand};

use validate::parse_slash_commands;

pub const SLASH_COMMANDS_FORMAT: &str = "cadencr-slash-commands-v1";
const SLASH_COMMANDS_TIMEOUT: Duration = Duration::from_secs(10);
const CATALOG_TTL: Duration = Duration::from_secs(30);
const FAILURE_TTL: Duration = Duration::from_secs(5);
/// Rust's exit code for a panic.
const PANIC_EXIT_CODE: i32 = 101;

/// A package listing, or the message of its failure.
type Listing = Result<Vec<RuntimeSlashCommand>, String>;

/// Per-installation catalog: package listings plus live ACP snapshots.
#[derive(Default)]
pub struct SlashCommandCatalog {
    listings: WorkspaceCache<String, Listing>,
    live: SlashCommandSnapshots,
}

impl std::fmt::Debug for SlashCommandCatalog {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SlashCommandCatalog")
            .finish_non_exhaustive()
    }
}

impl SlashCommandCatalog {
    /// The package listing for `cwd` followed by any live-only entries.
    pub async fn commands(
        &self,
        installation: &HostInstallation,
        cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        let listed = self.listing(installation, cwd).await?;
        Ok(append_missing(listed, self.live.get(cwd).await))
    }

    /// Mirror a live `available_commands_update` and forget the listing it
    /// supersedes.
    pub async fn record_live(&self, cwd: &str, commands: Vec<RuntimeSlashCommand>) {
        self.live.record(cwd, commands).await;
        self.listings.remove(&cwd.to_string()).await;
    }

    /// Forget listings, e.g. after the connector updated itself. Live
    /// snapshots stay: they are what the agent itself advertised.
    pub async fn invalidate(&self) {
        self.listings.clear().await;
    }

    async fn listing(
        &self,
        installation: &HostInstallation,
        cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        // A relative path would be refused by the package's argument check
        // and misread as "unsupported".
        if !Path::new(cwd).is_absolute() {
            return Err(RuntimeError::new(format!(
                "slash commands need an absolute working directory, got {cwd:?}"
            )));
        }
        let executable = installation.launchable().map_err(RuntimeError::new)?;
        let listing = self
            .listings
            .get_or_refresh(&cwd.to_string(), || async {
                let listing = discover(executable, cwd)
                    .await
                    .map(Option::unwrap_or_default)
                    .map_err(|error| error.to_string());
                let ttl = if listing.is_ok() {
                    CATALOG_TTL
                } else {
                    FAILURE_TTL
                };
                Ok::<_, Infallible>((listing, ttl))
            })
            .await
            .unwrap_or_else(|never| match never {});
        listing.map_err(RuntimeError::new)
    }
}

/// `Ok(None)`: the package has no `slash-commands` command.
async fn discover(
    executable: &LocalExecutable,
    cwd: &str,
) -> Result<Option<Vec<RuntimeSlashCommand>>, RuntimeError> {
    let args = [
        OsString::from("slash-commands"),
        OsString::from("--format"),
        OsString::from(SLASH_COMMANDS_FORMAT),
        OsString::from("--cwd"),
        OsString::from(cwd),
    ];
    let output = run_provider_subcommand(executable, &args, Path::new(cwd), SLASH_COMMANDS_TIMEOUT)
        .await
        .map_err(|error| RuntimeError::new(format!("provider `slash-commands` command {error}")))?;
    if !output.status.success() {
        // A package reports its own failure as stdout `{"message"}`; any other
        // non-zero exit predates the command. Stderr may hold credentials.
        return match parse_message(&output.stdout) {
            Some(message) => Err(RuntimeError::new(format!(
                "provider `slash-commands` command failed: {message}"
            ))),
            None if crashed(output.status) => Err(RuntimeError::new(format!(
                "provider `slash-commands` command crashed ({})",
                output.status
            ))),
            None => Ok(None),
        };
    }
    parse_slash_commands(&output.stdout)
        .map(Some)
        .map_err(|reason| {
            RuntimeError::new(format!(
                "provider `slash-commands` output was rejected: {reason}"
            ))
        })
}

/// Killed by a signal, or a Rust panic: not the "unsupported" answer.
fn crashed(status: ExitStatus) -> bool {
    status.code().is_none_or(|code| code == PANIC_EXIT_CODE)
}

fn append_missing(
    mut commands: Vec<RuntimeSlashCommand>,
    extra: Vec<RuntimeSlashCommand>,
) -> Vec<RuntimeSlashCommand> {
    let mut names: HashSet<String> = commands.iter().map(|c| c.name.clone()).collect();
    commands.extend(
        extra
            .into_iter()
            .filter(|command| names.insert(command.name.clone())),
    );
    commands
}

#[cfg(test)]
mod tests {
    use super::SlashCommandCatalog;
    use crate::domain::agents::adapter::{RuntimeSlashCommand, RuntimeSlashCommandKind};
    use crate::domain::agents::providers::installed::installation::HostInstallation;
    use crate::domain::agents::providers::installed::test_fixtures::{
        descriptor, descriptor_json, write_script,
    };
    use std::path::Path;

    fn installation(dir: &Path, body: &str) -> HostInstallation {
        let command = write_script(dir, "provider.sh", &format!("#!/bin/sh\n{body}\n"));
        HostInstallation::from_descriptor(
            descriptor(descriptor_json("slash", &command.to_string_lossy())),
            Path::new("/p/slash.json"),
        )
        .expect("valid descriptor")
    }

    fn live(name: &str) -> RuntimeSlashCommand {
        RuntimeSlashCommand {
            name: name.to_string(),
            description: None,
            kind: RuntimeSlashCommandKind::Command,
        }
    }

    fn names(commands: &[RuntimeSlashCommand]) -> Vec<&str> {
        commands.iter().map(|c| c.name.as_str()).collect()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn listings_run_in_the_cwd_are_cached_until_a_live_update() {
        let dir = tempfile::tempdir().unwrap();
        let runs = dir.path().join("runs");
        let installation = installation(
            dir.path(),
            &format!(
                "pwd >> '{}'\necho '[{{\"name\":\"review\",\"kind\":\"skill\"}}]'",
                runs.display()
            ),
        );
        let cwd = dir.path().canonicalize().unwrap();
        let cwd = cwd.to_str().unwrap();
        let catalog = SlashCommandCatalog::default();
        let listed = catalog.commands(&installation, cwd).await.unwrap();
        assert_eq!(names(&listed), ["review"]);
        assert_eq!(listed[0].kind, RuntimeSlashCommandKind::Skill);
        catalog.commands(&installation, cwd).await.unwrap();
        let run_count = || std::fs::read_to_string(&runs).unwrap().lines().count();
        assert_eq!(run_count(), 1);
        assert_eq!(std::fs::read_to_string(&runs).unwrap().trim(), cwd);

        catalog
            .record_live(cwd, vec![live("review"), live("server-only")])
            .await;
        let merged = catalog.commands(&installation, cwd).await.unwrap();
        assert_eq!(names(&merged), ["review", "server-only"]);
        assert_eq!(merged[0].kind, RuntimeSlashCommandKind::Skill);
        assert_eq!(run_count(), 2);
        catalog.invalidate().await;
        catalog.commands(&installation, cwd).await.unwrap();
        assert_eq!(run_count(), 3);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn older_packages_fall_back_to_the_live_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let runs = dir.path().join("runs");
        let installation = installation(
            dir.path(),
            &format!(
                "echo run >> '{}'\necho 'unknown command' >&2\nexit 1",
                runs.display()
            ),
        );
        let catalog = SlashCommandCatalog::default();
        assert!(catalog
            .commands(&installation, "/tmp")
            .await
            .unwrap()
            .is_empty());
        catalog.record_live("/tmp", vec![live("compress")]).await;
        let snapshot = catalog.commands(&installation, "/tmp").await.unwrap();
        assert_eq!(names(&snapshot), ["compress"]);
        // Unsupported is cached like a listing: the live update re-ran it.
        assert_eq!(std::fs::read_to_string(&runs).unwrap().lines().count(), 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failures_and_invalid_output_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let failing = installation(
            dir.path(),
            "echo '{\"message\":\"config unreadable\"}'\nexit 1",
        );
        let error = SlashCommandCatalog::default()
            .commands(&failing, "/tmp")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("config unreadable"), "{error}");

        let other = tempfile::tempdir().unwrap();
        let invalid = installation(other.path(), "echo '[{\"name\":\"/bad\"}]'");
        let error = SlashCommandCatalog::default()
            .commands(&invalid, "/tmp")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("rejected"), "{error}");

        // A crash is an error, not "unsupported", and failures are cached
        // briefly: queued callers don't re-run the package.
        let crashing_dir = tempfile::tempdir().unwrap();
        let runs = crashing_dir.path().join("runs");
        let crashing = installation(
            crashing_dir.path(),
            &format!("echo run >> '{}'\nkill -KILL $$", runs.display()),
        );
        let catalog = SlashCommandCatalog::default();
        for _ in 0..2 {
            let error = catalog.commands(&crashing, "/tmp").await.unwrap_err();
            assert!(error.to_string().contains("crashed"), "{error}");
        }
        assert_eq!(std::fs::read_to_string(&runs).unwrap().lines().count(), 1);
    }
}
