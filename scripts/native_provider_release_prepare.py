"""Package native CI payloads as inert data using the pinned Rust CLI.

No candidate Python/module/binary executes here. Only the trusted released CLI
owns archive and publication validation. The protected stage checks run identity.
"""
import argparse
import json
import pathlib
import re
import stat
import subprocess
import tempfile
from dataclasses import dataclass

from official_plugin_pack import REPOSITORY, digest, json_bytes, parse_json

TARGETS = ("darwin-aarch64", "darwin-x86_64", "linux-aarch64", "linux-x86_64")
DOCUMENTS = ("LICENSE", "README.md", "icon.svg")
FILES = {*DOCUMENTS, "bin/provider", "qualification.json"}


@dataclass(frozen=True)
class ProviderRelease:
    id: str
    runtime: str
    real_runtime_key: str
    checks: tuple[str, ...]
    changelog: str

    def evidence(self, target, commit, version, executable_sha256):
        return {"schema_version": 1, "target": target, "source_commit": commit,
                "version": version, "executable_sha256": executable_sha256,
                "runtime": self.runtime, self.real_runtime_key: False,
                "checks": list(self.checks), "result": "PASS"}

    def tag(self, version):
        return f"plugins/provider-{self.id}/v{version}"


PROVIDERS = {
    "cursor": ProviderRelease(
        "cursor", "scripted-cursor-cli", "real_cursor_cli",
        ("version", "cold-models", "host-integration", "initialize", "session-new",
         "model-reconciliation", "scripted-prompt", "session-load", "access-restart", "stdin-close"),
        "Initial Cursor ACP connector for Cadencr v0.16.0, with native macOS and Linux payloads.",
    ),
    "antigravity": ProviderRelease(
        "antigravity", "scripted-antigravity-cli", "real_antigravity_cli",
        ("version", "host-integration", "scripted-connector-e2e"),
        "Initial Google Antigravity CLI connector for Cadencr, with native macOS and Linux payloads.",
    ),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read(path, limit):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "non-regular or oversized payload")
    with path.open("rb") as source:
        data = source.read(limit + 1)
    require(len(data) <= limit, "payload exceeds byte limit")
    return data


def tracked(repo, commit, provider, name):
    return subprocess.check_output(["git", "-C", str(repo), "show", f"{commit}:plugins/providers/{provider.id}/{name}"],
                                   timeout=30)


def version_at(repo, commit, provider):
    version = parse_json(tracked(repo, commit, provider, "package.json"))["version"]
    require(isinstance(version, str) and
            re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version),
            "stable version required")
    return version


def payload(directory, target, commit, version, documents, provider):
    require(not directory.is_symlink() and directory.is_dir(), "missing native payload")
    paths = list(directory.rglob("*"))
    require(all(not path.is_symlink() for path in paths), "symlink in native payload")
    require({str(path.relative_to(directory)) for path in paths if not path.is_dir()} == FILES,
            "native payload contains missing or extra files")
    require({str(path.relative_to(directory)) for path in paths if path.is_dir()} == {"bin"},
            "native payload contains extra directories")
    executable = read(directory / "bin/provider", 32 * 1024 * 1024)
    evidence = parse_json(read(directory / "qualification.json", 64 * 1024))
    expected = provider.evidence(target, commit, version, digest(executable))
    require(json_bytes(evidence) == json_bytes(expected),
            "native qualification does not bind the payload/source/target")
    for name, source in documents.items():
        require(read(directory / name, 256 * 1024) == source, "distribution document mismatch")
    return evidence, executable


def prepare(args):
    require(re.fullmatch("[0-9a-f]{40}", args.source_commit), "full source SHA required")
    require(not args.output.exists() and not args.output.is_symlink(), "output must be new")
    provider = PROVIDERS[args.provider]
    metadata = parse_json(tracked(args.source_repo, args.source_commit, provider, "package-template.json"))
    identity = metadata["package"]["agent"]
    version = version_at(args.source_repo, args.source_commit, provider)
    require(identity["id"] == provider.id and identity["version"] == version, "provider version or identity mismatch")
    targets = identity["distribution"]["binary"]
    require(set(targets) == set(TARGETS), "unexpected native provider target set")
    documents = {name: tracked(args.source_repo, args.source_commit, provider, name) for name in DOCUMENTS}
    tag = provider.tag(version)
    scratch = pathlib.Path(tempfile.mkdtemp(prefix=f"{provider.id}-package-"))
    print(f"Private packaging scratch retained: {scratch}")
    args.output.mkdir(mode=0o700)
    archives, evidence = [], []
    names = {target: f"provider-{provider.id}-{version}-{target}.tar.gz" for target in TARGETS}
    for target, name in names.items():
        targets[target].update(archive=f"https://github.com/{REPOSITORY}/releases/download/{tag.replace('/', '%2F')}/{name}",
                               sha256="0" * 64)
    package_file = scratch / "package.json"
    package_file.write_bytes(json_bytes(metadata["package"]))
    for target, name in names.items():
        directory = args.input / f"{provider.id}-native-{target}-{args.source_commit}"
        qualified, executable = payload(directory, target, args.source_commit, version, documents, provider)
        evidence.append(qualified)
        # Package the same executable bytes that were checked against the evidence.
        stage = scratch / target
        (stage / "bin").mkdir(parents=True)
        for path, data in (documents | {"bin/provider": executable}).items():
            destination = stage / path
            destination.write_bytes(data)
            destination.chmod(0o755 if path == "bin/provider" else 0o644)
        archive = args.output / name
        result = subprocess.check_output([str(args.cli), "registry", "pack-provider", "--package", str(package_file),
                                          "--target", target, "--directory", str(stage), "--output", str(archive)], timeout=60)
        data = read(archive, 64 * 1024 * 1024)
        asset = {"name": name, "sha256": digest(data), "size": len(data)}
        receipt = {"target": target, "archive": str(archive), "sha256": asset["sha256"], "size": asset["size"]}
        require(parse_json(result) == receipt, "packaging receipt mismatch")
        targets[target]["sha256"] = asset["sha256"]
        archives.append(asset)
    package = json_bytes(metadata)
    (args.output / "package.json").write_bytes(package)
    submission = {"schema_version": 2, "package": metadata, "source": {
        "repository": f"https://github.com/{REPOSITORY}", "commit": args.source_commit, "tag": tag},
        "changelog": provider.changelog}
    (args.output / "submission.json").write_bytes(json_bytes(submission))
    (args.output / "qualification.json").write_bytes(json_bytes(evidence))
    for command, path in (("validate-metadata", "package.json"), ("validate-submission", "submission.json")):
        subprocess.run([str(args.cli), "registry", command, str(args.output / path)], check=True, timeout=60)
    policy = parse_json((pathlib.Path(__file__).parent / "official-plugin-author-policy.json").read_bytes())
    request = {"schema_version": 1, "repository": REPOSITORY, "expected_repository_id": policy["repository_id"],
               "expected_account": policy["author_account"], "tag": tag, "source_commit": args.source_commit,
               "release_notes": submission["changelog"], "prerelease": False, "archive": archives[0],
               "additional_archives": archives[1:], "metadata": {"name": "package.json", "size": len(package), "sha256": digest(package)}}
    data = (json.dumps(request, sort_keys=True, separators=(",", ":")) + "\n").encode()
    (args.output / "request.json").write_bytes(data)
    return digest(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=PROVIDERS, required=True)
    parser.add_argument("--input", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--source-repo", required=True, type=pathlib.Path)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--cli", required=True, type=pathlib.Path)
    print(prepare(parser.parse_args()))
