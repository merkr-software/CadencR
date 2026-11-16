use crate::RegistryError;
use serde_json::{json, Value};

pub(crate) fn create(submission: &Value, repository: &str) -> Result<Value, RegistryError> {
    let entry = &submission["package"];
    if crate::marketplace::kind(entry) == "provider" {
        let mut legacy = submission.clone();
        legacy["schema_version"] = json!(1);
        legacy["package"] = entry["package"].clone();
        let mut plan = crate::create_publication_plan(&legacy, repository)?;
        plan["schema_version"] = json!(2);
        plan["source"]["submission"] = submission.clone();
        plan["mirrored_package"] =
            json!({"kind":"provider","package":plan["mirrored_package"].clone()});
        return Ok(plan);
    }
    let kind = crate::marketplace::kind(entry);
    let (id, version) = crate::marketplace::marketplace_package_identity(entry)
        .ok_or_else(|| RegistryError::single(format!("invalid {kind} identity")))?;
    let tag = format!("{kind}-{id}-v{version}");
    let release = format!("https://github.com/{repository}/releases/download/{tag}");
    let mirrored = if kind == crate::PLUGIN_KIND {
        mirror_plugin(entry, repository, &tag, &release)?
    } else {
        mirror_member(entry, repository, &release, &Prefix::default())?
    };
    Ok(json!({
        "schema_version":2,"repository":repository,
        "source":{"submission":submission,"identity":{"provider_id":id,"version":version,
            "repository":submission["source"]["repository"],"commit":submission["source"]["commit"],"tag":submission["source"]["tag"]}},
        "release":{"tag":tag},
        "targets":mirrored.targets,
        "mirrored_package":mirrored.package
    }))
}

/// A mirrored entry and the release assets it now points at.
struct Mirrored {
    targets: Vec<Value>,
    package: Value,
}

/// How a plugin member's targets and assets are told apart inside the one
/// plugin release: target `<kind>:<id>:<member target>`, asset
/// `<kind>-<id>-<member asset>`. Empty for a standalone package.
#[derive(Default)]
struct Prefix {
    target: String,
    asset: String,
}

/// The member a plugin publication target names: `(kind, id, member target)`.
pub fn split_plugin_target(target: &str) -> Option<(&str, &str, &str)> {
    let mut parts = target.splitn(3, ':');
    Some((parts.next()?, parts.next()?, parts.next()?))
}

/// The kind of a plugin member's web archive asset (`<kind>-<id>-<kind>.tar.gz`
/// for a theme or tab), or `None` for any other asset.
pub fn plugin_web_archive_kind(asset: &str) -> Option<&'static str> {
    ["theme", "tab"].into_iter().find(|kind| {
        asset
            .strip_prefix(&format!("{kind}-"))
            .and_then(|rest| rest.strip_suffix(&format!("-{kind}.tar.gz")))
            .is_some_and(|id| !id.is_empty())
    })
}

impl Prefix {
    fn member(entry: &Value) -> Result<Self, RegistryError> {
        let kind = crate::marketplace::kind(entry);
        let (id, _) = crate::marketplace::marketplace_package_identity(entry)
            .ok_or_else(|| RegistryError::single(format!("invalid {kind} member identity")))?;
        Ok(Self {
            target: format!("{kind}:{id}:"),
            asset: format!("{kind}-{id}-"),
        })
    }
    fn target(
        &self,
        target: &str,
        asset: &str,
        release: &str,
        source: &Value,
        sha256: &Value,
    ) -> Value {
        let asset = format!("{}{asset}", self.asset);
        json!({"target":format!("{}{target}", self.target),"asset":asset,"source_url":source,
            "destination_url":format!("{release}/{asset}"),"sha256":sha256})
    }
}

fn mirror_plugin(
    entry: &Value,
    repository: &str,
    tag: &str,
    release: &str,
) -> Result<Mirrored, RegistryError> {
    let mut targets = Vec::new();
    let mut members = Vec::new();
    for member in crate::plugin_members(entry) {
        let prefix = Prefix::member(member)?;
        let mirrored = if crate::marketplace::kind(member) == "provider" {
            mirror_provider(member, repository, tag, release, &prefix)?
        } else {
            mirror_member(member, repository, release, &prefix)?
        };
        targets.extend(mirrored.targets);
        members.push(mirrored.package);
    }
    let mut package = entry.clone();
    package["package"]["contributes"] = Value::Array(members);
    Ok(Mirrored { targets, package })
}

/// A provider member: one asset per binary target, named like a standalone
/// provider's (`<target>-<sha256><suffix>`).
fn mirror_provider(
    member: &Value,
    repository: &str,
    tag: &str,
    release: &str,
    prefix: &Prefix,
) -> Result<Mirrored, RegistryError> {
    let mut package = member.clone();
    let binary = package
        .pointer_mut("/package/agent/distribution/binary")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| RegistryError::single("validated provider member binary is missing"))?;
    // Platform order, like a standalone provider plan, whatever the map order.
    let mut names = binary.keys().cloned().collect::<Vec<_>>();
    names.sort_unstable();
    let mut targets = Vec::new();
    for name in names {
        let distribution = binary
            .get_mut(&name)
            .ok_or_else(|| RegistryError::single("validated provider member target is missing"))?;
        let plain = crate::publication_plan::mirror_target(&name, distribution, repository, tag)?;
        let target = prefix.target(
            &name,
            plain["asset"].as_str().unwrap_or_default(),
            release,
            &plain["source_url"],
            &plain["sha256"],
        );
        distribution["archive"] = target["destination_url"].clone();
        targets.push(target);
    }
    Ok(Mirrored { targets, package })
}

/// A theme or tab: its web archive, then a tab's backend archives in
/// platform order.
fn mirror_member(
    entry: &Value,
    repository: &str,
    release: &str,
    prefix: &Prefix,
) -> Result<Mirrored, RegistryError> {
    let kind = crate::marketplace::kind(entry);
    if kind == "lsp" {
        return mirror_lsp(entry, repository, release, prefix);
    }
    let distribution = &entry["package"][kind]["distribution"];
    let source_url = distribution["archive"]
        .as_str()
        .ok_or_else(|| RegistryError::single(format!("missing {kind} archive")))?;
    if !source_url.ends_with(".tar.gz") && !source_url.ends_with(".tgz") {
        return Err(RegistryError::single(format!(
            "{kind} archives must be gzip tar archives"
        )));
    }
    let web = prefix.target(
        kind,
        &format!("{kind}.tar.gz"),
        release,
        &distribution["archive"],
        &distribution["sha256"],
    );
    let mut mirrored = entry.clone();
    let descriptor = &mut mirrored["package"][kind];
    descriptor["distribution"]["archive"] = web["destination_url"].clone();
    descriptor["distribution"]["repository"] = json!(format!("https://github.com/{repository}"));
    let mut targets = vec![web];
    let backend = match kind {
        "tab" => crate::signed_tab_backend(entry)?,
        _ => None,
    };
    for (platform, target) in backend.iter().flat_map(|backend| &backend.targets) {
        let sha256 = &target.sha256;
        let planned = prefix.target(
            &crate::tab_backend::plan_target(*platform),
            &format!("backend-{platform}-{sha256}.tar.gz"),
            release,
            &json!(target.archive),
            &json!(sha256),
        );
        mirrored["package"][kind]["distribution"]["binary"][platform.as_str()]["archive"] =
            planned["destination_url"].clone();
        targets.push(planned);
    }
    Ok(Mirrored {
        targets,
        package: mirrored,
    })
}

fn mirror_lsp(
    entry: &Value,
    repository: &str,
    release: &str,
    prefix: &Prefix,
) -> Result<Mirrored, RegistryError> {
    let binary = entry
        .pointer("/package/lsp/distribution/binary")
        .and_then(Value::as_object)
        .ok_or_else(|| RegistryError::single("LSP targets missing"))?;
    let mut package = entry.clone();
    let mut targets = Vec::new();
    for platform in binary.keys() {
        let signed = crate::signed_lsp_target(entry, platform)?;
        let planned = prefix.target(
            platform,
            &format!("{platform}-{}.tar.gz", signed.sha256),
            release,
            &json!(signed.archive),
            &json!(signed.sha256),
        );
        package["package"]["lsp"]["distribution"]["binary"][platform]["archive"] =
            planned["destination_url"].clone();
        targets.push(planned);
    }
    package["package"]["lsp"]["distribution"]["repository"] =
        json!(format!("https://github.com/{repository}"));
    Ok(Mirrored { targets, package })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mirrored_distribution_preserves_third_party_author_provenance() {
        let submission = json!({"package":{"kind":"theme","package":{"theme":{
            "id":"midnight","version":"1.0.0","repository":"https://github.com/author/themes",
            "distribution":{"archive":"https://github.com/author/themes/releases/download/v1/theme.tar.gz","sha256":"a".repeat(64)}
        }}},"source":{"repository":"author/themes","commit":"abc","tag":"v1"}});
        let plan = create(&submission, "cadencr/registry").unwrap();
        let theme = &plan["mirrored_package"]["package"]["theme"];
        assert_eq!(theme["repository"], "https://github.com/author/themes");
        assert_eq!(
            theme["distribution"]["repository"],
            "https://github.com/cadencr/registry"
        );
        assert_eq!(
            crate::theme_distribution_repository(
                theme["distribution"]["archive"].as_str().unwrap(),
                theme["distribution"].get("repository")
            )
            .unwrap(),
            "https://github.com/cadencr/registry"
        );
    }

    #[test]
    fn a_plugin_publishes_every_member_in_one_release() {
        let submission = crate::plugin_package::tests::full_submission();
        crate::validate_submission(&submission).unwrap();
        let plan = create(&submission, "cadencr/registry").unwrap();
        assert_eq!(plan["release"]["tag"], "plugin-aurora-v1.0.0");
        let targets = plan["targets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| (t["target"].as_str().unwrap(), t["asset"].as_str().unwrap()))
            .collect::<Vec<_>>();
        let provider_asset = format!(
            "provider-aurora-agent-darwin-aarch64-{}.tar.gz",
            "c".repeat(64)
        );
        assert_eq!(
            targets,
            [
                (
                    "provider:aurora-agent:darwin-aarch64",
                    provider_asset.as_str()
                ),
                ("tab:aurora-tab:tab", "tab-aurora-tab-tab.tar.gz"),
                (
                    "theme:aurora-theme:theme",
                    "theme-aurora-theme-theme.tar.gz"
                ),
            ]
        );
        let release = "https://github.com/cadencr/registry/releases/download/plugin-aurora-v1.0.0";
        let mirrored = &plan["mirrored_package"];
        let members = &mirrored["package"]["contributes"];
        assert_eq!(
            members[0]["package"]["agent"]["distribution"]["binary"]["darwin-aarch64"]["archive"],
            format!("{release}/{provider_asset}")
        );
        assert_eq!(
            members[2]["package"]["theme"]["distribution"]["archive"],
            format!("{release}/theme-aurora-theme-theme.tar.gz")
        );
        assert_eq!(
            members[1]["package"]["tab"]["distribution"]["repository"],
            "https://github.com/cadencr/registry"
        );
        crate::validate_marketplace_package(mirrored).unwrap();
    }

    #[test]
    fn plugin_submissions_bind_every_member_to_the_source_release() {
        let submission = crate::plugin_package::tests::full_submission();
        let mut elsewhere = submission.clone();
        elsewhere["package"]["package"]["contributes"][2]["package"]["theme"]["distribution"]
            ["archive"] = json!("https://github.com/acme/aurora/releases/download/v2/theme.tar.gz");
        let mut provider_rules = submission.clone();
        provider_rules["package"]["package"]["contributes"][0]["package"]["host"]["assets"]
            .as_object_mut()
            .unwrap()
            .remove("readme");
        let mut reserved = submission;
        reserved["package"]["package"]["contributes"][0]["package"]["agent"]["id"] = json!("codex");
        for bad in [elsewhere, provider_rules, reserved] {
            assert!(crate::validate_submission(&bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn provider_member_targets_follow_platform_order() {
        let mut submission = crate::plugin_package::tests::full_submission();
        let binary = &mut submission["package"]["package"]["contributes"][0]["package"]["agent"]
            ["distribution"]["binary"];
        let darwin = binary["darwin-aarch64"].clone();
        let mut linux = darwin.clone();
        linux["archive"] = json!(darwin["archive"]
            .as_str()
            .unwrap()
            .replace("darwin-aarch64", "linux-x86_64"));
        *binary = json!({"linux-x86_64": linux, "darwin-aarch64": darwin});
        let plan = create(&submission, "cadencr/registry").unwrap();
        let providers = plan["targets"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["target"].as_str().filter(|t| t.starts_with("provider:")))
            .collect::<Vec<_>>();
        assert_eq!(
            providers,
            [
                "provider:aurora-agent:darwin-aarch64",
                "provider:aurora-agent:linux-x86_64"
            ]
        );
        assert_eq!(
            crate::split_plugin_target(providers[1]),
            Some(("provider", "aurora-agent", "linux-x86_64"))
        );
    }
}
