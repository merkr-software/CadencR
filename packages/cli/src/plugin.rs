use std::path::Path;

use crate::{operation_error, Diagnostic};
use cadencr_plugin_core::plugin::{
    bind_members, inspect_plugin_folder, MemberIdentity, PluginManifest, PluginMemberKind,
    ResolvedMember,
};

const FAILED: &str = "PLUGIN_VALIDATION_FAILED";

/// The id and version a member's own document declares; neither for a
/// theme, whose `theme.json` carries none.
#[derive(Default)]
struct Declared {
    id: Option<String>,
    version: Option<String>,
}

impl Declared {
    fn of(id: &str, version: &str) -> Self {
        Self {
            id: Some(id.to_owned()),
            version: Some(version.to_owned()),
        }
    }
}

/// One member that passed its kind's validation and the report line it got.
struct Valid {
    member: ResolvedMember,
    declared: Declared,
    message: String,
}

impl Valid {
    fn identity(&self) -> MemberIdentity<'_> {
        MemberIdentity {
            index: self.member.index,
            kind: self.member.kind,
            id: self.declared.id.as_deref(),
            version: self.declared.version.as_deref(),
        }
    }
}

/// `cadencr plugin validate <folder> --kind plugin`: `plugin.json`, then every
/// member folder with its own kind's validator (a tab member's backend runs
/// through the conformance checks unless `run_backend` is off), then the
/// bindings between them. Every problem is reported at once, per member.
pub(crate) fn validate(
    folder: &Path,
    descriptor: Option<&Path>,
    run_backend: bool,
) -> Result<Option<String>, Diagnostic> {
    if descriptor.is_some() {
        return Err(operation_error(
            FAILED,
            "--descriptor is not used for multi-export plugins; provider members name theirs in plugin.json",
        ));
    }
    let report = inspect_plugin_folder(folder);
    let Some(manifest) = report.valid_manifest() else {
        return Err(operation_error(FAILED, report.findings.describe_errors()));
    };
    let mut valid = Vec::new();
    let mut problems = Vec::new();
    for member in &report.members {
        match check_member(member, run_backend) {
            Ok((declared, message)) => valid.push(Valid {
                member: member.clone(),
                declared,
                message,
            }),
            Err(error) => problems.push((
                member.index,
                format!("{}: [{}] {}", member.label(), error.code, error.message),
            )),
        }
    }
    let identities: Vec<MemberIdentity<'_>> = valid.iter().map(Valid::identity).collect();
    for issue in bind_members(manifest, &identities) {
        let member = report.members.iter().find(|member| {
            issue.field.as_deref() == Some(&format!("contributes[{}]", member.index))
        });
        let label = member.map_or_else(|| "plugin".to_string(), ResolvedMember::label);
        problems.push((
            member.map_or(0, |member| member.index),
            format!("{label}: [{}] {}", issue.code.as_str(), issue.message),
        ));
    }
    let heading = heading(manifest, &report.directory);
    if !problems.is_empty() {
        // Stable: per member, its own validation before its bindings.
        problems.sort_by_key(|(index, _)| *index);
        let lines = problems.into_iter().map(|(_, line)| line);
        return Err(operation_error(
            FAILED,
            format!("{heading} is invalid:{}", bullets(lines)),
        ));
    }
    let lines = valid
        .into_iter()
        .map(|valid| format!("{}: {}", valid.member.label(), valid.message));
    Ok(Some(format!(
        "valid multi-export plugin: {heading}:{}",
        bullets(lines)
    )))
}

fn check_member(
    member: &ResolvedMember,
    run_backend: bool,
) -> Result<(Declared, String), Diagnostic> {
    match member.kind {
        PluginMemberKind::Provider => {
            let descriptor = member.descriptor.as_deref().ok_or_else(|| {
                operation_error(
                    "PLUGIN_DESCRIPTOR_REQUIRED",
                    "provider member has no descriptor",
                )
            })?;
            let provider =
                crate::commands::validate_provider_folder(&member.directory, descriptor)?;
            let message = crate::commands::provider_message(&member.directory);
            let agent = &provider.descriptor.agent;
            Ok((Declared::of(&agent.id, &agent.version), message))
        }
        PluginMemberKind::Tab => crate::tab::validate_folder(&member.directory, run_backend)
            .map(|(manifest, message)| (Declared::of(&manifest.id, &manifest.version), message)),
        PluginMemberKind::Lsp => {
            crate::lsp::validate_folder(&member.directory).map(|(descriptor, message)| {
                (Declared::of(&descriptor.id, &descriptor.version), message)
            })
        }
        PluginMemberKind::Theme => crate::theme::validate_folder(&member.directory)
            .map(|message| (Declared::default(), message)),
    }
}

fn heading(manifest: &PluginManifest, directory: &Path) -> String {
    format!(
        "{} {} ({}, {} members)",
        manifest.id,
        manifest.version,
        directory.display(),
        manifest.contributes.len()
    )
}

fn bullets(lines: impl IntoIterator<Item = String>) -> String {
    lines
        .into_iter()
        .map(|line| format!("\n- {line}"))
        .collect()
}
