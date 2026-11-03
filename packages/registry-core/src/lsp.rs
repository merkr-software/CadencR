//! Language-server catalog validation and the verified archive boundary.
use crate::{
    diagnostics::Diagnostics, marketplace::Rules, LspDescriptor, LspRuntime, LspTarget,
    RegistryError,
};
use cadencr_plugin_core::tab::{check_backend_bytes, TabPlatform};
use serde_json::Value;
use std::collections::HashSet;

mod archive;
mod pack;
pub use archive::{read_lsp_archive, validate_lsp_entry};
pub use pack::{pack_lsp, PackLspRequest, PackedLsp};
pub const MAX_LSP_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_LSP_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) fn invalid(message: impl Into<String>) -> RegistryError {
    RegistryError::single(format!("invalid LSP package: {}", message.into()))
}

pub(crate) fn validate(content: &Value, label: &str, rules: Rules, errors: &mut Diagnostics) {
    let Some(object) = content.as_object() else {
        errors.push(format!("{label}.package must be an object"));
        return;
    };
    crate::package::reject_unknown(object, &["lsp", "host"], label, errors);
    crate::marketplace::validate_theme_host(content, label, errors);
    let Some(descriptor) = content.get("lsp").and_then(Value::as_object) else {
        errors.push(format!("{label}.lsp must be an object"));
        return;
    };
    crate::marketplace::validate_descriptor_text(descriptor, &format!("{label}.lsp"), errors);
    let mut normalized = Value::Object(descriptor.clone());
    if rules == Rules::Consume {
        // Bounded future declarations remain consumable; resolution refuses them.
        if normalized["protocol_version"]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= u32::MAX as u64)
        {
            normalized["protocol_version"] = Value::from(1);
        }
        if let Some(targets) = normalized
            .pointer_mut("/distribution/binary")
            .and_then(Value::as_object_mut)
        {
            for target in targets.values_mut() {
                if target["runtime"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 64)
                    && target["runtime"] != "native"
                    && target["runtime"] != "node"
                {
                    target["runtime"] = Value::from("native");
                }
            }
        }
    }
    match serde_json::from_value::<LspDescriptor>(normalized) {
        Ok(parsed) => {
            if let Err(error) = validate_descriptor(&parsed, rules) {
                errors.push(format!("{label}.lsp: {error}"));
            }
        }
        Err(error) => errors.push(format!("{label}.lsp: {error}")),
    }
}

fn validate_descriptor(descriptor: &LspDescriptor, rules: Rules) -> Result<(), RegistryError> {
    if !crate::valid_theme_id(&descriptor.id) || descriptor.protocol_version != 1 {
        return Err(invalid("invalid id or unsupported protocol_version"));
    }
    if descriptor.languages.is_empty() || descriptor.languages.len() > 128 {
        return Err(invalid("languages must contain 1 to 128 associations"));
    }
    let mut ids = HashSet::new();
    for language in &descriptor.languages {
        if !token(&language.id) || !ids.insert(&language.id) {
            return Err(invalid("language ids must be unique bounded tokens"));
        }
        strings(&language.extensions, 128, |s| {
            basename(s) && !s.starts_with('.')
        })?;
        strings(&language.filenames, 128, basename)?;
        if language.extensions.is_empty() && language.filenames.is_empty() {
            return Err(invalid(
                "each language must declare extensions or filenames",
            ));
        }
    }
    strings(&descriptor.root_markers, 128, basename)?;
    if descriptor.args.len() > 128
        || descriptor
            .args
            .iter()
            .any(|s| s.len() > 4096 || s.contains('\0'))
    {
        return Err(invalid("invalid or excessive arguments"));
    }
    if !descriptor.initialization_options.is_object()
        || serde_json::to_vec(&descriptor.initialization_options)
            .map_err(|e| invalid(e.to_string()))?
            .len()
            > 64 * 1024
    {
        return Err(invalid(
            "initialization_options must be an object of at most 64 KiB",
        ));
    }
    let targets = &descriptor.distribution.binary;
    if targets.is_empty() || targets.len() > 16 {
        return Err(invalid("binary must contain 1 to 16 targets"));
    }
    for (platform, target) in targets {
        if !token(platform) || rules == Rules::Publish && TabPlatform::parse(platform).is_none() {
            return Err(invalid(format!("unsupported platform {platform}")));
        }
        validate_target(target, descriptor.distribution.repository.as_ref())?;
    }
    Ok(())
}

pub(crate) fn validate_target(
    target: &LspTarget,
    repository: Option<&String>,
) -> Result<(), RegistryError> {
    let explicit = repository.map(|s| Value::from(s.clone()));
    crate::theme_distribution_repository(&target.archive, explicit.as_ref())?;
    if !crate::digest::is_lower_sha256(&target.sha256)
        || !crate::digest::is_lower_sha256(&target.entry_sha256)
        || target.size == 0
        || target.size > MAX_LSP_ARCHIVE_BYTES
        || target.entry_size == 0
        || target.entry_size > MAX_LSP_UNCOMPRESSED_BYTES
        || !safe_path(&target.entry)
    {
        return Err(invalid("invalid target digest, size or entry path"));
    }
    if target.runtime == LspRuntime::Node
        && ![".js", ".cjs", ".mjs"]
            .iter()
            .any(|suffix| target.entry.ends_with(suffix))
    {
        return Err(invalid("Node entry must end in .js, .cjs or .mjs"));
    }
    Ok(())
}

/// Resolve only a supported target. Unknown future catalog declarations cannot
/// be installed or launched by this host.
pub fn signed_lsp_target(package: &Value, platform: &str) -> Result<LspTarget, RegistryError> {
    let wrapped;
    let package = if package.get("kind").is_none() {
        wrapped = serde_json::json!({"kind":"lsp","package":package});
        &wrapped
    } else {
        package
    };
    let mut errors = Diagnostics::default();
    crate::marketplace::validate_with(package, "package", Rules::Consume, &mut errors);
    if !errors.is_empty() {
        return Err(RegistryError::from_messages(errors.into_messages()));
    }
    if package["kind"] != "lsp"
        || package.pointer("/package/lsp/protocol_version") != Some(&Value::from(1))
        || TabPlatform::parse(platform).is_none()
    {
        return Err(invalid("unsupported kind, protocol or platform"));
    }
    let target = package
        .pointer("/package/lsp/distribution/binary")
        .and_then(|v| v.get(platform))
        .ok_or_else(|| invalid(format!("no target for {platform}")))?;
    serde_json::from_value(target.clone()).map_err(|e| invalid(e.to_string()))
}

fn strings(
    values: &[String],
    max: usize,
    valid: impl Fn(&str) -> bool,
) -> Result<(), RegistryError> {
    let mut seen = HashSet::new();
    if values.len() > max || values.iter().any(|s| !valid(s) || !seen.insert(s)) {
        return Err(invalid("invalid, duplicate or excessive strings"));
    }
    Ok(())
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-+".contains(&b))
}
fn basename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
}
pub(crate) fn safe_path(value: &str) -> bool {
    !value.is_empty() && value.len() <= 240 && value.split('/').all(basename)
}
pub(crate) fn native(bytes: &[u8], platform: &str) -> Result<(), RegistryError> {
    let platform = TabPlatform::parse(platform).ok_or_else(|| invalid("unsupported platform"))?;
    check_backend_bytes(bytes, platform).map_err(|e| invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn package() -> Value {
        serde_json::from_str(include_str!(
            "../../../tooling/marketplace-registry/examples/lsp/package.node.json"
        ))
        .unwrap()
    }

    #[test]
    fn typed_metadata_and_both_target_boundaries_preserve_language_associations() {
        let value = package();
        let crate::MarketplacePackage::Lsp(parsed) =
            crate::parse_marketplace_package(&value).unwrap()
        else {
            panic!("wrong kind")
        };
        assert_eq!(parsed.lsp.languages[0].id, "typescript");
        assert_eq!(parsed.lsp.languages[1].extensions, ["tsx"]);
        let target = signed_lsp_target(&value, "linux-x86_64").unwrap();
        assert_eq!(
            target,
            signed_lsp_target(&value["package"], "linux-x86_64").unwrap()
        );
        assert_eq!(target.runtime, LspRuntime::Node);
    }

    #[test]
    fn future_catalog_declarations_are_visible_but_not_installable() {
        for (path, replacement) in [
            ("/package/lsp/protocol_version", json!(2)),
            (
                "/package/lsp/distribution/binary/linux-x86_64/runtime",
                json!("future-runtime"),
            ),
        ] {
            let mut value = package();
            *value.pointer_mut(path).unwrap() = replacement;
            let mut errors = Diagnostics::default();
            crate::marketplace::validate_with(&value, "entry", Rules::Consume, &mut errors);
            assert!(errors.is_empty(), "{:?}", errors.into_messages());
            assert!(crate::validate_marketplace_package(&value).is_err());
            assert!(signed_lsp_target(&value, "linux-x86_64").is_err());
        }
        let mut value = package();
        let target = value["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"].take();
        value["package"]["lsp"]["distribution"]["binary"] = json!({"linux-aarch64":target});
        let mut errors = Diagnostics::default();
        crate::marketplace::validate_with(&value, "entry", Rules::Consume, &mut errors);
        assert!(errors.is_empty());
        assert!(signed_lsp_target(&value, "linux-aarch64").is_err());
    }

    #[test]
    fn publication_rejects_ambiguous_or_unbounded_launch_metadata() {
        for (path, replacement) in [
            ("/package/lsp/languages", json!([])),
            ("/package/lsp/languages/0/extensions", json!([".ts"])),
            (
                "/package/lsp/languages/0/filenames",
                json!(["../tsconfig.json"]),
            ),
            ("/package/lsp/languages/1/id", json!("typescript")),
            ("/package/lsp/root_markers", json!([".git", ".git"])),
            ("/package/lsp/args", json!(["bad\0argument"])),
            ("/package/lsp/initialization_options", json!([])),
            (
                "/package/lsp/distribution/binary/linux-x86_64/entry",
                json!("../server.js"),
            ),
            (
                "/package/lsp/distribution/binary/linux-x86_64/entry_sha256",
                json!("E".repeat(64)),
            ),
            (
                "/package/lsp/distribution/binary/linux-x86_64/size",
                json!(MAX_LSP_ARCHIVE_BYTES + 1),
            ),
        ] {
            let mut value = package();
            *value.pointer_mut(path).unwrap() = replacement;
            assert!(
                crate::validate_marketplace_package(&value).is_err(),
                "accepted {path}"
            );
        }
        let mut unknown = package();
        unknown["package"]["lsp"]["install"] = json!("npm install");
        assert!(crate::validate_marketplace_package(&unknown).is_err());
    }

    #[test]
    fn submissions_and_plugin_members_mirror_every_lsp_target_and_bind_source() {
        let mut submission: Value = serde_json::from_str(include_str!(
            "../../../tooling/marketplace-registry/examples/lsp/submission.node.json"
        ))
        .unwrap();
        crate::validate_submission(&submission).unwrap();
        let plan = crate::create_publication_plan(&submission, "cadencr/registry").unwrap();
        crate::validate_marketplace_package(&plan["mirrored_package"]).unwrap();
        assert_eq!(plan["targets"][0]["target"], "linux-x86_64");
        assert_eq!(
            plan["mirrored_package"]["package"]["lsp"]["repository"],
            submission["source"]["repository"]
        );
        submission["source"]["tag"] = json!("different-tag");
        assert!(crate::validate_submission(&submission).is_err());

        let mut plugin = crate::plugin_package::tests::full_submission();
        let mut member = package();
        member["package"]["lsp"]["repository"] = plugin["source"]["repository"].clone();
        member["package"]["lsp"]["distribution"]["binary"]["linux-x86_64"]["archive"] =
            json!(format!(
                "{}/releases/download/{}/server.tar.gz",
                plugin["source"]["repository"].as_str().unwrap(),
                plugin["source"]["tag"].as_str().unwrap()
            ));
        member["package"]["host"] = plugin["package"]["package"]["host"].clone();
        let members = plugin["package"]["package"]["contributes"]
            .as_array_mut()
            .unwrap();
        members.insert(0, member);
        crate::validate_submission(&plugin).unwrap();
        let plan = crate::create_publication_plan(&plugin, "cadencr/registry").unwrap();
        assert_eq!(
            plan["targets"][0]["target"],
            "lsp:example-language-server:linux-x86_64"
        );
        crate::validate_marketplace_package(&plan["mirrored_package"]).unwrap();
        let packages = [plan["mirrored_package"].clone()];
        assert_eq!(crate::catalog_members(&packages).count(), 4);
    }
}
