//! The signed revocation policies (provider, theme; custom tabs live beside
//! their backend commands): signing, verification, automatic renewal and
//! publication to the discovery branch.
use std::path::{Path, PathBuf};

use cadencr_registry_core::PolicyKind;
use clap::{Subcommand, ValueEnum};

use crate::signing::{sign_blocklist, verify_blocklist};
use crate::{operation_error, output, Diagnostic};

/// Which revocation policy a renewal or publication handles: the clap shim
/// for [`PolicyKind`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(crate) enum PolicyKindArg {
    Provider,
    Theme,
    Tab,
    Lsp,
}

impl PolicyKindArg {
    fn core(self) -> PolicyKind {
        match self {
            PolicyKindArg::Provider => PolicyKind::Provider,
            PolicyKindArg::Theme => PolicyKind::Theme,
            PolicyKindArg::Tab => PolicyKind::Tab,
            PolicyKindArg::Lsp => PolicyKind::Lsp,
        }
    }
}

#[derive(Debug, Subcommand)]
pub(crate) enum PolicyCommand {
    /// Sign a domain-bound theme revocation policy.
    SignThemeBlocklist {
        #[arg(long)]
        payload: PathBuf,
        #[arg(long)]
        private_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        output: PathBuf,
    },
    /// Verify a domain-bound signed theme revocation policy.
    VerifyThemeBlocklist {
        #[arg(long)]
        index: PathBuf,
        #[arg(long)]
        public_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        allow_expired: bool,
    },
    /// Sign the managed-provider revocation policy (no `kind` field).
    SignProviderBlocklist {
        #[arg(long)]
        payload: PathBuf,
        #[arg(long)]
        private_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        output: PathBuf,
    },
    /// Verify a signed managed-provider revocation policy.
    VerifyProviderBlocklist {
        #[arg(long)]
        index: PathBuf,
        #[arg(long)]
        public_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        allow_expired: bool,
    },
    /// Renew a signed policy: the same entries, a new window, a fresh signature.
    RenewPolicy {
        #[arg(long, value_enum)]
        kind: PolicyKindArg,
        /// The signed policy to renew; it must authenticate with --public-key
        /// but may already be expired.
        #[arg(long)]
        current: PathBuf,
        #[arg(long)]
        public_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        private_key: PathBuf,
        /// New expiry, canonical UTC whole seconds (YYYY-MM-DDTHH:mm:ssZ).
        #[arg(long)]
        expires_at: String,
        /// A new file; existing paths are refused.
        #[arg(long)]
        output: PathBuf,
    },
    /// Publish a signed policy to its fixed path on the discovery branch
    /// (token in CADENCR_REGISTRY_GITHUB_TOKEN).
    PublishPolicy {
        #[arg(long, value_enum)]
        kind: PolicyKindArg,
        #[arg(long)]
        signed: PathBuf,
        #[arg(long)]
        repository: String,
        #[arg(long)]
        discovery_branch: String,
        #[arg(long)]
        public_key: PathBuf,
        #[arg(long)]
        key_id: String,
        /// Permit the first publication, when the policy file does not exist yet.
        #[arg(long)]
        bootstrap: bool,
        /// The candidate only renews the policy now on the branch: refuse it
        /// unless its entries are identical to the published ones, so a
        /// stale renewal can never drop a newer revocation.
        #[arg(long, conflicts_with = "bootstrap")]
        renewal: bool,
        /// Write a JSON receipt of the verified publication to a new file.
        #[arg(long)]
        receipt: Option<PathBuf>,
    },
    /// Read a policy's published bytes through the authenticated GitHub API
    /// (token in CADENCR_REGISTRY_GITHUB_TOKEN), bypassing the CDN cache.
    FetchPolicy {
        #[arg(long, value_enum)]
        kind: PolicyKindArg,
        #[arg(long)]
        repository: String,
        #[arg(long)]
        discovery_branch: String,
        /// A new file; existing paths are refused. The bytes are unverified
        /// until `renew-policy` or `verify-*-blocklist` authenticates them.
        #[arg(long)]
        output: PathBuf,
    },
}

pub(crate) fn run(command: &PolicyCommand) -> Result<Option<String>, Diagnostic> {
    match command {
        PolicyCommand::SignThemeBlocklist {
            payload,
            private_key,
            key_id,
            output,
        } => sign_blocklist(PolicyKind::Theme, payload, private_key, key_id, output),
        PolicyCommand::VerifyThemeBlocklist {
            index,
            public_key,
            key_id,
            allow_expired,
        } => verify_blocklist(PolicyKind::Theme, index, public_key, key_id, *allow_expired),
        PolicyCommand::SignProviderBlocklist {
            payload,
            private_key,
            key_id,
            output,
        } => sign_blocklist(PolicyKind::Provider, payload, private_key, key_id, output),
        PolicyCommand::VerifyProviderBlocklist {
            index,
            public_key,
            key_id,
            allow_expired,
        } => verify_blocklist(
            PolicyKind::Provider,
            index,
            public_key,
            key_id,
            *allow_expired,
        ),
        PolicyCommand::RenewPolicy {
            kind,
            current,
            public_key,
            key_id,
            private_key,
            expires_at,
            output,
        } => renew(
            cadencr_registry_core::RenewPolicyRequest::builder()
                .kind(kind.core())
                .current(current)
                .public_key(public_key)
                .key_id(key_id)
                .private_key(private_key)
                .expires_at(expires_at)
                .build(),
            output,
        ),
        PolicyCommand::PublishPolicy {
            kind,
            signed,
            repository,
            discovery_branch,
            public_key,
            key_id,
            bootstrap,
            renewal,
            receipt,
        } => publish(
            cadencr_registry_publisher::PreparePolicyRequest::builder()
                .kind(kind.core())
                .signed(signed)
                .repository(repository)
                .discovery_branch(discovery_branch)
                .public_key(public_key)
                .key_id(key_id)
                .bootstrap(*bootstrap)
                .renewal(*renewal)
                .build(),
            receipt.as_deref(),
        ),
        PolicyCommand::FetchPolicy {
            kind,
            repository,
            discovery_branch,
            output,
        } => fetch(kind.core(), repository, discovery_branch, output),
    }
}

fn renew(
    request: cadencr_registry_core::RenewPolicyRequest<'_>,
    destination: &Path,
) -> Result<Option<String>, Diagnostic> {
    const CODE: &str = "REGISTRY_POLICY_RENEWAL_FAILED";
    output::validate_new_output(destination)?;
    let kind = request.kind;
    let bytes = cadencr_registry_core::renew_policy(request)
        .map_err(|error| operation_error(CODE, error))?;
    output::write_bytes(&bytes, Some(destination))?;
    Ok(Some(format!(
        "wrote renewed {} policy: {}",
        kind.name(),
        destination.display()
    )))
}

fn publish(
    request: cadencr_registry_publisher::PreparePolicyRequest<'_>,
    receipt_path: Option<&Path>,
) -> Result<Option<String>, Diagnostic> {
    const CODE: &str = "REGISTRY_POLICY_PUBLICATION_FAILED";
    if let Some(path) = receipt_path {
        output::validate_new_output(path)?;
    }
    // The candidate and the target are judged before any credential is read.
    let prepared = cadencr_registry_publisher::prepare_policy_publication(request)
        .map_err(|error| operation_error(CODE, error))?;
    let token = crate::publication::publication_token(CODE)?;
    let receipt = cadencr_registry_publisher::publish_policy(&prepared, &token)
        .map_err(|error| operation_error(CODE, error))?;
    if let Some(path) = receipt_path {
        output::write_json_file(&receipt, path, CODE)?;
    }
    Ok(Some(format!(
        "{} policy {:?} and public feed verified: {}",
        receipt.kind, receipt.outcome, receipt.url
    )))
}

fn fetch(
    kind: PolicyKind,
    repository: &str,
    discovery_branch: &str,
    destination: &Path,
) -> Result<Option<String>, Diagnostic> {
    const CODE: &str = "REGISTRY_POLICY_FETCH_FAILED";
    output::validate_new_output(destination)?;
    let token = crate::publication::publication_token(CODE)?;
    let bytes = cadencr_registry_publisher::read_published_policy(
        kind,
        repository,
        discovery_branch,
        &token,
    )
    .map_err(|error| operation_error(CODE, error))?;
    output::write_bytes(&bytes, Some(destination))?;
    Ok(Some(format!(
        "wrote the published {} policy: {}",
        kind.name(),
        destination.display()
    )))
}
