"""Package native CI payloads as inert data using the pinned Rust CLI.

No candidate Python/module/binary executes here. Only the trusted released CLI
owns archive and publication validation. The protected stage checks run identity.
"""
import argparse
import hashlib
import json
import pathlib
import re
import stat
import subprocess
import tempfile

TARGETS = ("darwin-aarch64", "darwin-x86_64", "linux-aarch64", "linux-x86_64")
FILES = {"LICENSE", "README.md", "icon.svg", "bin/provider", "qualification.json"}
CHECKS = ["version", "cold-models", "host-integration", "initialize", "session-new",
          "model-reconciliation", "scripted-prompt", "session-load", "access-restart", "stdin-close"]
REPOSITORY = "merkr-software/CadencR"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path, limit):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "non-regular or oversized payload")
    with path.open("rb") as source:
        data = source.read(limit + 1)
    require(len(data) <= limit, "payload exceeds byte limit")
    return data


def tracked(repo, commit, name):
    return subprocess.check_output(["git", "-C", str(repo), "show", f"{commit}:plugins/providers/cursor/{name}"],
                                   timeout=30)


def payload(directory, target, commit, version, repo):
    require(not directory.is_symlink() and directory.is_dir(), "missing native payload")
    paths = list(directory.rglob("*"))
    require(all(not path.is_symlink() for path in paths), "symlink in native payload")
    require({str(path.relative_to(directory)) for path in paths if not path.is_dir()} == FILES,
            "native payload contains missing or extra files")
    require({str(path.relative_to(directory)) for path in paths if path.is_dir()} == {"bin"},
            "native payload contains extra directories")
    executable = read(directory / "bin/provider", 32 * 1024 * 1024)
    evidence = json.loads(read(directory / "qualification.json", 64 * 1024))
    expected = {"schema_version": 1, "target": target, "source_commit": commit, "version": version,
                "executable_sha256": digest(executable), "runtime": "scripted-cursor-cli",
                "real_cursor_cli": False, "checks": CHECKS, "result": "PASS"}
    require(evidence == expected, "native qualification does not bind the payload/source/target")
    for name in ("LICENSE", "README.md", "icon.svg"):
        require(read(directory / name, 256 * 1024) == tracked(repo, commit, name), "distribution document mismatch")
    # artifact transport strips executable bits. Restore only this fixed file;
    # it remains inert in preparation and in the protected publication job.
    (directory / "bin/provider").chmod(0o755)
    return evidence


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def prepare(args):
    require(re.fullmatch("[0-9a-f]{40}", args.source_commit), "full source SHA required")
    require(not args.output.exists() and not args.output.is_symlink(), "output must be new")
    metadata = json.loads(tracked(args.source_repo, args.source_commit, "package-template.json"))
    identity = metadata["package"]["agent"]
    version = json.loads(tracked(args.source_repo, args.source_commit, "package.json"))["version"]
    require(identity["id"] == "cursor" and identity["version"] == version, "Cursor version mismatch")
    require(re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version), "stable version required")
    targets = identity["distribution"]["binary"]
    require(set(targets) == set(TARGETS), "unexpected Cursor target set")
    tag = f"plugins/provider-cursor/v{version}"
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="cursor-package-"))
    print(f"Private packaging scratch retained: {scratch}")
    args.output.mkdir(mode=0o700)
    archives, evidence = [], []
    for target in TARGETS:
        name = f"provider-cursor-{version}-{target}.tar.gz"
        targets[target].update(archive=f"https://github.com/{REPOSITORY}/releases/download/plugins%2Fprovider-cursor%2Fv{version}/{name}",
                               sha256="0" * 64)
    for target in TARGETS:
        directory = args.input / f"cursor-native-{target}-{args.source_commit}"
        evidence.append(payload(directory, target, args.source_commit, version, args.source_repo))
        # Exclude qualification evidence from the provider distribution.
        stage = scratch / target
        (stage / "bin").mkdir(parents=True)
        for name in FILES - {"qualification.json"}:
            destination = stage / name
            destination.write_bytes(read(directory / name, 32 * 1024 * 1024))
            destination.chmod(0o755 if name == "bin/provider" else 0o644)
        package_file = scratch / "package.json"
        package_file.write_bytes(encode(metadata["package"]))
        name = f"provider-cursor-{version}-{target}.tar.gz"
        archive = args.output / name
        result = subprocess.check_output([str(args.cli), "registry", "pack-provider", "--package", str(package_file),
                                          "--target", target, "--directory", str(stage), "--output", str(archive)], timeout=60)
        data = read(archive, 64 * 1024 * 1024)
        receipt = {"target": target, "archive": str(archive), "sha256": digest(data), "size": len(data)}
        require(json.loads(result) == receipt, "packaging receipt mismatch")
        targets[target]["sha256"] = digest(data)
        archives.append({"name": name, "sha256": digest(data), "size": len(data)})
    package = encode(metadata)
    (args.output / "package.json").write_bytes(package)
    submission = {"schema_version": 2, "package": metadata, "source": {
        "repository": f"https://github.com/{REPOSITORY}", "commit": args.source_commit, "tag": tag},
        "changelog": "Initial Cursor ACP connector for Cadencr v0.16.0, with native macOS and Linux payloads."}
    (args.output / "submission.json").write_bytes(encode(submission))
    (args.output / "qualification.json").write_bytes(encode(evidence))
    for command, path in (("validate-metadata", "package.json"), ("validate-submission", "submission.json")):
        subprocess.run([str(args.cli), "registry", command, str(args.output / path)], check=True, timeout=60)
    policy = json.loads((pathlib.Path(__file__).parent / "official-plugin-author-policy.json").read_bytes())
    request = {"schema_version": 1, "repository": REPOSITORY, "expected_repository_id": policy["repository_id"],
               "expected_account": policy["author_account"], "tag": tag, "source_commit": args.source_commit,
               "release_notes": submission["changelog"], "prerelease": False, "archive": archives[0],
               "additional_archives": archives[1:], "metadata": {"name": "package.json", "size": len(package), "sha256": digest(package)}}
    data = (json.dumps(request, sort_keys=True, separators=(",", ":")) + "\n").encode()
    (args.output / "request.json").write_bytes(data)
    return digest(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--source-repo", required=True, type=pathlib.Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--cli", required=True, type=pathlib.Path)
    print(prepare(parser.parse_args()))
