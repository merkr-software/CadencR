//! The permissions hash consent is recorded against.
//!
//! SHA-256 (lowercase hex) of the canonical JSON
//! `{"permissions":[sorted],"allowed_origins":[sorted]}`, plus
//! `"commands":[sorted programs],"trust":1` when the tab lists commands and
//! `"backend":{"protocol":1,"binary":{<platform>:<path>, sorted by platform}}`
//! when it ships a backend. The two later keys are omitted when empty, so a tab
//! that declares neither keeps the hash it was consented under. Anything that
//! widens what a tab can reach or run changes the hash, so a stored consent
//! stops matching and the user is asked again: a new scope, origin or program,
//! a backend, a platform's binary added or moved, a protocol change. Labels,
//! reasons, version bumps and configuration do not.
//! An editor contribution adds `"editor":{"label":...,"open_method":...}`
//! after the backend. This binds the editor the user selected; omitted when
//! absent so every pre-editor consent hash remains unchanged.
//!
//! `"trust":1` marks consent to commands given with the explicit "I trust this
//! code" acknowledgment (a listed program runs with arguments the tab picks).
//! Consents to commands recorded before it was required no longer match, so
//! those users are asked again, now with that acknowledgment.
//!
//! A local tab's binaries are identified by path only: the user consents to
//! whatever its author builds there. A marketplace tab's binary also carries
//! its published digest: `"digests":{<platform>:<executable_sha256>}` beside
//! `binary`, for the platform Cadencr runs on only (an update that rebuilds
//! another platform's binary asks nothing here), omitted when absent so local
//! hashes stay as they are
//! ([`TabManifest::permissions_hash_with_backend_digest`]).

use std::collections::BTreeMap;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{manifest::TabManifest, TabEditorContribution};

#[derive(Serialize)]
struct Canonical<'a> {
    permissions: Vec<&'a str>,
    allowed_origins: Vec<&'a str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    commands: Vec<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trust: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    backend: Option<CanonicalBackend<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    editor: Option<&'a TabEditorContribution>,
}

/// The version of the code-trust acknowledgment consent to commands carries.
const COMMANDS_TRUST_VERSION: u32 = 1;

/// A backend as consent sees it. Field order is the canonical key order.
#[derive(Serialize)]
pub(crate) struct CanonicalBackend<'a> {
    pub protocol: u32,
    /// Sorted by platform key (a `BTreeMap` serializes in key order).
    pub binary: BTreeMap<&'a str, &'a str>,
    /// The signed executable digest of a marketplace tab, keyed by platform.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digests: Option<BTreeMap<&'a str, &'a str>>,
}

/// What widens a tab beyond its page: the commands it may run and the
/// backend it launches.
#[derive(Default)]
pub(crate) struct Execution<'a> {
    pub commands: Vec<&'a str>,
    pub backend: Option<CanonicalBackend<'a>>,
    pub editor: Option<&'a TabEditorContribution>,
}

pub(crate) fn permissions_hash(
    permissions: &[String],
    allowed_origins: &[String],
    execution: Execution<'_>,
) -> String {
    let mut permissions: Vec<&str> = permissions.iter().map(String::as_str).collect();
    let mut allowed_origins: Vec<&str> = allowed_origins.iter().map(String::as_str).collect();
    let mut commands = execution.commands;
    permissions.sort_unstable();
    allowed_origins.sort_unstable();
    commands.sort_unstable();
    let trust = (!commands.is_empty()).then_some(COMMANDS_TRUST_VERSION);
    let canonical = serde_json::to_vec(&Canonical {
        permissions,
        allowed_origins,
        commands,
        trust,
        backend: execution.backend,
        editor: execution.editor,
    })
    .expect("a struct of string lists always serializes");
    Sha256::digest(&canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl TabManifest {
    /// See the module docs.
    pub fn permissions_hash(&self) -> String {
        self.permissions_hash_with_backend_digest(None)
    }

    /// [`Self::permissions_hash`] of a marketplace tab whose backend binary
    /// for the platform Cadencr runs on has the signed SHA-256 `digest`
    /// (`executable_sha256`). `None` — a local tab, or no backend — is the
    /// plain hash. Where tab backends are unsupported there is no platform
    /// to key it by and the digest is left out: no backend runs there.
    pub fn permissions_hash_with_backend_digest(&self, digest: Option<&str>) -> String {
        let digests = super::TabPlatform::current()
            .zip(digest)
            .map(|(platform, digest)| BTreeMap::from([(platform.as_str(), digest)]));
        let execution = Execution {
            editor: self
                .contributes
                .as_ref()
                .and_then(|contributes| contributes.editor.as_ref()),
            commands: self
                .commands
                .iter()
                .map(|command| command.program.as_str())
                .collect(),
            backend: self.backend.as_ref().map(|backend| CanonicalBackend {
                protocol: backend.protocol,
                binary: backend
                    .binary
                    .iter()
                    .map(|(platform, path)| (platform.as_str(), path.as_str()))
                    .collect(),
                digests,
            }),
        };
        permissions_hash(&self.permissions, self.allowed_origins(), execution)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn editor_consent_preserves_old_hashes_and_binds_the_contribution() {
        let make = crate::tab::test_support::manifest;
        let old = make(serde_json::json!({})).permissions_hash();
        assert_eq!(
            old,
            make(serde_json::json!({"schema_version": 2})).permissions_hash()
        );
        assert_eq!(
            old,
            make(serde_json::json!({"schema_version": 2, "contributes": {}})).permissions_hash()
        );
        let editor = |label, method| {
            make(serde_json::json!({"schema_version": 2,
                "contributes": {"editor": {"label": label, "open_method": method}}
            }))
            .permissions_hash()
        };
        assert_ne!(old, editor("Editor", "editor.open"));
        assert_ne!(
            editor("Editor", "editor.open"),
            editor("Editor", "file.open")
        );
        assert_ne!(
            editor("Editor", "editor.open"),
            editor("Other editor", "editor.open")
        );
    }

    #[test]
    fn hashes_the_documented_canonical_json() {
        let expected: String = Sha256::digest(
            br#"{"permissions":["features:read","git:read"],"allowed_origins":["https://a.example"]}"#,
        )
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
        assert_eq!(
            permissions_hash(
                &strings(&["git:read", "features:read"]),
                &strings(&["https://a.example"]),
                Execution::default()
            ),
            expected
        );
        assert_eq!(expected.len(), 64);
    }

    #[test]
    fn order_does_not_matter_but_widening_does() {
        let base = permissions_hash(
            &strings(&["a", "b"]),
            &strings(&["x", "y"]),
            Execution::default(),
        );
        assert_eq!(
            base,
            permissions_hash(
                &strings(&["b", "a"]),
                &strings(&["y", "x"]),
                Execution::default()
            )
        );
        assert_ne!(
            base,
            permissions_hash(
                &strings(&["a", "b", "c"]),
                &strings(&["x", "y"]),
                Execution::default()
            )
        );
        assert_ne!(
            base,
            permissions_hash(
                &strings(&["a", "b"]),
                &strings(&["x", "y", "z"]),
                Execution::default()
            )
        );
        // A scope moved into the origin list is a different grant.
        assert_ne!(
            permissions_hash(&strings(&["a"]), &[], Execution::default()),
            permissions_hash(&[], &strings(&["a"]), Execution::default())
        );
    }

    #[test]
    fn commands_and_backend_widen_the_hash_only_when_declared() {
        let plain = permissions_hash(&strings(&["a"]), &[], Execution::default());
        let expected: String = Sha256::digest(br#"{"permissions":["a"],"allowed_origins":[]}"#)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(plain, expected, "tabs without commands keep their hash");
        let git = || Execution {
            commands: vec!["jq", "git"],
            backend: None,
            editor: None,
        };
        let with_commands = permissions_hash(&strings(&["a"]), &[], git());
        assert_ne!(plain, with_commands);
        // Consent to commands is consent with the code-trust acknowledgment.
        let trusted: String = Sha256::digest(
            br#"{"permissions":["a"],"allowed_origins":[],"commands":["git","jq"],"trust":1}"#,
        )
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
        assert_eq!(with_commands, trusted);
        assert_eq!(
            with_commands,
            permissions_hash(
                &strings(&["a"]),
                &[],
                Execution {
                    commands: vec!["git", "jq"],
                    backend: None,
                    editor: None
                }
            )
        );
        let backend = |protocol, binary: &[(&'static str, &'static str)]| {
            Some(CanonicalBackend {
                protocol,
                binary: binary.iter().copied().collect(),
                digests: None,
            })
        };
        let with_backend = permissions_hash(
            &strings(&["a"]),
            &[],
            Execution {
                commands: vec!["git", "jq"],
                backend: backend(1, &[("linux-x86_64", "bin/l"), ("darwin-aarch64", "bin/m")]),
                editor: None,
            },
        );
        assert_ne!(with_commands, with_backend);
        let hash_of = |protocol, binary| {
            permissions_hash(
                &strings(&["a"]),
                &[],
                Execution {
                    commands: vec!["git", "jq"],
                    backend: backend(protocol, binary),
                    editor: None,
                },
            )
        };
        // Declaration order does not matter; any path, platform or protocol change does.
        assert_eq!(
            with_backend,
            hash_of(1, &[("darwin-aarch64", "bin/m"), ("linux-x86_64", "bin/l")])
        );
        assert_ne!(
            with_backend,
            hash_of(
                1,
                &[("linux-x86_64", "bin/other"), ("darwin-aarch64", "bin/m")]
            )
        );
        assert_ne!(with_backend, hash_of(1, &[("darwin-aarch64", "bin/m")]));
        assert_ne!(
            with_backend,
            hash_of(2, &[("linux-x86_64", "bin/l"), ("darwin-aarch64", "bin/m")])
        );
    }

    #[test]
    fn a_backend_hashes_the_documented_canonical_json() {
        let manifest = crate::tab::test_support::manifest(serde_json::json!({
            "permissions": ["git:read"],
            "network": null,
            "backend": {
                "protocol": 1,
                "binary": {"linux-x86_64": "bin/l", "darwin-aarch64": "bin/m"},
                "reasoning": "r"
            }
        }));
        let expected: String = Sha256::digest(
            br#"{"permissions":["git:read"],"allowed_origins":[],"backend":{"protocol":1,"binary":{"darwin-aarch64":"bin/m","linux-x86_64":"bin/l"}}}"#,
        )
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
        assert_eq!(manifest.permissions_hash(), expected);
    }

    #[test]
    fn a_marketplace_digest_widens_only_backend_hashes_and_keys_the_current_platform() {
        let manifest = |backend| {
            crate::tab::test_support::manifest(serde_json::json!({
                "permissions": ["git:read"],
                "network": null,
                "backend": backend
            }))
        };
        let backend = manifest(serde_json::json!({
            "protocol": 1,
            "binary": {"linux-x86_64": "bin/l", "darwin-aarch64": "bin/m", "darwin-x86_64": "bin/m"},
            "reasoning": "r"
        }));
        // A local tab keeps its hash: no digest is the plain hash.
        assert_eq!(
            backend.permissions_hash_with_backend_digest(None),
            backend.permissions_hash()
        );
        let first = backend.permissions_hash_with_backend_digest(Some(&"a".repeat(64)));
        let rebuilt = backend.permissions_hash_with_backend_digest(Some(&"b".repeat(64)));
        let Some(platform) = crate::tab::TabPlatform::current() else {
            assert_eq!(first, backend.permissions_hash());
            return;
        };
        assert_ne!(first, backend.permissions_hash());
        assert_ne!(first, rebuilt, "a new binary asks for consent again");
        let canonical = format!(
            r#"{{"permissions":["git:read"],"allowed_origins":[],"backend":{{"protocol":1,"binary":{{"darwin-aarch64":"bin/m","darwin-x86_64":"bin/m","linux-x86_64":"bin/l"}},"digests":{{"{platform}":"{}"}}}}}}"#,
            "a".repeat(64)
        );
        let expected: String = Sha256::digest(canonical.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(first, expected);
        // A UI-only tab has no backend to bind a digest to.
        let ui = manifest(serde_json::Value::Null);
        assert_eq!(
            ui.permissions_hash_with_backend_digest(Some(&"a".repeat(64))),
            ui.permissions_hash()
        );
    }
}
