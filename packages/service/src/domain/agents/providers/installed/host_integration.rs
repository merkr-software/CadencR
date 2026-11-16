//! The optional `host-integration` provider package command.
//!
//! `<provider> host-integration --format cadencr-host-integration-v1` prints
//! one JSON object declaring host conventions the provider wants: a compaction
//! slash command, project config paths copied into new worktrees, and a
//! resume-in-terminal command. It runs once per installation for the life of
//! the process (refreshed after a connector update) through the same bounded
//! subprocess helper as `models`. A package that predates the command exits
//! non-zero, which simply means "no host integration". Either outcome other
//! than a valid declaration is recorded as a diagnostic on
//! `GET /api/agents/installed-providers`, never silently dropped.
//! See `docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md#host-integration-command`.

mod validate;

use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use super::command_capture::run_provider_subcommand;
use super::installation::HostInstallation;

pub use validate::{parse_host_integration, HostIntegration, SESSION_ID_PLACEHOLDER};

pub const HOST_INTEGRATION_FORMAT: &str = "cadencr-host-integration-v1";
const HOST_INTEGRATION_TIMEOUT: Duration = Duration::from_secs(10);

/// Per-installation, process-lifetime cache of the declared integration.
#[derive(Debug)]
pub struct HostIntegrationCache {
    provider_id: String,
    loaded: RwLock<Option<Arc<HostIntegration>>>,
    load: tokio::sync::Mutex<()>,
}

impl HostIntegrationCache {
    pub fn new(provider_id: &str) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            loaded: RwLock::new(None),
            load: tokio::sync::Mutex::new(()),
        }
    }

    /// The integration as last loaded; empty until the first load finished.
    pub fn current(&self) -> Arc<HostIntegration> {
        self.loaded
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .unwrap_or_default()
    }

    /// Load once; later calls return the cached result. A quarantined
    /// installation has nothing to run and declares nothing.
    pub async fn ensure_loaded(&self, installation: &HostInstallation) -> Arc<HostIntegration> {
        if let Some(loaded) = self.loaded_value() {
            return loaded;
        }
        let _load = self.load.lock().await;
        if let Some(loaded) = self.loaded_value() {
            return loaded;
        }
        let (integration, diagnostic) = match installation.launchable() {
            Ok(executable) => discover(executable).await,
            Err(_) => (HostIntegration::default(), None),
        };
        record_diagnostic(&self.provider_id, diagnostic);
        let integration = Arc::new(integration);
        *self
            .loaded
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(integration.clone());
        integration
    }

    /// Forget the cached declaration, e.g. after the connector updated itself.
    pub fn invalidate(&self) {
        *self
            .loaded
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    fn loaded_value(&self) -> Option<Arc<HostIntegration>> {
        self.loaded
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

async fn discover(
    executable: &super::installation::LocalExecutable,
) -> (HostIntegration, Option<String>) {
    let args = [
        OsString::from("host-integration"),
        OsString::from("--format"),
        OsString::from(HOST_INTEGRATION_FORMAT),
    ];
    let cwd = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    let output =
        match run_provider_subcommand(executable, &args, &cwd, HOST_INTEGRATION_TIMEOUT).await {
            Ok(output) => output,
            Err(error) => {
                return (
                    HostIntegration::default(),
                    Some(format!("provider `host-integration` command {error}")),
                )
            }
        };
    if !output.status.success() {
        // Stderr can contain credentials; only its size is reported.
        return (
            HostIntegration::default(),
            Some(format!(
                "provider has no `host-integration` command (exited with {}, {} diagnostic \
                 bytes); compaction, worktree config copying and resume-in-terminal are off",
                output.status,
                output.stderr.len()
            )),
        );
    }
    match parse_host_integration(&output.stdout) {
        Ok(integration) => (integration, None),
        Err(reason) => (
            HostIntegration::default(),
            Some(format!(
                "provider `host-integration` output was rejected: {reason}"
            )),
        ),
    }
}

fn diagnostics() -> &'static Mutex<HashMap<String, String>> {
    static DIAGNOSTICS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    DIAGNOSTICS.get_or_init(Mutex::default)
}

fn record_diagnostic(provider_id: &str, diagnostic: Option<String>) {
    let mut diagnostics = diagnostics()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match diagnostic {
        Some(message) => {
            tracing::warn!(provider_id, %message, "installed provider host integration");
            diagnostics.insert(provider_id.to_string(), message);
        }
        None => {
            diagnostics.remove(provider_id);
        }
    }
}

/// Why this process applies no (or only part of a) host integration for
/// `provider_id`, when it tried and could not.
pub fn host_integration_diagnostic(provider_id: &str) -> Option<String> {
    diagnostics()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(provider_id)
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::{host_integration_diagnostic, HostIntegrationCache};
    use crate::domain::agents::providers::installed::installation::HostInstallation;
    use crate::domain::agents::providers::installed::test_fixtures::{
        descriptor, descriptor_json, write_script,
    };
    use std::path::Path;

    #[cfg(unix)]
    fn script(dir: &Path, body: &str) -> String {
        write_script(dir, "provider.sh", &format!("#!/bin/sh\n{body}\n"))
            .to_string_lossy()
            .into_owned()
    }

    fn installation(id: &str, command: &str) -> HostInstallation {
        HostInstallation::from_descriptor(
            descriptor(descriptor_json(id, command)),
            Path::new(&format!("/p/{id}.json")),
        )
        .expect("valid descriptor")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn valid_output_is_cached_and_clears_the_diagnostic() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("runs");
        let command = script(
            dir.path(),
            &format!(
                "echo run >> '{}'\necho '{{\"compactCommand\":\"compress\"}}'",
                counter.display()
            ),
        );
        let cache = HostIntegrationCache::new("hi-valid");
        let installation = installation("hi-valid", &command);
        assert!(cache.current().compact_command.is_none());
        let loaded = cache.ensure_loaded(&installation).await;
        assert_eq!(loaded.compact_command.as_deref(), Some("compress"));
        cache.ensure_loaded(&installation).await;
        assert_eq!(
            std::fs::read_to_string(&counter).unwrap().lines().count(),
            1
        );
        assert!(host_integration_diagnostic("hi-valid").is_none());
        cache.invalidate();
        cache.ensure_loaded(&installation).await;
        assert_eq!(
            std::fs::read_to_string(&counter).unwrap().lines().count(),
            2
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_output_and_older_packages_record_diagnostics() {
        let dir = tempfile::tempdir().unwrap();
        let invalid = script(dir.path(), "echo '{\"compactCommand\":\"/bad\"}'");
        let cache = HostIntegrationCache::new("hi-invalid");
        let loaded = cache
            .ensure_loaded(&installation("hi-invalid", &invalid))
            .await;
        assert!(loaded.compact_command.is_none());
        assert!(host_integration_diagnostic("hi-invalid")
            .is_some_and(|message| message.contains("rejected")));

        let older = tempfile::tempdir().unwrap();
        let exits = script(older.path(), "exit 2");
        let cache = HostIntegrationCache::new("hi-older");
        let loaded = cache.ensure_loaded(&installation("hi-older", &exits)).await;
        assert_eq!(*loaded, super::HostIntegration::default());
        assert!(host_integration_diagnostic("hi-older")
            .is_some_and(|message| message.contains("no `host-integration` command")));
    }
}
