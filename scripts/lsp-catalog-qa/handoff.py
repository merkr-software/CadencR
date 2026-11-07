"""Closed candidate artifact inventory. A hash receipt never grants publication authority."""
import hashlib
import os
from pathlib import Path
import re
import stat
import sys
import subprocess

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from official_plugin_pack import json_bytes, parse_json

TARGETS = ("darwin-aarch64", "darwin-x86_64", "linux-x86_64")
CLI_VERSION = "0.15.6"
MANIFEST = "handoff.json"
MAX_FILE = 80 * 1024 * 1024
MAX_TREE = 8 * 1024 ** 3
PUBLISHED_TYPESCRIPT_SHA256 = "295472a5ede14af100e3a0fb0eb121d71d2818ee05399ffb3dac3290b0ec7286"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def hex_digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)


def commit(value):
    require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{40}", value), "full source commit required")
    return value


def relative(value):
    require(isinstance(value, str) and len(value) <= 256
            and re.fullmatch(r"[a-zA-Z0-9_./-]+", value)
            and all(part not in ("", ".", "..") for part in value.split("/")), "unsafe candidate artifact path")
    return value


def regular(path, maximum=MAX_FILE):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum, "bounded regular candidate file required")
    data = path.read_bytes()
    require(len(data) == info.st_size, "candidate file changed while reading")
    return data


def files(root):
    captured, total = {}, 0
    for folder, directories, names in os.walk(root, followlinks=False):
        for name in directories:
            require(not (Path(folder) / name).is_symlink(), "candidate artifact directory links are forbidden")
        for name in names:
            path = Path(folder) / name
            name = relative(path.relative_to(root).as_posix())
            data = regular(path)
            total += len(data)
            require(total <= MAX_TREE and len(captured) < 1024, "candidate artifact exceeds handoff budget")
            captured[name] = {"sha256": digest(data), "size": len(data)}
    return captured


def source_manifest(name, source_commit):
    reference = commit(source_commit) + ":packages/cli/" + name
    args = ["git", "--no-optional-locks", "-C", str(ROOT), "cat-file"]
    try:
        size = int(subprocess.check_output([*args, "-s", reference], stderr=subprocess.PIPE, timeout=10))
        require(0 <= size <= 64 * 1024, "source CLI manifest exceeds size limit")
        data = subprocess.check_output([*args, "blob", reference], stderr=subprocess.PIPE, timeout=10)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise ValueError("source CLI manifest unavailable at the handoff commit") from error
    require(len(data) == size, "source CLI manifest size changed")
    return data


def cli_version(origin, source_commit=None):
    require(origin in ("source-build", "released-pin"), "explicit CLI origin required")
    if origin == "released-pin":
        return CLI_VERSION
    manifest = ROOT / "packages/cli"
    def read(name):
        return regular(manifest / name, 64 * 1024) if source_commit is None else source_manifest(name, source_commit)
    cargo = read("Cargo.toml").decode()
    package = re.search(r"(?ms)^\[package\][ \t]*\n(.*?)(?=^\[|\Z)", cargo)
    versions = re.findall(r'^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"[ \t]*$',
                          package[1], re.MULTILINE) if package else []
    version = parse_json(read("package.json"))["version"]
    require(len(versions) == 1 and versions[0] == version, "source CLI manifest versions must match exactly")
    return version


def provenance(origin, cli_sha256, source_commit, pin_sha256=None, *, version_source=None):
    require(origin in ("source-build", "released-pin") and hex_digest(cli_sha256), "explicit CLI provenance required")
    value = {"origin": origin, "version": cli_version(origin, version_source), "sha256": cli_sha256}
    if origin == "source-build":
        require(pin_sha256 is None, "a source-built CLI cannot claim a released pin")
        value["source_commit"] = commit(source_commit)
    else:
        require(hex_digest(pin_sha256), "released CLI requires the checked pin digest")
        value["pin_sha256"] = pin_sha256
    return value


def data_paths(packages):
    expected = {"preparation.json"}
    for package in packages:
        identifier = package["id"]
        require(isinstance(identifier, str) and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", identifier), "invalid candidate identifier")
        require(set(package["targets"]) == set(TARGETS), "three candidate targets required")
        runtimes = {target["runtime"] for target in package["targets"].values()}
        require(runtimes in ({"node"}, {"native"}), "one supported runtime per candidate required")
        expected.update(identifier + "/" + name for name in ("package-template.json", "recipe.json"))
        folders = TARGETS if runtimes == {"native"} else ("all",)
        expected.update(identifier + "/payload/" + folder + "/" + name
                        for folder in folders for name in ("bundle.tar.gz", "source-lock.json"))
    return expected


def create(root, source_commit, cli):
    preparation = parse_json(regular(root / "preparation.json", 4 * 1024 * 1024))
    require(preparation["source_commit"] == commit(source_commit)
            and preparation["cli"] == cli and preparation["publication_authority"] is False
            and preparation["authority"] == "candidate", "preparation provenance differs from handoff")
    packages = preparation["packages"]
    require(packages and all(package["status"] == "packed" for package in packages), "all candidates must pack before handoff")
    identifiers = [package["id"] for package in packages]
    require(len(identifiers) == len(set(identifiers)), "candidate identifiers must be unique")
    value = {"schema_version": 1, "authority": "candidate", "publication_authority": False,
             "source_commit": source_commit, "cli": cli, "package_ids": sorted(identifiers),
             "runtime_qualification": "PENDING", "files": files(root)}
    require(set(value["files"]) == data_paths(packages), "handoff must contain only held archives and reviewed data")
    raw = json_bytes(value)
    with (root / MANIFEST).open("xb") as stream:
        stream.write(raw)
    return digest(raw)


def verify(root, expected_sha256, source_commit):
    require(hex_digest(expected_sha256), "exact handoff manifest digest required")
    raw = regular(root / MANIFEST, 1024 * 1024)
    require(digest(raw) == expected_sha256, "candidate handoff manifest digest mismatch")
    manifest = parse_json(raw)
    require(set(manifest) == {"schema_version", "authority", "publication_authority", "source_commit", "cli",
                              "package_ids", "runtime_qualification", "files"}
            and type(manifest["schema_version"]) is int and manifest["schema_version"] == 1
            and manifest["authority"] == "candidate" and manifest["publication_authority"] is False
            and manifest["runtime_qualification"] == "PENDING"
            and manifest["source_commit"] == commit(source_commit), "invalid candidate handoff context")
    cli = manifest["cli"]
    require(isinstance(cli, dict), "candidate CLI provenance must be an object")
    require(cli == provenance(cli.get("origin"), cli.get("sha256"), source_commit, cli.get("pin_sha256"),
                              version_source=source_commit),
            "invalid candidate CLI provenance")
    require(isinstance(manifest["files"], dict) and all(
        isinstance(item, dict) and set(item) == {"sha256", "size"} and hex_digest(item["sha256"])
        and type(item["size"]) is int and 0 <= item["size"] <= MAX_FILE
        for item in manifest["files"].values()), "invalid candidate file hash or size declaration")
    captured = files(root)
    del captured[MANIFEST]
    require(captured == manifest["files"], "candidate artifact bytes, size or closed inventory differ")
    preparation = parse_json(regular(root / "preparation.json", 4 * 1024 * 1024))
    require(preparation["cli"] == cli and preparation["source_commit"] == source_commit
            and preparation["authority"] == "candidate" and preparation["publication_authority"] is False,
            "candidate preparation context mismatch")
    packages = preparation["packages"]
    require(sorted(package["id"] for package in packages) == manifest["package_ids"]
            and len(set(manifest["package_ids"])) == len(packages)
            and all(package["status"] == "packed" for package in packages), "incomplete candidate set")
    require(set(captured) == data_paths(packages), "handoff contains unreviewed artifact paths")
    for package in packages:
        identifier = package["id"]
        require(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", identifier), "invalid candidate identifier")
        require(package.get("provenance") in ("held-candidate", "published-baseline"), "candidate provenance required")
        metadata = regular(root / identifier / "package-template.json", 1024 * 1024)
        require(digest(metadata) == package["manifest_sha256"], "candidate metadata digest mismatch")
        require(set(package["targets"]) == set(TARGETS), "all three candidate targets required")
        if package["provenance"] == "published-baseline":
            require(identifier == "typescript-language-server" and all(
                target["sha256"] == PUBLISHED_TYPESCRIPT_SHA256 for target in package["targets"].values()),
                "published TypeScript baseline bytes changed")
    return manifest, packages
