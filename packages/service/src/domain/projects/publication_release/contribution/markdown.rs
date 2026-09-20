use super::super::local::LocalRelease;

pub(super) fn render(
    local: &LocalRelease,
    account: &str,
    filename: &str,
    publisher: &str,
) -> Vec<u8> {
    let plan = &local.plan;
    let repository = format!("https://github.com/{}", plan.repository);
    let archive = format!(
        "{repository}/releases/download/{}/{}",
        plan.tag, plan.archive_name
    );
    let changelog = literal(&plan.release_notes);
    format!(
        "# Provider version contribution\n\n## Identity\n\n- Provider ID: `{}`\n- Version: `{}`\n- Declared publisher: `{}`\n- Connected GitHub account: `{}`\n- Source repository: `{repository}`\n- Source commit: `{}`\n- Release tag: `{}`\n\n## Contribution files\n\n- Package: `packages/{filename}`\n- Source-pinned submission: `submissions/{filename}`\n\n## Artifacts\n\n| Platform | Release asset URL | SHA-256 |\n| --- | --- | --- |\n| `{}` | `{archive}` | `{}` |\n\n## Review notes\n\n### User-visible changes\n\n{changelog}\n\n- Native CLI prerequisite and authentication/setup documentation: author review required.\n- License and provenance: maintainer review required.\n- Dependency or privilege changes: author review required.\n\n## Checklist\n\n- [x] Paired package and source-pinned submission files were generated.\n- [x] The submission pins the exact source commit, release tag, and archive checksum.\n- [ ] I control or am authorized to publish the linked project and provider ID.\n- [ ] Archives contain no credentials; users authenticate through the native CLI.\n- [ ] Runtime and prompt-free conformance pass.\n- [ ] Official registry tests and contribution validation pass.\n",
        literal(&plan.plugin_id),
        literal(&plan.version),
        literal(publisher),
        literal(account),
        literal(&plan.source_commit),
        literal(&plan.tag),
        literal(&plan.target),
        plan.archive_sha256,
    )
    .into_bytes()
}

fn literal(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control() || *ch == '\n' || *ch == '\t')
        .flat_map(|ch| match ch {
            '\\' | '`' | '[' | ']' | '(' | ')' | '<' | '>' | '*' | '_' | '#' | '|' | '~' => {
                vec!['\\', ch]
            }
            _ => vec![ch],
        })
        .collect()
}
