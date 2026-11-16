//! Binding the signed backend to the `tab.json` inside the web archive.
use std::collections::{BTreeMap, BTreeSet};

use cadencr_plugin_core::tab::{TabManifest, MANIFEST_FILE_NAME};

use super::{invalid, SignedTabBackend};
use crate::RegistryError;

/// `tab.json`'s `backend` and the signed one say the same thing: both present
/// or both absent, equal `protocol` and `reasoning`, the same platform set,
/// and each `binary[p].cmd` equal to `backend.binary[p]` — at a path outside
/// the web archive's files.
pub(crate) fn bind(
    manifest: &TabManifest,
    signed: Option<&SignedTabBackend>,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), RegistryError> {
    let (local, signed) = match (manifest.backend.as_ref(), signed) {
        (None, None) => return Ok(()),
        (Some(_), None) => {
            return Err(invalid(
                "tab.json declares a native `backend` that the signed metadata does not (no tab.backend and tab.distribution.binary)",
            ))
        }
        (None, Some(_)) => {
            return Err(invalid(
                "the signed metadata declares a native backend that tab.json does not",
            ))
        }
        (Some(local), Some(signed)) => (local, signed),
    };
    if local.protocol != signed.protocol {
        return Err(invalid(
            "signed tab.backend.protocol differs from tab.json backend.protocol",
        ));
    }
    if local.reasoning.as_deref() != Some(signed.reasoning.as_str()) {
        return Err(invalid(
            "signed tab.backend.reasoning differs from tab.json backend.reasoning",
        ));
    }
    let declared: BTreeSet<&str> = local.platform_keys().collect();
    let shipped: BTreeSet<&str> = signed.targets.keys().map(|p| p.as_str()).collect();
    if declared != shipped {
        return Err(invalid(format!(
            "signed backend platforms ({}) differ from tab.json backend.binary ({})",
            join(&shipped),
            join(&declared)
        )));
    }
    for (platform, target) in &signed.targets {
        if local.binary_for(*platform) != Some(target.cmd.as_str()) {
            return Err(invalid(format!(
                "tab.distribution.binary.{platform}.cmd must equal tab.json backend.binary.{platform}"
            )));
        }
        check_cmd_location(manifest, &target.cmd)?;
        if let Some(name) = files.keys().find(|name| overlaps(name, &target.cmd)) {
            return Err(invalid(format!(
                "backend executable `{}` collides with web archive file `{name}`",
                target.cmd
            )));
        }
    }
    Ok(())
}

/// A backend executable ships in its own archive: never at `tab.json`, the
/// icon, or under the compiled web root (which the asset route serves).
/// Compared case-insensitively, as macOS's default file system resolves
/// `Dist/x` and `dist/x` to the same file.
pub(crate) fn check_cmd_location(manifest: &TabManifest, cmd: &str) -> Result<(), RegistryError> {
    let web_root = manifest.entry.rsplit_once('/').map(|(root, _)| root);
    if overlaps(cmd, MANIFEST_FILE_NAME)
        || manifest
            .icon
            .as_deref()
            .is_some_and(|icon| overlaps(icon, cmd))
        || web_root.is_some_and(|root| overlaps(root, cmd))
    {
        return Err(invalid(format!(
            "backend executable `{cmd}` must live outside tab.json, the icon and the web root{}: it ships in its own archive, never in the web archive",
            web_root.map(|root| format!(" `{root}/`")).unwrap_or_default()
        )));
    }
    Ok(())
}

/// Whether one path is the other or lies inside it, ignoring case (a
/// case-insensitive file system makes `Bin/x` and `bin/x` one file).
fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    a == b || b.starts_with(&format!("{a}/")) || a.starts_with(&format!("{b}/"))
}

fn join(set: &BTreeSet<&str>) -> String {
    if set.is_empty() {
        return "none".into();
    }
    set.iter().copied().collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::super::tests::{cmd, manifest_json, package, REASONING};
    use crate::validate_tab_package_binding;

    fn files(manifest: &Value) -> std::collections::BTreeMap<String, Vec<u8>> {
        std::collections::BTreeMap::from([
            ("tab.json".to_owned(), serde_json::to_vec(manifest).unwrap()),
            ("dist/index.html".to_owned(), b"<html></html>".to_vec()),
        ])
    }

    fn bound(manifest: &Value, package: &Value) -> Result<(), String> {
        validate_tab_package_binding(&package["package"], &files(manifest))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    #[test]
    fn the_signed_backend_must_say_what_tab_json_says() {
        let (manifest, package) = (manifest_json(), package());
        let (_, backend) =
            validate_tab_package_binding(&package["package"], &files(&manifest)).unwrap();
        assert_eq!(backend.unwrap().targets.len(), 3);
        let mut other = manifest.clone();
        other["backend"]["reasoning"] = json!("Something else entirely.");
        assert!(bound(&other, &package).unwrap_err().contains("reasoning"));
        let mut fewer = manifest.clone();
        fewer["backend"]["binary"]
            .as_object_mut()
            .unwrap()
            .remove("darwin-x86_64");
        assert!(bound(&fewer, &package).unwrap_err().contains("platforms"));
        let mut moved = manifest.clone();
        moved["backend"]["binary"]["linux-x86_64"] = json!("bin/elsewhere");
        assert!(bound(&moved, &package)
            .unwrap_err()
            .contains(".cmd must equal"));
        let mut ui_only = manifest.clone();
        ui_only.as_object_mut().unwrap().remove("backend");
        assert!(bound(&ui_only, &package)
            .unwrap_err()
            .contains("tab.json does not"));
        let mut unsigned = package.clone();
        let tab = unsigned["package"]["tab"].as_object_mut().unwrap();
        tab.remove("backend");
        tab["distribution"]
            .as_object_mut()
            .unwrap()
            .remove("binary");
        assert!(bound(&manifest, &unsigned)
            .unwrap_err()
            .contains("signed metadata does not"));
        assert_eq!(bound(&ui_only, &unsigned), Ok(()));
        assert_eq!(REASONING, manifest["backend"]["reasoning"]);
    }

    #[test]
    fn executables_stay_out_of_the_web_archive() {
        for location in ["dist/port-monitor", "dist", "tab.json", "icon.svg/x"] {
            let mut manifest = manifest_json();
            manifest["icon"] = json!("icon.svg");
            manifest["backend"]["binary"]["linux-x86_64"] = json!(location);
            let mut package = package();
            package["package"]["tab"]["distribution"]["binary"]["linux-x86_64"]["cmd"] =
                json!(location);
            let mut files = files(&manifest);
            files.insert("icon.svg".into(), b"<svg></svg>".to_vec());
            let result = validate_tab_package_binding(&package["package"], &files);
            assert!(result.is_err(), "{location}");
        }
        assert_eq!(cmd("linux-x86_64"), "bin/linux-x86_64/port-monitor");
    }

    #[test]
    fn collisions_ignore_case() {
        for location in ["DIST/port-monitor", "Dist", "TAB.JSON", "Icon.SVG"] {
            let mut manifest = manifest_json();
            manifest["icon"] = json!("icon.svg");
            manifest["backend"]["binary"]["linux-x86_64"] = json!(location);
            let mut package = package();
            package["package"]["tab"]["distribution"]["binary"]["linux-x86_64"]["cmd"] =
                json!(location);
            let mut files = files(&manifest);
            files.insert("icon.svg".into(), b"<svg></svg>".to_vec());
            let error = validate_tab_package_binding(&package["package"], &files)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("must live outside") || error.contains("other than tab.json"),
                "{location}: {error}"
            );
        }
    }
}
