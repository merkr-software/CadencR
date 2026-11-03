//! Shared, side-effect-free contracts for inspecting Cadencr provider plugins.
//!
//! Validation reads bounded local files but never executes provider code. This
//! contracts support provider, declarative theme and custom-tab content, and
//! multi-export plugins that bundle several of them. Validation does
//! not constitute publication approval.

pub mod plugin;
pub mod tab;
pub mod theme;

mod descriptor;
mod error;
mod folder;
mod relative_path;
mod safe_read;

pub use descriptor::{
    current_binary_target, validate_provider_id, AcpAgentEntry, AcpBinaryTarget, AcpDistribution,
    AcpPackageDistribution, HostInstallationSpec, LocalAssetsSpec, LocalExecutableSpec,
    ProviderDescriptor, ACP_BINARY_TARGETS, SUPPORTED_SCHEMA_VERSION,
};
pub use error::{DescriptorError, PluginValidationError, RejectionCode};
pub use folder::{validate_plugin_folder, ValidatedPluginFolder};
pub use relative_path::{is_normalized_relative_path, MAX_RELATIVE_PATH_BYTES};
pub use safe_read::{open_regular_bounded, read_regular_bounded, sha256_regular_bounded};
