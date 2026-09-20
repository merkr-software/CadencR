use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::fs::read_bounded;
use crate::PublisherError;

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_PUBLICATIONS: usize = 100;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub(super) schema_version: u64,
    pub(super) repository: String,
    pub(super) publications: Vec<Publication>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Publication {
    pub(super) submission: String,
    pub(super) directory: String,
    pub(super) registry_commit: String,
}

pub(super) fn read_manifest(path: &Path) -> Result<Manifest, PublisherError> {
    let bytes = read_bounded(path, MAX_MANIFEST_BYTES, "publication manifest")?;
    let value = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|_| PublisherError::new("publication manifest must be valid JSON"))?;
    serde_json::from_value(value)
        .map_err(|error| PublisherError::new(format!("publication manifest is invalid: {error}")))
}

pub(super) fn validate_manifest(manifest: &Manifest) -> Result<(), PublisherError> {
    if manifest.schema_version != 1 {
        return Err(PublisherError::new("manifest.schema_version must equal 1"));
    }
    if !cadencr_registry_core::valid_publication_repository(&manifest.repository) {
        return Err(PublisherError::new("manifest.repository is invalid"));
    }
    if !(1..=MAX_PUBLICATIONS).contains(&manifest.publications.len()) {
        return Err(PublisherError::new(
            "manifest.publications must contain between 1 and 100 entries",
        ));
    }
    for (position, publication) in manifest.publications.iter().enumerate() {
        for (field, value) in [
            ("submission", &publication.submission),
            ("directory", &publication.directory),
        ] {
            if value.is_empty() || value.contains('\0') {
                return Err(PublisherError::new(format!(
                    "manifest.publications[{position}].{field} must be a non-empty path"
                )));
            }
        }
        crate::validate_registry_commit(&publication.registry_commit)?;
    }
    Ok(())
}

pub(super) fn resolve_input(base: &Path, value: &str) -> PathBuf {
    let path = Path::new(value);
    lexical_normalize(if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    })
}

pub(super) fn absolute_lexical(path: &Path) -> Result<PathBuf, PublisherError> {
    let value = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| PublisherError::io("resolve publication manifest", error))?
            .join(path)
    };
    Ok(lexical_normalize(value))
}

fn lexical_normalize(path: PathBuf) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            value => output.push(value.as_os_str()),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_strict_bounded_and_paths_are_lexical() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("manifest.json");
        let valid = serde_json::json!({"schema_version":1,"repository":"cadencr/registry","publications":[{"submission":"inputs/../submission.json","directory":"./staging/../published","registry_commit":"b".repeat(40)}]});
        std::fs::write(&file, serde_json::to_vec(&valid).unwrap()).unwrap();
        let manifest = read_manifest(&file).unwrap();
        validate_manifest(&manifest).unwrap();
        assert_eq!(
            resolve_input(root.path(), &manifest.publications[0].submission),
            root.path().join("submission.json")
        );
        assert_eq!(
            resolve_input(root.path(), &manifest.publications[0].directory),
            root.path().join("published")
        );
        for invalid in [
            serde_json::json!({"schema_version":1,"repository":"cadencr/registry","publications":[],"extra":true}),
            serde_json::json!({"schema_version":1,"repository":"cadencr/registry","publications":[{"submission":"x","directory":"y","registry_commit":"b".repeat(40),"extra":true}]}),
        ] {
            std::fs::write(&file, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(read_manifest(&file).is_err());
        }
        std::fs::write(&file, vec![b'x'; MAX_MANIFEST_BYTES as usize + 1]).unwrap();
        assert!(read_manifest(&file).is_err());
    }

    #[test]
    fn manifest_semantic_matrix_is_closed() {
        let entry = |submission: &str, directory: &str, commit: &str| Publication {
            submission: submission.into(),
            directory: directory.into(),
            registry_commit: commit.into(),
        };
        for value in [
            Manifest {
                schema_version: 1,
                repository: "invalid".into(),
                publications: vec![entry("x", "y", &"b".repeat(40))],
            },
            Manifest {
                schema_version: 1,
                repository: "cadencr/registry".into(),
                publications: vec![],
            },
            Manifest {
                schema_version: 1,
                repository: "cadencr/registry".into(),
                publications: (0..101).map(|_| entry("x", "y", &"b".repeat(40))).collect(),
            },
            Manifest {
                schema_version: 1,
                repository: "cadencr/registry".into(),
                publications: vec![entry("x\0bad", "y", &"b".repeat(40))],
            },
            Manifest {
                schema_version: 1,
                repository: "cadencr/registry".into(),
                publications: vec![entry("x", "y", "B")],
            },
        ] {
            assert!(validate_manifest(&value).is_err());
        }
    }
}
