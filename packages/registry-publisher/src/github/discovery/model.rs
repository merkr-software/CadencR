use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Deserialize;
use sha1::{Digest as _, Sha1};

use super::super::validation::error;
use super::DiscoveryHead;
use crate::PublisherError;
use cadencr_registry_core::{DISCOVERY_FILENAME, MAX_DISCOVERY_BYTES};

#[derive(Deserialize)]
struct RawObject {
    #[serde(rename = "type")]
    pub(super) kind: String,
    pub(super) sha: String,
}

#[derive(Deserialize)]
pub(super) struct RawRef {
    #[serde(rename = "ref")]
    pub(super) name: String,
    object: RawObject,
}

impl RawRef {
    pub(super) fn validate(self, branch: &str) -> Result<String, PublisherError> {
        if self.name != format!("refs/heads/{branch}")
            || self.object.kind != "commit"
            || !valid_sha(&self.object.sha)
        {
            return Err(error("GitHub discovery branch response is malformed"));
        }
        Ok(self.object.sha)
    }
}

#[derive(Deserialize)]
pub(super) struct RawCommit {
    pub(super) sha: String,
    tree: RawTreePointer,
}

#[derive(Deserialize)]
pub(super) struct RawTreePointer {
    pub(super) sha: String,
}

impl RawCommit {
    pub(super) fn validate(self, expected: &str) -> Result<String, PublisherError> {
        if self.sha != expected || !valid_sha(&self.tree.sha) {
            return Err(error("GitHub discovery commit response is malformed"));
        }
        Ok(self.tree.sha)
    }
}

#[derive(Deserialize)]
pub(super) struct RawTree {
    pub(super) sha: String,
    pub(super) truncated: bool,
    pub(super) tree: Vec<serde_json::Value>,
}

#[derive(Clone, Deserialize)]
pub(super) struct RawTreeEntry {
    pub(super) mode: String,
    #[serde(rename = "type")]
    pub(super) kind: String,
    pub(super) sha: String,
    pub(super) size: usize,
}

impl RawTree {
    pub(super) fn validate(self, expected: &str) -> Result<Option<RawTreeEntry>, PublisherError> {
        if self.sha != expected || self.truncated {
            return Err(error("GitHub discovery tree response is malformed"));
        }
        let mut matches = self.tree.into_iter().filter(|entry| {
            entry
                .as_object()
                .and_then(|object| object.get("path"))
                .and_then(serde_json::Value::as_str)
                == Some(DISCOVERY_FILENAME)
        });
        let Some(entry_value) = matches.next() else {
            return Ok(None);
        };
        if matches.next().is_some() {
            return Err(error("GitHub discovery tree response is malformed"));
        }
        let entry: RawTreeEntry = serde_json::from_value(entry_value)
            .map_err(|_| error("GitHub discovery tree entry is malformed"))?;
        if entry.kind != "blob"
            || !matches!(entry.mode.as_str(), "100644" | "100755")
            || !valid_sha(&entry.sha)
            || entry.size > MAX_DISCOVERY_BYTES
        {
            return Err(error("GitHub discovery tree entry is malformed"));
        }
        Ok(Some(entry))
    }
}

#[derive(Clone, Deserialize)]
pub(super) struct RawContent {
    #[serde(rename = "type")]
    pub(super) kind: String,
    pub(super) path: String,
    pub(super) name: String,
    pub(super) encoding: String,
    pub(super) sha: String,
    pub(super) size: usize,
    pub(super) content: String,
}

impl RawContent {
    pub(super) fn validate(
        &self,
        expected: &RawTreeEntry,
    ) -> Result<DiscoveryHead, PublisherError> {
        if self.kind != "file"
            || self.path != DISCOVERY_FILENAME
            || self.name != DISCOVERY_FILENAME
            || self.encoding != "base64"
            || !valid_sha(&self.sha)
            || self.sha != expected.sha
            || self.size != expected.size
            || self.size > MAX_DISCOVERY_BYTES
        {
            return Err(error("GitHub discovery response is malformed"));
        }
        let compact = self.content.replace('\n', "");
        let bytes = STANDARD
            .decode(&compact)
            .map_err(|_| error("GitHub discovery response is malformed"))?;
        if STANDARD.encode(&bytes) != compact
            || bytes.len() != self.size
            || bytes.len() > MAX_DISCOVERY_BYTES
        {
            return Err(error("GitHub discovery response is malformed"));
        }
        let mut hash = Sha1::new();
        hash.update(format!("blob {}\0", bytes.len()));
        hash.update(&bytes);
        if crate::hex(&hash.finalize()) != self.sha {
            return Err(error("GitHub discovery blob hash does not match"));
        }
        Ok(DiscoveryHead {
            sha: self.sha.clone(),
            bytes,
        })
    }
}

pub(super) fn valid_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blob(bytes: &[u8]) -> String {
        let mut hash = Sha1::new();
        hash.update(format!("blob {}\0", bytes.len()));
        hash.update(bytes);
        crate::hex(&hash.finalize())
    }

    fn entry(bytes: &[u8]) -> RawTreeEntry {
        RawTreeEntry {
            mode: "100644".into(),
            kind: "blob".into(),
            sha: blob(bytes),
            size: bytes.len(),
        }
    }

    fn content(bytes: &[u8]) -> RawContent {
        RawContent {
            kind: "file".into(),
            path: DISCOVERY_FILENAME.into(),
            name: DISCOVERY_FILENAME.into(),
            encoding: "base64".into(),
            sha: blob(bytes),
            size: bytes.len(),
            content: STANDARD.encode(bytes),
        }
    }

    #[test]
    fn content_requires_canonical_base64_and_matching_git_blob() {
        let bytes = b"catalog\n";
        let expected = entry(bytes);
        assert_eq!(content(bytes).validate(&expected).unwrap().bytes, bytes);
        assert!(RawContent {
            content: "YQ===\n".into(),
            ..content(bytes)
        }
        .validate(&expected)
        .is_err());
    }

    #[test]
    fn ref_commit_and_tree_field_matrix_is_closed() {
        let sha = "a".repeat(40);
        assert!(valid_sha(&sha));
        assert!(!valid_sha(&"A".repeat(40)));
        for reference in [
            serde_json::json!({"ref":"refs/heads/wrong","object":{"type":"commit","sha":sha}}),
            serde_json::json!({"ref":"refs/heads/catalog","object":{"type":"tag","sha":sha}}),
            serde_json::json!({"ref":"refs/heads/catalog","object":{"type":"commit","sha":"A".repeat(40)}}),
        ] {
            assert!(serde_json::from_value::<RawRef>(reference)
                .unwrap()
                .validate("catalog")
                .is_err());
        }
        for commit in [
            serde_json::json!({"sha":"b".repeat(40),"tree":{"sha":sha}}),
            serde_json::json!({"sha":sha,"tree":{"sha":"short"}}),
        ] {
            assert!(serde_json::from_value::<RawCommit>(commit)
                .unwrap()
                .validate(&sha)
                .is_err());
        }
        let valid = serde_json::json!({"path":DISCOVERY_FILENAME,"mode":"100644","type":"blob","sha":sha,"size":0});
        for tree in [
            RawTree {
                sha: "b".repeat(40),
                truncated: false,
                tree: vec![],
            },
            RawTree {
                sha: sha.clone(),
                truncated: true,
                tree: vec![],
            },
            RawTree {
                sha: sha.clone(),
                truncated: false,
                tree: vec![valid.clone(), valid.clone()],
            },
        ] {
            assert!(tree.validate(&sha).is_err());
        }
        for (mode, kind, size) in [
            ("120000", "blob", 0),
            ("160000", "commit", 0),
            ("100644", "blob", MAX_DISCOVERY_BYTES + 1),
        ] {
            let value = serde_json::json!({"path":DISCOVERY_FILENAME,"mode":mode,"type":kind,"sha":sha,"size":size});
            assert!(RawTree {
                sha: sha.clone(),
                truncated: false,
                tree: vec![value]
            }
            .validate(&sha)
            .is_err());
        }
        let invalid_sha = serde_json::json!({"path":DISCOVERY_FILENAME,"mode":"100644","type":"blob","sha":"A".repeat(40),"size":0});
        assert!(RawTree {
            sha: sha.clone(),
            truncated: false,
            tree: vec![invalid_sha]
        }
        .validate(&sha)
        .is_err());
        for mode in ["100644", "100755"] {
            let value = serde_json::json!({"path":DISCOVERY_FILENAME,"mode":mode,"type":"blob","sha":sha,"size":0});
            assert!(RawTree {
                sha: sha.clone(),
                truncated: false,
                tree: vec![value]
            }
            .validate(&sha)
            .unwrap()
            .is_some());
        }
    }

    #[test]
    fn content_field_base64_size_and_blob_hash_matrix_is_closed() {
        let bytes = b"a";
        let expected = entry(bytes);
        for invalid in [
            RawContent {
                kind: "dir".into(),
                ..content(bytes)
            },
            RawContent {
                path: "other".into(),
                ..content(bytes)
            },
            RawContent {
                name: "other".into(),
                ..content(bytes)
            },
            RawContent {
                encoding: "utf-8".into(),
                ..content(bytes)
            },
            RawContent {
                sha: "b".repeat(40),
                ..content(bytes)
            },
            RawContent {
                size: 2,
                ..content(bytes)
            },
        ] {
            assert!(invalid.validate(&expected).is_err());
        }
        for encoded in ["YR==", "YQ==\r", "Y Q==", "YQ"] {
            assert!(
                RawContent {
                    content: encoded.into(),
                    ..content(bytes)
                }
                .validate(&expected)
                .is_err(),
                "{encoded:?}"
            );
        }
        assert!(RawContent {
            content: "Y\nQ==\n".into(),
            ..content(bytes)
        }
        .validate(&expected)
        .is_ok());
        let non_utf8 = [0xff];
        assert_eq!(
            content(&non_utf8)
                .validate(&entry(&non_utf8))
                .unwrap()
                .bytes,
            non_utf8
        );
        let boundary = vec![b'x'; MAX_DISCOVERY_BYTES];
        assert_eq!(
            content(&boundary)
                .validate(&entry(&boundary))
                .unwrap()
                .bytes
                .len(),
            MAX_DISCOVERY_BYTES
        );
        let mut wrong_hash = content(bytes);
        wrong_hash.sha = blob(b"b");
        let metadata = RawTreeEntry {
            sha: wrong_hash.sha.clone(),
            ..entry(bytes)
        };
        assert!(wrong_hash
            .validate(&metadata)
            .unwrap_err()
            .to_string()
            .contains("blob hash"));
    }
}
