//! `cadencr registry pack-tab-backend` and the custom-tab revocation feed
//! (`sign-tab-blocklist`, `verify-tab-blocklist`).
use std::path::{Path, PathBuf};

use cadencr_plugin_core::tab::TabPlatform;
use cadencr_registry_core::PolicyKind;
use clap::Subcommand;

use crate::signing::{sign_blocklist, verify_blocklist};
use crate::{operation_error, output, Diagnostic};

#[derive(Debug, Subcommand)]
pub(crate) enum TabBackendCommand {
    /// Pack one platform's native tab backend executable (named by tab.json
    /// `backend.binary.<target>`) into its own deterministic archive.
    PackTabBackend {
        /// The tab folder holding tab.json and the built executable.
        #[arg(long)]
        directory: PathBuf,
        /// darwin-aarch64, darwin-x86_64 or linux-x86_64.
        #[arg(long, value_parser = tab_platform)]
        target: TabPlatform,
        /// A new .tar.gz outside the tab folder.
        #[arg(long)]
        output: PathBuf,
    },
    /// Sign a domain-bound custom tab revocation policy (kind: tab-blocklist).
    SignTabBlocklist {
        #[arg(long)]
        payload: PathBuf,
        #[arg(long)]
        private_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        output: PathBuf,
    },
    /// Verify a domain-bound signed custom tab revocation policy.
    VerifyTabBlocklist {
        #[arg(long)]
        index: PathBuf,
        #[arg(long)]
        public_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        allow_expired: bool,
    },
}

pub(crate) fn run(command: &TabBackendCommand) -> Result<Option<String>, Diagnostic> {
    match command {
        TabBackendCommand::PackTabBackend {
            directory,
            target,
            output,
        } => pack(directory, *target, output),
        TabBackendCommand::SignTabBlocklist {
            payload,
            private_key,
            key_id,
            output,
        } => sign_blocklist(PolicyKind::Tab, payload, private_key, key_id, output),
        TabBackendCommand::VerifyTabBlocklist {
            index,
            public_key,
            key_id,
            allow_expired,
        } => verify_blocklist(PolicyKind::Tab, index, public_key, key_id, *allow_expired),
    }
}

fn tab_platform(value: &str) -> Result<TabPlatform, String> {
    TabPlatform::parse(value).ok_or_else(|| {
        format!(
            "`{value}` is not a tab backend platform; use {}",
            TabPlatform::list()
        )
    })
}

/// Prints `{"kind":"tab-backend", target, archive, sha256, size, cmd,
/// executable_sha256, executable_size}`: the values of
/// `tab.distribution.binary.<target>` (plus its release URL).
fn pack(
    directory: &Path,
    target: TabPlatform,
    destination: &Path,
) -> Result<Option<String>, Diagnostic> {
    let packed = cadencr_registry_core::pack_tab_backend(
        cadencr_registry_core::PackTabBackendRequest::builder()
            .directory(directory)
            .target(target)
            .output(destination)
            .build(),
    )
    .map_err(|error| operation_error("TAB_BACKEND_PACKAGING_FAILED", error))?;
    output::write_receipt(
        &serde_json::json!({
            "kind": "tab-backend",
            "target": packed.target,
            "archive": packed.archive,
            "sha256": packed.sha256,
            "size": packed.size,
            "cmd": packed.cmd,
            "executable_sha256": packed.executable_sha256,
            "executable_size": packed.executable_size,
        }),
        "TAB_BACKEND_PACKAGING_FAILED",
    )
}
