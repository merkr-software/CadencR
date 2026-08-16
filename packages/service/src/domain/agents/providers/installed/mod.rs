//! Locally installed ACP providers.
//!
//! This is the second half of the runtime registry: `registry.rs` made the
//! provider list something built at startup, and this module supplies the
//! entries that are not compiled in. An installed provider is a descriptor plus
//! a code-backed provider executable behind one [`GenericAcpAdapter`]. The host
//! stays provider-neutral, while provider authors own model discovery and any
//! native-to-ACP mapping inside that executable.
//!
//! Scope of this increment, deliberately narrow:
//!
//! - descriptors are read **once at startup** from one directory; lifecycle
//!   routes mutate durable files but activation is explicitly restart-gated;
//! - the launch target is an **explicitly selected local executable**; nothing
//!   is downloaded, extracted, or checksummed here;
//! - the executable must implement the versioned `models` and `run` commands;
//! - the runtime protocol is **ACP v1**, negotiated by the shared client.
//!
//! Three sources of truth stay separate, as the boundary plan requires: the
//! portable registry entry (`descriptor.rs`), the host-local installation
//! record (`installation.rs`), the pre-session model projection owned by the
//! provider binary, and live capabilities negotiated over ACP. Descriptors
//! never declare models or session capabilities.

pub mod adapter;
mod assets;
pub mod descriptor;
mod hooks;
pub mod installation;
pub mod lifecycle;
pub mod loader;
mod model_discovery;
pub mod rejection;
pub mod routes;
#[cfg(test)]
mod test_fixtures;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use super::registry::{ProviderAdapterHandle, RegisteredProvider};
use crate::domain::settings_store;

pub use adapter::GenericAcpAdapter;
pub use loader::InstalledLoadOutcome;

/// Scan descriptors against the complete built-in public namespace. Keeping
/// this reservation policy at one entry point prevents diagnostics, startup,
/// and lifecycle rescans from disagreeing about aliases.
fn load_descriptors(directory: &std::path::Path) -> InstalledLoadOutcome {
    loader::load_from_dir(directory, super::registry::builtin_provider_identifiers())
}

/// Where descriptors live: a `providers/` directory beside the JSON settings.
///
/// Riding the settings directory means installs follow the same
/// `--settings-dir` the desktop shell already passes (`~/.cadencr/settings` in
/// production), so a packaged build, a dev run, and a test each get their own
/// without new configuration.
pub fn descriptors_dir() -> PathBuf {
    settings_store::dir::global_dir().join("providers")
}

/// The startup scan. Run once per settings directory, on the first registry
/// lookup, and kept so the load result (including what was refused) stays
/// reportable for the life of the process.
///
/// Keyed by directory rather than cached once globally: the settings dir is
/// per-thread under `cfg(test)`, so one cache slot would let whichever test ran
/// first decide what every other test sees.
pub fn startup_load() -> Arc<InstalledLoadOutcome> {
    static SCANS: OnceLock<Mutex<HashMap<PathBuf, Arc<InstalledLoadOutcome>>>> = OnceLock::new();
    let directory = descriptors_dir();
    let mut scans = SCANS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(scanned) = scans.get(&directory) {
        return scanned.clone();
    }
    let outcome = Arc::new(load_descriptors(&directory));
    outcome.log();
    scans.insert(directory, outcome.clone());
    outcome
}

/// Registry entries for every enabled install, in scan order. Built-ins are
/// registered first, so an installed descriptor can never take an id a built-in
/// already owns.
pub fn installed_registrations() -> Vec<RegisteredProvider> {
    startup_load()
        .registrable()
        .map(|installation| {
            RegisteredProvider::new(
                installation.provider_id().to_string(),
                ProviderAdapterHandle::owned(GenericAcpAdapter::new(installation.clone())),
            )
            .installed_local()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{descriptors_dir, installed_registrations, startup_load};

    #[test]
    fn descriptors_live_beside_the_settings_files() {
        let dir = descriptors_dir();
        assert_eq!(
            dir.file_name().and_then(|name| name.to_str()),
            Some("providers")
        );
        assert_eq!(
            dir.parent(),
            Some(crate::domain::settings_store::dir::global_dir().as_path())
        );
    }

    /// A clean install has no descriptors: the scan must be a no-op rather than
    /// an error, and it must not fabricate registrations.
    #[test]
    fn an_empty_install_registers_nothing() {
        let outcome = startup_load();
        assert!(outcome.rejections.is_empty(), "{:?}", outcome.rejections);
        assert!(outcome.installations.is_empty());
        assert!(installed_registrations().is_empty());
    }
}
