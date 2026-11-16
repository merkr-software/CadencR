//! Revocation policies through the real binary: provider signing and
//! verification, automatic renewal and publication preflight.
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Value};

#[path = "support/keys.rs"]
mod keys;

const KEY_ID: &str = "test-key";

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .env_remove("CADENCR_REGISTRY_GITHUB_TOKEN")
        .arg("--json")
        .args(args)
        .output()
        .unwrap()
}

fn path(value: &Path) -> &str {
    value.to_str().unwrap()
}

fn timestamp(offset: Duration) -> String {
    (Utc::now() + offset).to_rfc3339_opts(SecondsFormat::Secs, true)
}

struct Fixture {
    root: tempfile::TempDir,
    private: PathBuf,
    public: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let (private, public) = keys::write(root.path(), "pinned", keys::PRIVATE, keys::PUBLIC);
        Self {
            root,
            private,
            public,
        }
    }

    fn file(&self, name: &str) -> PathBuf {
        self.root.path().join(name)
    }

    /// The reviewed payload of `kind`, generated an hour ago.
    fn payload(&self, kind: &str) -> PathBuf {
        let (id, tag) = match kind {
            "provider" => ("provider_id", None),
            "theme" => ("theme_id", Some("theme-blocklist")),
            "lsp" => ("lsp_id", Some("lsp-blocklist")),
            _ => ("tab_id", Some("tab-blocklist")),
        };
        let mut value = json!({
            "schema_version": 1,
            "generated_at": timestamp(Duration::hours(-1)),
            "expires_at": timestamp(Duration::days(3)),
            "entries": [
                {id: "alpha", "reason": "first"},
                {id: "beta", "archive_sha256": "a".repeat(64), "reason": "second"}
            ],
        });
        if let Some(tag) = tag {
            value["kind"] = json!(tag);
        }
        let path = self.file(&format!("{kind}-payload.json"));
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        path
    }

    fn sign(&self, kind: &str, payload: &Path, output: &Path) -> Output {
        run(&[
            "registry",
            &format!("sign-{kind}-blocklist"),
            "--payload",
            path(payload),
            "--private-key",
            path(&self.private),
            "--key-id",
            KEY_ID,
            "--output",
            path(output),
        ])
    }

    fn verify(&self, kind: &str, signed: &Path) -> Output {
        run(&[
            "registry",
            &format!("verify-{kind}-blocklist"),
            "--index",
            path(signed),
            "--public-key",
            path(&self.public),
            "--key-id",
            KEY_ID,
        ])
    }

    fn signed(&self, kind: &str) -> PathBuf {
        let output = self.file(&format!("{kind}-signed.json"));
        let result = self.sign(kind, &self.payload(kind), &output);
        assert!(result.status.success(), "{}", stderr(&result));
        output
    }

    fn renew(&self, kind: &str, current: &Path, expires_at: &str, output: &Path) -> Output {
        run(&[
            "registry",
            "renew-policy",
            "--kind",
            kind,
            "--current",
            path(current),
            "--public-key",
            path(&self.public),
            "--key-id",
            KEY_ID,
            "--private-key",
            path(&self.private),
            "--expires-at",
            expires_at,
            "--output",
            path(output),
        ])
    }
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn read(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

const KINDS: [&str; 4] = ["provider", "theme", "tab", "lsp"];

#[test]
fn provider_blocklist_signs_verifies_and_never_overwrites() {
    let fixture = Fixture::new();
    let signed = fixture.signed("provider");
    let envelope = read(&signed);
    assert!(envelope["signed"].get("kind").is_none());
    assert_eq!(envelope["signature"]["key_id"], KEY_ID);
    assert!(fixture.verify("provider", &signed).status.success());
    let original = std::fs::read(&signed).unwrap();
    assert!(!fixture
        .sign("provider", &fixture.payload("provider"), &signed)
        .status
        .success());
    assert_eq!(std::fs::read(&signed).unwrap(), original);
    // A wrong key id is not the signer.
    let wrong = run(&[
        "registry",
        "verify-provider-blocklist",
        "--index",
        path(&signed),
        "--public-key",
        path(&fixture.public),
        "--key-id",
        "other-key",
    ]);
    assert_eq!(wrong.status.code(), Some(1));
}

#[test]
fn policy_domains_are_not_interchangeable() {
    let fixture = Fixture::new();
    for signer in KINDS {
        for payload in KINDS.into_iter().filter(|payload| *payload != signer) {
            let rejected = fixture.file(&format!("{payload}-as-{signer}.json"));
            let result = fixture.sign(signer, &fixture.payload(payload), &rejected);
            assert_eq!(result.status.code(), Some(1), "{payload} as {signer}");
            assert!(!rejected.exists());
        }
    }
    // A signed policy of one domain does not verify as another.
    let provider = fixture.signed("provider");
    let theme = fixture.signed("theme");
    assert!(!fixture.verify("theme", &provider).status.success());
    assert!(!fixture.verify("provider", &theme).status.success());
}

#[test]
fn renew_policy_keeps_entries_and_advances_the_window_for_every_kind() {
    for kind in KINDS {
        let fixture = Fixture::new();
        let current = fixture.signed(kind);
        let renewed = fixture.file("renewed.json");
        let expires = timestamp(Duration::days(10));
        let result = fixture.renew(kind, &current, &expires, &renewed);
        assert!(result.status.success(), "{kind}: {}", stderr(&result));
        let (before, after) = (read(&current), read(&renewed));
        assert_eq!(after["signed"]["entries"], before["signed"]["entries"]);
        assert_eq!(after["signed"]["expires_at"], json!(expires));
        assert_eq!(after["signed"].get("kind"), before["signed"].get("kind"));
        assert!(
            after["signed"]["generated_at"].as_str() > before["signed"]["generated_at"].as_str()
        );
        assert!(fixture.verify(kind, &renewed).status.success(), "{kind}");
        // Never overwrites its output.
        let bytes = std::fs::read(&renewed).unwrap();
        assert!(!fixture
            .renew(kind, &current, &expires, &renewed)
            .status
            .success());
        assert_eq!(std::fs::read(&renewed).unwrap(), bytes);
    }
}

#[test]
fn renew_policy_refuses_mismatched_kind_bad_expiry_and_foreign_keys() {
    let fixture = Fixture::new();
    let provider = fixture.signed("provider");
    let theme = fixture.signed("theme");
    let output = fixture.file("never.json");
    let expires = timestamp(Duration::days(10));
    // Kind mismatches in every direction.
    for (kind, current) in [("theme", &provider), ("provider", &theme), ("tab", &theme)] {
        let result = fixture.renew(kind, current, &expires, &output);
        assert_eq!(result.status.code(), Some(1), "{kind}");
        assert!(stderr(&result).contains("REGISTRY_POLICY_RENEWAL_FAILED"));
    }
    let current_expiry = read(&theme)["signed"]["expires_at"]
        .as_str()
        .unwrap()
        .to_owned();
    for (expires, expected) in [
        (current_expiry.as_str(), "later than"),
        ("2020-01-01T00:00:00Z", "later than"),
        (&timestamp(Duration::days(15)), "window"),
        ("2030-01-01T00:00:00+00:00", "canonical"),
    ] {
        let result = fixture.renew("theme", &theme, expires, &output);
        assert_eq!(result.status.code(), Some(1), "{expires}");
        assert!(
            stderr(&result).contains(expected),
            "{expires}: {}",
            stderr(&result)
        );
    }
    // A key that is not the pinned one neither authenticates nor signs.
    let (other_private, other_public) = keys::write(
        fixture.root.path(),
        "other",
        keys::OTHER_PRIVATE,
        keys::OTHER_PUBLIC,
    );
    let foreign_signer = run(&[
        "registry",
        "renew-policy",
        "--kind",
        "theme",
        "--current",
        path(&theme),
        "--public-key",
        path(&fixture.public),
        "--key-id",
        KEY_ID,
        "--private-key",
        path(&other_private),
        "--expires-at",
        &expires,
        "--output",
        path(&output),
    ]);
    assert_eq!(foreign_signer.status.code(), Some(1));
    assert!(stderr(&foreign_signer).contains("pinned public key"));
    let foreign_pin = run(&[
        "registry",
        "renew-policy",
        "--kind",
        "theme",
        "--current",
        path(&theme),
        "--public-key",
        path(&other_public),
        "--key-id",
        KEY_ID,
        "--private-key",
        path(&fixture.private),
        "--expires-at",
        &expires,
        "--output",
        path(&output),
    ]);
    assert_eq!(foreign_pin.status.code(), Some(1));
    assert!(!output.exists());
}

#[test]
fn publish_policy_judges_local_inputs_before_it_reads_a_token() {
    let fixture = Fixture::new();
    let theme = fixture.signed("theme");
    let publish = |kind: &str, signed: &Path, branch: &str, extra: &[&str]| {
        let mut args = vec![
            "registry",
            "publish-policy",
            "--kind",
            kind,
            "--signed",
            path(signed),
            "--repository",
            "acme/registry",
            "--discovery-branch",
            branch,
            "--public-key",
            path(&fixture.public),
            "--key-id",
            KEY_ID,
        ];
        args.extend_from_slice(extra);
        run(&args)
    };
    // Valid inputs reach the credential check, and only it.
    let result = publish("theme", &theme, "marketplace-v2", &[]);
    assert_eq!(result.status.code(), Some(1));
    assert!(
        stderr(&result).contains("CADENCR_REGISTRY_GITHUB_TOKEN is required"),
        "{}",
        stderr(&result)
    );
    // Everything below fails before that, so no token is ever consulted.
    for (kind, signed, branch) in [
        ("provider", &theme, "marketplace-v2"),
        ("tab", &theme, "marketplace-v2"),
        ("theme", &theme, "../main"),
        ("theme", &fixture.file("missing.json"), "marketplace-v2"),
    ] {
        let result = publish(kind, signed, branch, &[]);
        assert_eq!(result.status.code(), Some(1), "{kind} {branch}");
        let message = stderr(&result);
        assert!(
            message.contains("REGISTRY_POLICY_PUBLICATION_FAILED"),
            "{message}"
        );
        assert!(!message.contains("TOKEN"), "{message}");
    }
    let existing = fixture.file("receipt.json");
    std::fs::write(&existing, b"keep").unwrap();
    let result = publish(
        "theme",
        &theme,
        "marketplace-v2",
        &["--receipt", path(&existing)],
    );
    assert_eq!(result.status.code(), Some(3));
    assert_eq!(std::fs::read(&existing).unwrap(), b"keep");
    // The token is read from the environment only; there is no flag for it.
    assert_eq!(
        publish("theme", &theme, "marketplace-v2", &["--token", "x"])
            .status
            .code(),
        Some(2)
    );
}

#[test]
fn publish_policy_requires_every_identifying_flag() {
    let result = run(&["registry", "publish-policy"]);
    assert_eq!(result.status.code(), Some(2));
    let value: Value = serde_json::from_slice(&result.stderr).unwrap();
    for flag in [
        "--kind",
        "--signed",
        "--repository",
        "--discovery-branch",
        "--public-key",
        "--key-id",
    ] {
        assert!(value["message"].as_str().unwrap().contains(flag), "{flag}");
    }
}

#[test]
fn publish_policy_renewal_is_a_distinct_mode_and_never_a_bootstrap() {
    let fixture = Fixture::new();
    let theme = fixture.signed("theme");
    let publish = |extra: &[&str]| {
        let mut args = vec![
            "registry",
            "publish-policy",
            "--kind",
            "theme",
            "--signed",
            path(&theme),
            "--repository",
            "acme/registry",
            "--discovery-branch",
            "marketplace-v2",
            "--public-key",
            path(&fixture.public),
            "--key-id",
            KEY_ID,
        ];
        args.extend_from_slice(extra);
        run(&args)
    };
    // A renewal is judged locally like any publication, then needs the token.
    let result = publish(&["--renewal"]);
    assert_eq!(result.status.code(), Some(1));
    assert!(stderr(&result).contains("CADENCR_REGISTRY_GITHUB_TOKEN is required"));
    // It excludes a bootstrap: the two modes contradict each other.
    assert_eq!(
        publish(&["--renewal", "--bootstrap"]).status.code(),
        Some(2)
    );
}

#[test]
fn fetch_policy_judges_its_target_and_output_before_the_network() {
    let fixture = Fixture::new();
    let output = fixture.file("fetched.json");
    let fetch = |kind: &str, repository: &str, branch: &str, output: &Path| {
        run(&[
            "registry",
            "fetch-policy",
            "--kind",
            kind,
            "--repository",
            repository,
            "--discovery-branch",
            branch,
            "--output",
            path(output),
        ])
    };
    // Valid inputs reach the credential check, and only it.
    let result = fetch("tab", "acme/registry", "marketplace-v2", &output);
    assert_eq!(result.status.code(), Some(1));
    assert!(stderr(&result).contains("REGISTRY_POLICY_FETCH_FAILED"));
    assert!(stderr(&result).contains("CADENCR_REGISTRY_GITHUB_TOKEN is required"));
    assert!(!output.exists());
    // An existing output is refused before anything else.
    std::fs::write(&output, b"keep").unwrap();
    let result = fetch("tab", "acme/registry", "marketplace-v2", &output);
    assert_eq!(result.status.code(), Some(3));
    assert_eq!(std::fs::read(&output).unwrap(), b"keep");
    // A token alone does not make a bad target fetchable.
    let result = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .env("CADENCR_REGISTRY_GITHUB_TOKEN", "unused")
        .args(["--json", "registry", "fetch-policy", "--kind", "tab"])
        .args(["--repository", "acme", "--discovery-branch", "../main"])
        .args(["--output", path(&fixture.file("never.json"))])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(1));
    assert!(!fixture.file("never.json").exists());
}
