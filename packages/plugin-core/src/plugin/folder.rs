//! Inspect one plugin folder: read and validate `plugin.json`, then resolve
//! each member folder (and a provider's descriptor) inside it.
//!
//! Never fails as a whole: problems come back as findings, all at once.

use std::path::{Path, PathBuf};

use super::issues::{PluginFindings, PluginIssue, PluginIssueCode as Code};
use super::manifest::{validate_manifest, PluginManifest, PluginMemberKind};
use super::{MANIFEST_FILE_NAME, MAX_MANIFEST_BYTES};

#[derive(Debug, Clone)]
pub struct PluginFolderReport {
    /// The folder, canonicalized when it resolves.
    pub directory: PathBuf,
    /// `None` when `plugin.json` is missing, unreadable or not a manifest.
    pub manifest: Option<PluginManifest>,
    pub findings: PluginFindings,
    /// The members whose folder (and descriptor) resolved inside the plugin
    /// folder, in manifest order; empty unless the manifest itself is valid.
    pub members: Vec<ResolvedMember>,
}

impl PluginFolderReport {
    /// A manifest that parsed and passed every rule, with every member
    /// resolved.
    pub fn valid_manifest(&self) -> Option<&PluginManifest> {
        self.manifest.as_ref().filter(|_| self.findings.is_valid())
    }
}

/// Where one member lives on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMember {
    /// Its position in `contributes`.
    pub index: usize,
    pub kind: PluginMemberKind,
    /// `path` as declared.
    pub path: String,
    /// The canonical member folder.
    pub directory: PathBuf,
    /// The canonical descriptor file of a provider member.
    pub descriptor: Option<PathBuf>,
}

impl ResolvedMember {
    /// `contributes[1] tab `aurora-tab``, for messages.
    pub fn label(&self) -> String {
        format!("contributes[{}] {} `{}`", self.index, self.kind, self.path)
    }
}

/// Read and validate `<directory>/plugin.json` and resolve its members.
pub fn inspect_plugin_folder(directory: &Path) -> PluginFolderReport {
    let mut report = PluginFolderReport {
        directory: directory.to_path_buf(),
        manifest: None,
        findings: PluginFindings::default(),
        members: Vec::new(),
    };
    let root = match directory.canonicalize() {
        Ok(root) if root.is_dir() => root,
        Ok(_) => return unreadable(report, "the plugin folder is not a directory"),
        Err(error) => return unreadable(report, format!("cannot open the plugin folder: {error}")),
    };
    report.directory = root.clone();
    let bytes = match read_manifest(&root) {
        Ok(bytes) => bytes,
        Err(reason) => return unreadable(report, reason),
    };
    let manifest: PluginManifest = match serde_json::from_slice(&bytes) {
        Ok(manifest) => manifest,
        Err(error) => {
            report.findings.errors.push(PluginIssue::document(
                Code::ManifestInvalidJson,
                format!("{MANIFEST_FILE_NAME}: {error}"),
            ));
            return report;
        }
    };
    report.findings = validate_manifest(&manifest);
    if report.findings.is_valid() {
        report.members = resolve_members(&root, &manifest, &mut report.findings);
    }
    report.manifest = Some(manifest);
    report
}

fn unreadable(mut report: PluginFolderReport, message: impl Into<String>) -> PluginFolderReport {
    report
        .findings
        .errors
        .push(PluginIssue::document(Code::ManifestUnreadable, message));
    report
}

fn read_manifest(root: &Path) -> Result<Vec<u8>, String> {
    let path = root.join(MANIFEST_FILE_NAME);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => crate::read_regular_bounded(&path, MAX_MANIFEST_BYTES)
            .map_err(|error| format!("{MANIFEST_FILE_NAME} {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("{MANIFEST_FILE_NAME} is missing"))
        }
        Err(error) => Err(format!("cannot inspect {MANIFEST_FILE_NAME}: {error}")),
    }
}

fn resolve_members(
    root: &Path,
    manifest: &PluginManifest,
    findings: &mut PluginFindings,
) -> Vec<ResolvedMember> {
    let mut members = Vec::new();
    for (index, member) in manifest.contributes.iter().enumerate() {
        let Some(kind) = member.member_kind() else {
            continue;
        };
        let field = format!("contributes[{index}]");
        let directory = match contained(root, &member.path) {
            Ok(path) if path.is_dir() => Some(path),
            Ok(_) => fail(
                findings,
                Code::MemberFolderInvalid,
                &field,
                "path",
                "is not a directory",
            ),
            Err(reason) => fail(findings, Code::MemberFolderInvalid, &field, "path", &reason),
        };
        let descriptor = match member
            .descriptor
            .as_deref()
            .map(|file| descriptor_file(root, file))
        {
            None => Some(None),
            Some(Ok(path)) => Some(Some(path)),
            Some(Err(reason)) => fail(
                findings,
                Code::MemberDescriptorInvalid,
                &field,
                "descriptor",
                &reason,
            ),
        };
        if let (Some(directory), Some(descriptor)) = (directory, descriptor) {
            members.push(ResolvedMember {
                index,
                kind,
                path: member.path.clone(),
                directory,
                descriptor,
            });
        }
    }
    members
}

fn fail<T>(
    findings: &mut PluginFindings,
    code: Code,
    member: &str,
    key: &str,
    reason: &str,
) -> Option<T> {
    findings.error(code, format!("{member}.{key}"), reason);
    None
}

/// `relative` under `root`, canonicalized, when it stays inside `root`.
fn contained(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let resolved = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("cannot open `{relative}`: {error}"))?;
    if resolved.starts_with(root) && resolved != root {
        Ok(resolved)
    } else {
        Err(format!("`{relative}` resolves outside the plugin folder"))
    }
}

/// A regular, non-symlink file inside the plugin folder.
fn descriptor_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(root.join(relative))
        .map_err(|error| format!("cannot open `{relative}`: {error}"))?;
    if !metadata.is_file() {
        return Err(format!(
            "`{relative}` must be a regular file, not a symlink"
        ));
    }
    contained(root, relative)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::manifest::tests::manifest_json;
    use serde_json::Value;

    fn plugin_folder(manifest: &Value) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for member in ["agent", "aurora-tab", "theme"] {
            std::fs::create_dir(root.path().join(member)).unwrap();
        }
        std::fs::write(root.path().join("agent/aurora-agent.json"), "{}").unwrap();
        std::fs::write(
            root.path().join(MANIFEST_FILE_NAME),
            serde_json::to_vec(manifest).unwrap(),
        )
        .unwrap();
        root
    }

    fn codes(report: &PluginFolderReport) -> Vec<&'static str> {
        report
            .findings
            .errors
            .iter()
            .map(|i| i.code.as_str())
            .collect()
    }

    #[test]
    fn resolves_every_member_inside_the_folder() {
        let root = plugin_folder(&manifest_json());
        let report = inspect_plugin_folder(root.path());
        assert!(report.valid_manifest().is_some(), "{report:?}");
        let canonical = root.path().canonicalize().unwrap();
        let kinds: Vec<_> = report.members.iter().map(|m| m.kind).collect();
        assert_eq!(
            kinds,
            [
                PluginMemberKind::Provider,
                PluginMemberKind::Tab,
                PluginMemberKind::Theme
            ]
        );
        assert_eq!(report.members[1].directory, canonical.join("aurora-tab"));
        assert_eq!(
            report.members[0].descriptor.as_deref(),
            Some(canonical.join("agent/aurora-agent.json").as_path())
        );
        assert_eq!(report.members[1].label(), "contributes[1] tab `aurora-tab`");
    }

    #[test]
    fn reports_missing_and_malformed_manifests() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            codes(&inspect_plugin_folder(root.path())),
            ["MANIFEST_UNREADABLE"]
        );
        std::fs::write(root.path().join(MANIFEST_FILE_NAME), "{").unwrap();
        assert_eq!(
            codes(&inspect_plugin_folder(root.path())),
            ["MANIFEST_INVALID_JSON"]
        );
        let missing = root.path().join("missing");
        assert_eq!(
            codes(&inspect_plugin_folder(&missing)),
            ["MANIFEST_UNREADABLE"]
        );
        std::fs::write(root.path().join(MANIFEST_FILE_NAME), "x".repeat(65 * 1024)).unwrap();
        assert_eq!(
            codes(&inspect_plugin_folder(root.path())),
            ["MANIFEST_UNREADABLE"]
        );
    }

    #[test]
    fn reports_every_unresolvable_member() {
        let root = plugin_folder(&manifest_json());
        std::fs::remove_dir(root.path().join("theme")).unwrap();
        std::fs::write(root.path().join("theme"), "not a folder").unwrap();
        std::fs::remove_file(root.path().join("agent/aurora-agent.json")).unwrap();
        let report = inspect_plugin_folder(root.path());
        assert_eq!(
            codes(&report),
            ["MEMBER_DESCRIPTOR_INVALID", "MEMBER_FOLDER_INVALID"]
        );
        assert_eq!(report.members.len(), 1);
        assert!(report.valid_manifest().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_members_and_descriptors_that_escape_through_symlinks() {
        use std::os::unix::fs::symlink;
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("aurora-agent.json"), "{}").unwrap();
        let root = plugin_folder(&manifest_json());
        std::fs::remove_dir(root.path().join("aurora-tab")).unwrap();
        symlink(outside.path(), root.path().join("aurora-tab")).unwrap();
        let descriptor = root.path().join("agent/aurora-agent.json");
        std::fs::remove_file(&descriptor).unwrap();
        symlink(outside.path().join("aurora-agent.json"), &descriptor).unwrap();
        let report = inspect_plugin_folder(root.path());
        assert_eq!(
            codes(&report),
            ["MEMBER_DESCRIPTOR_INVALID", "MEMBER_FOLDER_INVALID"]
        );
    }
}
