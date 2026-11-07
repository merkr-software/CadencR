//! Custom tabs: local web-UI plugins shown as a feature-page tab.
//!
//! The contract is `docs/CUSTOM_TABS.md`. This module owns §3: the `tab.json`
//! manifest, its validation rules and the permissions hash consent is recorded
//! against. The service and `cadencr plugin validate --kind tab` both call
//! [`inspect_tab_folder`], so the app and the CLI can never disagree about
//! whether a tab is valid.

mod binary;
mod configuration;
mod contributions;
mod elf;
mod execution;
mod folder;
mod hash;
mod issues;
mod macho;
mod manifest;
mod network;
mod platform;
mod shortcuts;
mod validate;

/// The `docs/CUSTOM_TABS.md` §3 example manifest, for tests here and in the
/// crates that build on this one (`features = ["test-support"]`).
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use binary::{
    check_backend_binary, check_backend_bytes, resolve_backend_binary, BinaryProblem,
    ExecutableFormat, FORMAT_HEADER_BYTES,
};
pub use contributions::{TabContributions, TabEditorContribution};
pub use execution::{
    is_denied_program, is_valid_program_name, reasoning_ok, supported_backend_protocols,
    DENIED_PROGRAMS, MAX_COMMANDS, MAX_REASONING_CHARS,
};
pub use folder::{
    inspect_signed_tab_folder, inspect_tab_folder, read_tab_manifest, TabFolderReport,
};
pub use issues::{describe_all, TabFindings, TabIssue, TabIssueCode};
pub use macho::macos_minimum_version;
pub use manifest::{
    TabAccessLevel, TabBackend, TabCommand, TabConfigField, TabConfigFieldType, TabConfigScope,
    TabManifest, TabNetwork, TabSection, TabShortcut,
};
pub use platform::{TabOs, TabPlatform};
pub use validate::{
    is_clean_relative_path, is_valid_tab_id, validate_manifest, MAX_DESCRIPTION_CHARS,
    MAX_LABEL_CHARS, MAX_NAME_CHARS, RESERVED_IDS,
};

pub const MANIFEST_FILE_NAME: &str = "tab.json";
pub const SUPPORTED_SCHEMA_VERSION: u32 = 2;
pub const SUPPORTED_SCHEMA_VERSIONS: [u32; 2] = [1, 2];
/// The plugin API version this host speaks. v1 hosts accept exactly `1`.
pub const SUPPORTED_API_VERSION: u32 = 1;
/// The backend stdio protocol versions this host speaks (§4.7): a manifest
/// declaring another is invalid, and a backend whose `ready` line names
/// another is stopped.
pub const SUPPORTED_BACKEND_PROTOCOLS: [u32; 2] = [1, 2];
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
pub const MAX_ICON_BYTES: u64 = 32 * 1024;

/// Every scope a tab can request (§6), in documentation order.
pub const SCOPES: [&str; 6] = [
    "features:read",
    "git:read",
    "forge:read",
    "files:read",
    "agent:observe",
    "workspace:read",
];
