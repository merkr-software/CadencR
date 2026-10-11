//! Declarative, platform-independent theme packaging using the shared writer.
use std::path::{Path, PathBuf};

use crate::{archive, RegistryError};
use cadencr_plugin_core::theme::validate_theme_folder;

#[derive(bon::Builder)]
pub struct PackThemeRequest<'a> {
    pub directory: &'a Path,
    pub output: &'a Path,
}

#[derive(Debug)]
pub struct PackedTheme {
    pub archive: PathBuf,
    pub sha256: String,
    pub size: u64,
}

pub fn pack_theme(request: PackThemeRequest<'_>) -> Result<PackedTheme, RegistryError> {
    archive::validate_output_name(request.output)?;
    let snapshot = archive::scan::collect(request.directory)?;
    let theme = validate_theme_folder(request.directory).map_err(|issues| {
        RegistryError::from_messages(
            issues
                .iter()
                .map(cadencr_plugin_core::theme::ThemeIssue::describe)
                .collect(),
        )
    })?;
    if snapshot.entries.len() != theme.files.len()
        || snapshot.entries.iter().any(|entry| {
            entry.directory
                || cfg!(unix) && entry.executable
                || !entry
                    .relative
                    .to_str()
                    .is_some_and(|name| theme.files.contains_key(name))
        })
    {
        return Err(RegistryError::from_messages(vec![
            "theme staging must contain exactly theme.json and its declared raster assets, with no executable bits".into()
        ]));
    }
    let built = archive::write::declarative_archive(&snapshot, request.output)?;
    Ok(PackedTheme {
        archive: request.output.into(),
        sha256: built.sha256,
        size: built.size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn document() -> Value {
        use cadencr_plugin_core::theme::{schema, tokens};
        let mut vars = serde_json::Map::new();
        for token in tokens::REQUIRED_TOKENS {
            vars.insert((*token).into(), json!("#000000"));
        }
        for pair in tokens::CONTRAST_PAIRS {
            vars.insert(pair.foreground.into(), json!("#ffffff"));
        }
        let contract: Value = serde_json::from_str(&schema::render()).unwrap();
        let xterm = contract["properties"]["xterm"]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(|key| (key.clone(), json!("#ffffff")))
            .collect::<serde_json::Map<_, _>>();
        json!({"label":"Theme", "appearance":"dark", "cssVars":vars, "xterm":xterm})
    }

    #[test]
    fn deterministic_closed_archives_refuse_overwrite_scripts_and_executable_bits() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("theme");
        std::fs::create_dir(&directory).unwrap();
        let mut theme = document();
        // Frontend source themes use the same declared vocabulary; this fixture
        // omits optional legacy packaging annotations at the distributed boundary.
        theme.as_object_mut().unwrap().retain(|name, _| {
            [
                "label",
                "appearance",
                "cssVars",
                "xterm",
                "chrome",
                "$schema",
            ]
            .contains(&name.as_str())
        });
        std::fs::write(
            directory.join("theme.json"),
            serde_json::to_vec(&theme).unwrap(),
        )
        .unwrap();
        let first = root.path().join("first.tar.gz");
        let second = root.path().join("second.tar.gz");
        let pack = |output: &Path| {
            pack_theme(
                PackThemeRequest::builder()
                    .directory(&directory)
                    .output(output)
                    .build(),
            )
        };
        let a = pack(&first).unwrap();
        let b = pack(&second).unwrap();
        assert_eq!(a.sha256, b.sha256);
        let mut tar = Vec::new();
        std::io::Read::read_to_end(
            &mut flate2::read::GzDecoder::new(std::fs::File::open(&first).unwrap()),
            &mut tar,
        )
        .unwrap();
        assert_eq!(&tar[100..108], b"0000644\0");
        assert!(pack(&first).is_err());
        std::fs::write(directory.join("script.js"), json!("evil").to_string()).unwrap();
        assert!(pack(&root.path().join("bad.tar.gz")).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::remove_file(directory.join("script.js")).unwrap();
            std::fs::set_permissions(
                directory.join("theme.json"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
            assert!(pack(&root.path().join("executable.tar.gz")).is_err());
        }
    }
}
