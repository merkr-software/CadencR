//! What binds members to their plugin once each member folder passed its own
//! kind's validation: every member ships at the plugin's version, and every
//! id is distinct across the plugin and its members (the registry compares
//! them normalized, so `aurora-tab` and `auroratab` collide).

use super::issues::{PluginIssue, PluginIssueCode as Code};
use super::manifest::{PluginManifest, PluginMemberKind};

/// What one validated member declared about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemberIdentity<'a> {
    /// Its position in `contributes`.
    pub index: usize,
    pub kind: PluginMemberKind,
    /// `None` for a kind whose document carries no id (themes).
    pub id: Option<&'a str>,
    /// `None` for a kind whose document carries no version (themes).
    pub version: Option<&'a str>,
}

/// The id the registry compares: ASCII letters and digits only, lowercased.
pub fn normalized_member_id(id: &str) -> String {
    id.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

/// Every version mismatch and id collision among `members`.
pub fn bind_members(manifest: &PluginManifest, members: &[MemberIdentity<'_>]) -> Vec<PluginIssue> {
    let mut issues = Vec::new();
    let mut seen: Vec<(String, String)> = vec![(
        normalized_member_id(&manifest.id),
        format!("the plugin id `{}`", manifest.id),
    )];
    for member in members {
        let field = format!("contributes[{}]", member.index);
        if let Some(version) = member
            .version
            .filter(|version| *version != manifest.version)
        {
            issues.push(PluginIssue::new(
                Code::MemberVersionMismatch,
                field.clone(),
                format!(
                    "{} version {version} must equal the plugin version {}",
                    member.kind, manifest.version
                ),
            ));
        }
        let Some(id) = member.id else { continue };
        let key = normalized_member_id(id);
        if let Some((_, owner)) = seen.iter().find(|(other, _)| *other == key) {
            issues.push(PluginIssue::new(
                Code::MemberIdCollision,
                field.clone(),
                format!("{} id `{id}` collides with {owner}", member.kind),
            ));
        }
        seen.push((key, format!("{field} id `{id}`")));
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::manifest::tests::manifest_json;

    fn manifest() -> PluginManifest {
        serde_json::from_value(manifest_json()).unwrap()
    }

    fn member<'a>(
        index: usize,
        kind: PluginMemberKind,
        id: Option<&'a str>,
        version: Option<&'a str>,
    ) -> MemberIdentity<'a> {
        MemberIdentity {
            index,
            kind,
            id,
            version,
        }
    }

    #[test]
    fn bound_members_pass() {
        let members = [
            member(
                0,
                PluginMemberKind::Provider,
                Some("aurora-agent"),
                Some("1.0.0"),
            ),
            member(1, PluginMemberKind::Tab, Some("aurora-tab"), Some("1.0.0")),
            member(2, PluginMemberKind::Theme, None, None),
        ];
        assert!(bind_members(&manifest(), &members).is_empty());
    }

    #[test]
    fn reports_every_mismatch_and_collision() {
        let members = [
            member(0, PluginMemberKind::Provider, Some("Aurora"), Some("1.0.1")),
            member(1, PluginMemberKind::Tab, Some("aurora-tab"), Some("1.0.0")),
            member(2, PluginMemberKind::Tab, Some("auroratab"), Some("1.0.0")),
        ];
        let issues = bind_members(&manifest(), &members);
        let described: Vec<String> = issues.iter().map(PluginIssue::describe).collect();
        assert_eq!(
            described,
            [
                "[MEMBER_VERSION_MISMATCH] contributes[0]: provider version 1.0.1 must equal the plugin version 1.0.0",
                "[MEMBER_ID_COLLISION] contributes[0]: provider id `Aurora` collides with the plugin id `aurora`",
                "[MEMBER_ID_COLLISION] contributes[2]: tab id `auroratab` collides with contributes[1] id `aurora-tab`",
            ]
        );
        assert_eq!(normalized_member_id("Aurora_Tab-2"), "auroratab2");
    }
}
