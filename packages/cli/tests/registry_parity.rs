//! Native CLI coverage migrated case-for-case from the eight legacy contribution
//! safety suites at 60f3ae9e8bfe249ddec37a183f64e4f86b7ae716.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn package(id: &str, version: &str) -> Value {
    json!({
        "agent": {
            "id": id, "name": "Acme Agent", "version": version,
            "description": "ACP connector", "license": "Apache-2.0",
            "repository": "https://github.com/acme/acme-agent",
            "distribution": {"binary": {"darwin-aarch64": {
                "archive": format!("https://github.com/acme/acme-agent/releases/download/v{version}/agent.tar.gz"),
                "cmd": "bin/agent", "sha256": "a".repeat(64)
            }}}
        },
        "host": {
            "publisher": "acme", "compatibility": {"min_app_version": "0.12.0"},
            "assets": {"icon": "icon.svg", "readme": "README.md", "license": "LICENSE"}
        }
    })
}

fn submission(package: &Value) -> Value {
    json!({
        "schema_version": 1, "package": package,
        "source": {
            "repository": package["agent"]["repository"],
            "commit": "0123456789abcdef0123456789abcdef01234567",
            "tag": format!("v{}", package["agent"]["version"].as_str().unwrap())
        },
        "changelog": "Release notes."
    })
}

fn filename(package: &Value) -> String {
    format!(
        "{}-{}.json",
        package["agent"]["id"].as_str().unwrap(),
        package["agent"]["version"].as_str().unwrap()
    )
}

fn write_json(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn validate(base: &Path, candidate: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_cadencr"));
    command
        .args(["registry", "validate", "--base"])
        .arg(base)
        .arg("--candidate")
        .arg(candidate);
    command
}

struct Fixture {
    root: tempfile::TempDir,
    base: PathBuf,
    candidate: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        let candidate = root.path().join("candidate");
        for directory in [&base, &candidate] {
            std::fs::create_dir_all(directory.join("packages")).unwrap();
        }
        Self {
            root,
            base,
            candidate,
        }
    }

    fn legacy(&self, package: &Value) {
        for directory in [&self.base, &self.candidate] {
            write_json(&directory.join("packages").join(filename(package)), package);
        }
    }

    fn existing(&self, package: &Value) {
        self.legacy(package);
        for directory in [&self.base, &self.candidate] {
            write_json(
                &directory.join("submissions").join(filename(package)),
                &submission(package),
            );
        }
    }

    fn candidate_package(&self, package: &Value) {
        write_json(
            &self.candidate.join("packages").join(filename(package)),
            package,
        );
    }

    fn candidate_submission(&self, package: &Value) {
        write_json(
            &self.candidate.join("submissions").join(filename(package)),
            &submission(package),
        );
    }

    fn candidate_release(&self, package: &Value) {
        self.candidate_package(package);
        self.candidate_submission(package);
    }

    fn run(&self) -> Output {
        validate(&self.base, &self.candidate).output().unwrap()
    }
}

fn accepted(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
}

fn rejected(output: Output, messages: &[&str]) {
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    for message in messages {
        assert!(stderr.contains(message), "expected {message:?}: {stderr}");
    }
}

#[test]
fn accepts_new_provider_subsequent_version_and_unchanged_legacy() {
    let first = Fixture::new();
    first.legacy(&package("legacy-agent", "1.0.0"));
    accepted(first.run());
    let fresh = package("acme-agent", "1.0.0");
    first.candidate_release(&fresh);
    accepted(first.run());

    let second = Fixture::new();
    second.existing(&fresh);
    second.candidate_release(&package("acme-agent", "1.1.0"));
    accepted(second.run());
}

#[test]
fn rejects_edits_and_removals_of_existing_packages_and_submissions() {
    let fixture = Fixture::new();
    let original = package("acme-agent", "1.0.0");
    fixture.existing(&original);
    let mut edited = original.clone();
    edited["agent"]["description"] = json!("rewritten");
    fixture.candidate_package(&edited);
    write_json(
        &fixture
            .candidate
            .join("submissions")
            .join(filename(&original)),
        &json!({}),
    );
    rejected(
        fixture.run(),
        &[
            "existing packages are immutable",
            "existing submissions are immutable",
        ],
    );

    let empty = fixture.root.path().join("empty");
    std::fs::create_dir_all(empty.join("packages")).unwrap();
    // Both collections were removed, not merely one file.
    rejected(
        validate(&fixture.base, &empty).output().unwrap(),
        &[
            "packages/acme-agent-1.0.0.json: deletion is not allowed",
            "submissions/acme-agent-1.0.0.json: deletion is not allowed",
        ],
    );
}

#[test]
fn rejects_missing_mismatched_orphan_and_retroactive_submissions() {
    let fixture = Fixture::new();
    let package = package("acme-agent", "1.0.0");
    fixture.candidate_package(&package);
    rejected(fixture.run(), &["new package versions require"]);
    let mut wrong = package.clone();
    wrong["agent"]["description"] = json!("Does not match the package file");
    fixture.candidate_submission(&wrong);
    rejected(fixture.run(), &["must exactly match"]);
    fixture.candidate_submission(&self::package("orphan-agent", "1.0.0"));
    rejected(fixture.run(), &["orphan submission"]);

    let legacy = Fixture::new();
    legacy.legacy(&package);
    legacy.candidate_submission(&package);
    rejected(legacy.run(), &["retroactive provenance claims"]);
}

#[test]
fn rejects_ownership_drift_and_normalized_provider_collisions() {
    let fixture = Fixture::new();
    fixture.legacy(&package("acme-agent", "1.0.0"));
    let mut next = package("acme-agent", "2.0.0");
    next["host"]["publisher"] = json!("attacker");
    next["agent"]["repository"] = json!("https://github.com/attacker/acme-agent");
    fixture.candidate_release(&next);
    rejected(
        fixture.run(),
        &[
            "host.publisher must remain",
            "source.repository must remain",
        ],
    );
    fixture.candidate_release(&package("acmeagent", "1.0.0"));
    rejected(fixture.run(), &["collides with", "runtime normalization"]);
}

#[test]
fn keeps_ownership_consistent_across_batched_new_versions() {
    let valid = Fixture::new();
    for version in ["1.0.0", "1.1.0"] {
        valid.candidate_release(&package("acme-agent", version));
    }
    accepted(valid.run());

    let split = Fixture::new();
    split.candidate_release(&package("acme-agent", "1.0.0"));
    let mut second = package("acme-agent", "1.1.0");
    second["host"]["publisher"] = json!("other");
    second["agent"]["repository"] = json!("https://github.com/other/acme-agent");
    split.candidate_release(&second);
    rejected(
        split.run(),
        &[
            "host.publisher must remain",
            "source.repository must remain",
        ],
    );
}

#[test]
fn bounds_inert_json_and_rejects_malformed_files_symlinks_and_invalid_paths() {
    let fixture = Fixture::new();
    std::fs::write(fixture.candidate.join("packages/.gitkeep"), b"").unwrap();
    accepted(fixture.run());
    let missing_arguments = Command::new(env!("CARGO_BIN_EXE_cadencr"))
        .args(["registry", "validate"])
        .output()
        .unwrap();
    assert_eq!(missing_arguments.status.code(), Some(2));
    assert_eq!(
        validate(&fixture.base, &fixture.candidate)
            .arg("extra")
            .output()
            .unwrap()
            .status
            .code(),
        Some(2)
    );

    let bad = fixture.candidate.join("packages/bad.json");
    std::fs::write(&bad, b"{").unwrap();
    rejected(fixture.run(), &["invalid JSON"]);
    std::fs::write(&bad, vec![b'x'; 1024 * 1024 + 1]).unwrap();
    rejected(fixture.run(), &["file limit"]);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&bad, fixture.candidate.join("packages/link.json")).unwrap();
        rejected(fixture.run(), &["symlinks and special files are forbidden"]);
        let linked = fixture.root.path().join("linked");
        std::os::unix::fs::symlink(&fixture.candidate, &linked).unwrap();
        rejected(
            validate(&fixture.base, &linked).output().unwrap(),
            &["symlinks are forbidden"],
        );
    }
    rejected(
        validate(&fixture.root.path().join("missing"), &fixture.candidate)
            .output()
            .unwrap(),
        &["base:"],
    );
}

#[test]
fn never_executes_contributor_controlled_candidate_scripts() {
    let fixture = Fixture::new();
    let marker = fixture.root.path().join("executed");
    let scripts = fixture.candidate.join("scripts");
    std::fs::create_dir(&scripts).unwrap();
    // Deliberately executable JavaScript, not a mocked validator or inert comment.
    let script = format!(
        "import {{ writeFileSync }} from 'node:fs'; writeFileSync({}, 'bad');",
        serde_json::to_string(&marker).unwrap()
    );
    std::fs::write(scripts.join("validate-contribution.mjs"), script).unwrap();
    accepted(fixture.run());
    assert_eq!(
        std::fs::metadata(marker).unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );
}

#[test]
fn counts_malformed_json_toward_aggregate_root_byte_budget() {
    let fixture = Fixture::new();
    let one_mib = vec![b'x'; 1024 * 1024];
    for index in 0..33 {
        std::fs::write(
            fixture
                .candidate
                .join("packages")
                .join(format!("bad-{index}.json")),
            &one_mib,
        )
        .unwrap();
    }
    rejected(
        fixture.run(),
        &["root exceeds the 33554432-byte JSON total limit"],
    );
}
