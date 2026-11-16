//! Multi-export plugins: one signed catalog entry (`kind: "plugin"`) whose
//! `contributes` are complete single-kind entries — a theme, a provider, a
//! custom tab, in any combination. Every member shares the plugin's version,
//! source repository, publisher and host compatibility, so one release ships
//! and updates them together.
//!
//! Consumers never install a plugin as such: [`catalog_members`] flattens a
//! catalog into the single-kind entries each kind's installer already
//! resolves, verifies and revokes by member id.
use serde_json::{Map, Value};

use crate::diagnostics::Diagnostics;
use crate::marketplace::Rules;
use crate::package::{identity, normalized_provider_id, reject_unknown};

use cadencr_plugin_core::plugin::PluginMemberKind;

pub const PLUGIN_KIND: &str = "plugin";
/// Members one plugin may contribute (the author manifest's limit).
pub const MAX_PLUGIN_MEMBERS: usize = cadencr_plugin_core::plugin::MAX_MEMBERS;
/// The single kinds a plugin may contribute.
pub const PLUGIN_MEMBER_KINDS: [&str; 4] = [
    PluginMemberKind::Provider.as_str(),
    PluginMemberKind::Theme.as_str(),
    PluginMemberKind::Tab.as_str(),
    PluginMemberKind::Lsp.as_str(),
];
const DESCRIPTOR_FIELDS: [&str; 6] = [
    "id",
    "name",
    "description",
    "version",
    "repository",
    "license",
];

/// The members of a plugin entry; empty for every other entry.
pub fn plugin_members(entry: &Value) -> &[Value] {
    if entry.get("kind").and_then(Value::as_str) != Some(PLUGIN_KIND) {
        return &[];
    }
    entry
        .pointer("/package/contributes")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Every installable single-kind entry of a validated catalog: top-level
/// provider, theme and tab entries plus each plugin's members, in catalog
/// order. Entries of a kind this build does not know are skipped.
pub fn catalog_members(packages: &[Value]) -> impl Iterator<Item = &Value> {
    identity_units(packages).filter(|entry| {
        crate::marketplace::marketplace_package_kind(entry)
            .is_some_and(|kind| PLUGIN_MEMBER_KINDS.contains(&kind))
    })
}

/// Every entry that owns an id in the catalog namespace: each top-level
/// entry, then its plugin members.
pub(crate) fn identity_units(packages: &[Value]) -> impl Iterator<Item = &Value> {
    identity_units_of(packages)
}

/// [`identity_units`] over any collection of entries.
pub(crate) fn identity_units_of<'a>(
    packages: impl IntoIterator<Item = &'a Value>,
) -> impl Iterator<Item = &'a Value> {
    packages
        .into_iter()
        .flat_map(|entry| std::iter::once(entry).chain(plugin_members(entry)))
}

/// A member id belongs to exactly one plugin: it never appears in another
/// plugin or as a standalone package, so a plugin's members and their
/// recommendations always come from that plugin's releases.
pub(crate) fn validate_member_ownership<'a>(
    packages: impl IntoIterator<Item = &'a Value> + Clone,
) -> Result<(), crate::RegistryError> {
    let mut plugin_of = std::collections::HashMap::<&str, &str>::new();
    for entry in packages.clone() {
        let Some((plugin, _)) = identity(entry) else {
            continue;
        };
        for (member, _) in plugin_members(entry).iter().filter_map(identity) {
            if let Some(prior) = plugin_of
                .insert(member, plugin)
                .filter(|prior| *prior != plugin)
            {
                return Err(crate::RegistryError::single(format!(
                    "plugin member {member} already belongs to plugin {prior}"
                )));
            }
        }
    }
    for entry in packages {
        if crate::marketplace::kind(entry) == PLUGIN_KIND {
            continue;
        }
        let Some((id, _)) = identity(entry) else {
            continue;
        };
        if let Some(plugin) = plugin_of.get(id) {
            return Err(crate::RegistryError::single(format!(
                "package {id} is a member of plugin {plugin} and cannot be published on its own"
            )));
        }
    }
    Ok(())
}

/// The author manifest's plugin id grammar, enforced again at publication.
pub fn valid_plugin_id(id: &str) -> bool {
    cadencr_plugin_core::plugin::is_valid_plugin_id(id)
}

/// Validate a plugin entry's `package` content.
pub(crate) fn validate(content: &Value, label: &str, rules: Rules, errors: &mut Diagnostics) {
    let Some(object) = content.as_object() else {
        errors.push(format!("{label}.package must be an object"));
        return;
    };
    reject_unknown(object, &["plugin", "host", "contributes"], label, errors);
    let Some(plugin) = object.get("plugin").and_then(Value::as_object) else {
        errors.push(format!("{label}.plugin must be an object"));
        return;
    };
    validate_descriptor(plugin, label, errors);
    // A plugin has no archive of its own to hold assets: its host is only
    // what every member shares.
    if let Some(host) = object.get("host").and_then(Value::as_object) {
        if host.contains_key("assets") {
            errors.push(format!(
                "{label}.host.assets is not allowed: a plugin has no archive"
            ));
        }
        crate::package::host::validate_host_metadata(host, label, errors);
    } else {
        errors.push(format!("{label}.host must be an object"));
    }
    let Some(members) = object.get("contributes").and_then(Value::as_array) else {
        errors.push(format!("{label}.contributes must be an array"));
        return;
    };
    if members.is_empty() || members.len() > MAX_PLUGIN_MEMBERS {
        errors.push(format!(
            "{label}.contributes must list 1 to {MAX_PLUGIN_MEMBERS} members"
        ));
    }
    let mut previous: Option<(&str, &str)> = None;
    let mut seen = vec![plugin_id_key(plugin)];
    for (position, member) in members.iter().enumerate() {
        if errors.is_full() {
            break;
        }
        let member_label = format!("{label}.contributes[{position}]");
        let Some(kind) = member.get("kind").and_then(Value::as_str) else {
            errors.push(format!("{member_label}.kind must be a string"));
            continue;
        };
        if kind == PLUGIN_KIND {
            errors.push(format!("{member_label}: plugins cannot contribute plugins"));
            continue;
        }
        crate::marketplace::validate_with(member, &member_label, rules, errors);
        if !PLUGIN_MEMBER_KINDS.contains(&kind) {
            // Consume only: a member of a newer kind is not installable here.
            continue;
        }
        let Some((id, version)) = identity(member) else {
            continue;
        };
        if previous.is_some_and(|prior| prior >= (kind, id)) {
            errors.push(format!(
                "{label}.contributes must be sorted by kind then id without duplicates"
            ));
        }
        previous = Some((kind, id));
        let key = normalized_provider_id(id);
        if seen.contains(&key) {
            errors.push(format!(
                "{member_label} id {id} collides with another id of this plugin"
            ));
        }
        seen.push(key);
        validate_member_binding(object, plugin, member, version, &member_label, errors);
    }
}

fn plugin_id_key(plugin: &Map<String, Value>) -> String {
    normalized_provider_id(plugin.get("id").and_then(Value::as_str).unwrap_or(""))
}

fn validate_descriptor(plugin: &Map<String, Value>, label: &str, errors: &mut Diagnostics) {
    reject_unknown(
        plugin,
        &DESCRIPTOR_FIELDS,
        &format!("{label}.plugin"),
        errors,
    );
    if !plugin
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(valid_plugin_id)
    {
        errors.push(format!("{label}.plugin.id is invalid"));
    }
    crate::marketplace::validate_descriptor_text(plugin, &format!("{label}.plugin"), errors);
}

/// A member ships in its plugin's release: same version, source repository,
/// publisher and host compatibility.
fn validate_member_binding(
    content: &Map<String, Value>,
    plugin: &Map<String, Value>,
    member: &Value,
    version: &str,
    label: &str,
    errors: &mut Diagnostics,
) {
    if plugin.get("version").and_then(Value::as_str) != Some(version) {
        errors.push(format!("{label} version must equal the plugin version"));
    }
    if crate::marketplace::descriptor(member).get("repository") != plugin.get("repository") {
        errors.push(format!(
            "{label} repository must equal the plugin repository"
        ));
    }
    let host = content.get("host");
    let member_host = crate::marketplace::body(member).get("host");
    for field in ["publisher", "compatibility"] {
        if member_host.and_then(|value| value.get(field)) != host.and_then(|value| value.get(field))
        {
            errors.push(format!("{label}.host.{field} must equal the plugin host"));
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::marketplace::tests::theme;
    use crate::validate_marketplace_package;
    use serde_json::json;

    const REPOSITORY: &str = "https://github.com/acme/aurora";

    pub(crate) fn tab_member(id: &str, version: &str) -> Value {
        json!({"kind":"tab","package":{"tab":{"id":id,"name":"Aurora tab","description":"Tab",
            "version":version,"repository":REPOSITORY,"license":"MIT","api_version":1,
            "distribution":{"archive":format!("{REPOSITORY}/releases/download/v{version}/tab.tar.gz"),
                "sha256":"b".repeat(64)}},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"1.0.0"}}}})
    }

    pub(crate) fn theme_member(id: &str, version: &str) -> Value {
        let mut member = theme();
        let descriptor = &mut member["package"]["theme"];
        descriptor["id"] = json!(id);
        descriptor["version"] = json!(version);
        descriptor["repository"] = json!(REPOSITORY);
        descriptor["distribution"]["archive"] = json!(format!(
            "{REPOSITORY}/releases/download/v{version}/theme.tar.gz"
        ));
        member
    }

    pub(crate) fn provider_member(id: &str, version: &str) -> Value {
        json!({"kind":"provider","package":{"agent":{"id":id,"name":"Aurora agent",
            "version":version,"description":"Agent","license":"MIT","repository":REPOSITORY,
            "distribution":{"binary":{"darwin-aarch64":{
                "archive":format!("{REPOSITORY}/releases/download/v{version}/agent-darwin-aarch64.tar.gz"),
                "cmd":"bin/provider","sha256":"c".repeat(64)}}}},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"1.0.0"},
                "assets":{"icon":"icon.svg","readme":"README.md","license":"LICENSE"}}}})
    }

    /// A theme + provider + tab plugin and its source-release submission.
    pub(crate) fn full_submission() -> Value {
        let mut package = plugin("1.0.0");
        package["package"]["contributes"]
            .as_array_mut()
            .unwrap()
            .insert(0, provider_member("aurora-agent", "1.0.0"));
        json!({"schema_version":2,"package":package,"changelog":"Release",
            "source":{"repository":REPOSITORY,"commit":"a".repeat(40),"tag":"v1.0.0"}})
    }

    pub(crate) fn plugin(version: &str) -> Value {
        json!({"kind":"plugin","package":{
            "plugin":{"id":"aurora","name":"Aurora","description":"Theme and tab",
                "version":version,"repository":REPOSITORY,"license":"MIT"},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"1.0.0"}},
            "contributes":[tab_member("aurora-tab", version), theme_member("aurora-theme", version)]}})
    }

    #[test]
    fn plugin_contract_accepts_bound_members_and_flattens_them() {
        let value = plugin("1.0.0");
        validate_marketplace_package(&value).unwrap();
        assert_eq!(
            crate::marketplace_package_identity(&value),
            Some(("aurora", "1.0.0"))
        );
        let packages = [value, theme()];
        let members = catalog_members(&packages)
            .filter_map(identity)
            .collect::<Vec<_>>();
        assert_eq!(
            members,
            [
                ("aurora-tab", "1.0.0"),
                ("aurora-theme", "1.0.0"),
                ("midnight", "1.0.0")
            ]
        );
        assert!(matches!(
            crate::parse_marketplace_package(&packages[0]).unwrap(),
            crate::MarketplacePackage::Plugin(_)
        ));
    }

    #[test]
    fn members_must_share_the_plugin_release() {
        let cases: [(&str, Value); 5] = [
            ("/package/contributes/0/package/tab/version", json!("2.0.0")),
            (
                "/package/contributes/0/package/tab/repository",
                json!("https://github.com/acme/other"),
            ),
            (
                "/package/contributes/0/package/host/publisher",
                json!("other"),
            ),
            (
                "/package/contributes/0/package/host/compatibility/min_app_version",
                json!("2.0.0"),
            ),
            ("/package/contributes/1/package/theme/id", json!("aurora")),
        ];
        for (path, replacement) in cases {
            let mut bad = plugin("1.0.0");
            *bad.pointer_mut(path).unwrap() = replacement;
            assert!(
                validate_marketplace_package(&bad).is_err(),
                "accepted {path}"
            );
        }
    }

    #[test]
    fn members_are_closed_canonical_and_never_nested() {
        let mut unsorted = plugin("1.0.0");
        unsorted["package"]["contributes"]
            .as_array_mut()
            .unwrap()
            .reverse();
        let mut nested = plugin("1.0.0");
        nested["package"]["contributes"][0] = plugin("1.0.0");
        let mut unknown = plugin("1.0.0");
        unknown["package"]["contributes"][0]["kind"] = json!("skill");
        let mut empty = plugin("1.0.0");
        empty["package"]["contributes"] = json!([]);
        let mut extra = plugin("1.0.0");
        extra["package"]["plugin"]["icon"] = json!("x.png");
        let mut assets = plugin("1.0.0");
        assets["package"]["host"]["assets"] = json!({"icon":"icon.png"});
        let mut duplicate = plugin("1.0.0");
        duplicate["package"]["contributes"][1] = tab_member("aurora-tab", "1.0.0");
        for bad in [unsorted, nested, unknown, empty, extra, assets, duplicate] {
            assert!(
                validate_marketplace_package(&bad).is_err(),
                "accepted {bad}"
            );
        }
    }

    #[test]
    fn a_consumed_plugin_may_carry_a_member_of_a_newer_kind() {
        let mut value = plugin("1.0.0");
        value["package"]["contributes"][1] = json!({"kind":"skill","package":{"skill":{}}});
        let mut errors = Diagnostics::default();
        crate::marketplace::validate_with(&value, "package", Rules::Consume, &mut errors);
        assert!(errors.is_empty(), "{:?}", errors.into_messages());
        let packages = [value];
        assert_eq!(catalog_members(&packages).count(), 1);
    }
}
