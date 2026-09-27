use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "cadencr",
    version,
    about = "Headless Cadencr package and registry tooling"
)]
pub(crate) struct Cli {
    /// Emit one JSON diagnostic object instead of human-readable output.
    #[arg(long, global = true)]
    pub(crate) json: bool,
    #[command(subcommand)]
    pub(crate) command: Command,
}

#[derive(Debug, Subcommand)]
pub(crate) enum Command {
    /// Validate local provider structure without installing or executing it.
    Plugin(PluginArgs),
    /// Validate, package, sign, or publish a local package registry.
    Registry(RegistryArgs),
}

#[derive(Debug, Args)]
pub(crate) struct PluginArgs {
    #[command(subcommand)]
    pub(crate) command: PluginCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum PluginCommand {
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
pub(crate) struct RegistryArgs {
    #[command(subcommand)]
    pub(crate) command: RegistryCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum RegistryCommand {
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
    /// Download and verify publication artifacts into an immutable staging directory.
    StagePublication {
        #[arg(long)]
        submission: PathBuf,
        #[arg(long)]
        repository: String,
        #[arg(long)]
        directory: PathBuf,
    },
    /// Mirror verified local artifacts into an explicitly confirmed GitHub draft.
    MirrorPublication(MirrorArgs),
    /// Publish a verified draft after explicit repository and release-tag confirmation.
    PromotePublication(PromoteArgs),
    /// Recover local mirror proof for an already published, fully staged release.
    RecoverPublication(RecoverArgs),
    /// Sign a catalog only from verified publications and public artifact bytes.
    SignPublicationCatalog(SignCatalogArgs),
    /// Publish an explicitly confirmed signed catalog to its immutable GitHub release.
    PublishCatalog(PublishCatalogArgs),
    /// Advance a confirmed stable discovery branch to an already published catalog.
    AdvanceCatalog(Box<AdvanceCatalogArgs>),
    /// Sign a validated canonical index with an Ed25519 PKCS8 PEM key.
    SignIndex {
        #[arg(long)]
        payload: PathBuf,
        #[arg(long)]
        private_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        output: PathBuf,
    },
    /// Verify a signed index with an Ed25519 SPKI PEM key.
    VerifyIndex {
        #[arg(long)]
        index: PathBuf,
        #[arg(long)]
        public_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        allow_expired: bool,
    },
    /// Join a validated canonical payload and detached signature document.
    AssembleSignedIndex {
        #[arg(long)]
        payload: PathBuf,
        #[arg(long)]
        signature: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}

impl Cli {
    pub(crate) fn writes_index_to_stdout(&self) -> bool {
        matches!(
            &self.command,
            Command::Registry(RegistryArgs {
                command: RegistryCommand::BuildIndex { output: None, .. }
            }) | Command::Registry(RegistryArgs {
                command: RegistryCommand::PackProvider { .. }
            })
        )
    }
}

#[derive(Debug, Args)]
pub(crate) struct MirrorArgs {
    #[arg(long)]
    pub(crate) submission: PathBuf,
    #[arg(long)]
    pub(crate) repository: String,
    #[arg(long)]
    pub(crate) registry_commit: String,
    #[arg(long)]
    pub(crate) directory: PathBuf,
    #[arg(long)]
    pub(crate) confirm_repository: String,
}

#[derive(Debug, Args)]
pub(crate) struct PromoteArgs {
    #[command(flatten)]
    pub(crate) publication: MirrorArgs,
    /// Must exactly match the planned immutable release tag.
    #[arg(long)]
    pub(crate) confirm_publish: String,
}

#[derive(Debug, Args)]
pub(crate) struct SignCatalogArgs {
    #[arg(long)]
    pub(crate) manifest: PathBuf,
    #[arg(long)]
    pub(crate) generated_at: String,
    #[arg(long)]
    pub(crate) expires_at: String,
    #[arg(long)]
    pub(crate) private_key: PathBuf,
    #[arg(long)]
    pub(crate) key_id: String,
    #[arg(long)]
    pub(crate) output: PathBuf,
}

#[derive(Debug, Args)]
pub(crate) struct PublishCatalogArgs {
    #[arg(long)]
    pub(crate) catalog: PathBuf,
    /// Exact previous catalog file, or the literal bootstrap for the first publication.
    #[arg(long)]
    pub(crate) previous_index: String,
    #[arg(long)]
    pub(crate) public_key: PathBuf,
    #[arg(long)]
    pub(crate) key_id: String,
    #[arg(long)]
    pub(crate) manifest: PathBuf,
    #[arg(long)]
    pub(crate) repository: String,
    #[arg(long)]
    pub(crate) registry_commit: String,
    #[arg(long)]
    pub(crate) directory: PathBuf,
    #[arg(long)]
    pub(crate) confirm_repository: String,
    /// Must exactly match catalog-<SHA-256 of the canonical signed catalog>.
    #[arg(long)]
    pub(crate) confirm_publish: String,
}

#[derive(Debug, Args)]
pub(crate) struct AdvanceCatalogArgs {
    #[command(flatten)]
    pub(crate) catalog: PublishCatalogArgs,
    #[arg(long)]
    pub(crate) discovery_branch: String,
    /// Must exactly match the canonical raw GitHub discovery URL.
    #[arg(long)]
    pub(crate) confirm_discovery: String,
}

#[derive(Debug, Args)]
pub(crate) struct RecoverArgs {
    #[command(flatten)]
    pub(crate) publication: MirrorArgs,
    /// Must exactly match the planned published release tag; never publishes it.
    #[arg(long)]
    pub(crate) confirm_recover: String,
}
