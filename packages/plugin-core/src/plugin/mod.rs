//! Multi-export plugins: one author folder whose `plugin.json` names several
//! single-kind members — a provider, a custom tab, a theme, in any
//! combination — that ship and update together as one marketplace `plugin`
//! entry.
//!
//! This module owns the author manifest and the rules that bind members to
//! it. Each member folder is still validated by its own kind's validator;
//! [`inspect_plugin_folder`] only resolves where they are, and
//! [`bind_members`] checks what the members declared against the plugin.

mod binding;
mod folder;
mod issues;
mod manifest;

pub use binding::{bind_members, normalized_member_id, MemberIdentity};
pub use folder::{inspect_plugin_folder, PluginFolderReport, ResolvedMember};
pub use issues::{describe_all, PluginFindings, PluginIssue, PluginIssueCode};
pub use manifest::{
    is_valid_plugin_id, validate_manifest, PluginManifest, PluginMember, PluginMemberKind,
};

pub const MANIFEST_FILE_NAME: &str = "plugin.json";
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;
pub const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// Members one plugin may contribute (the registry's limit).
pub const MAX_MEMBERS: usize = 6;
pub const MAX_ID_BYTES: usize = 64;
pub const MAX_NAME_CHARS: usize = 64;
pub const MAX_DESCRIPTION_CHARS: usize = 280;
