"""Acquire frozen test dependencies before entering the runtime network sandbox."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from handoff import ROOT, commit, digest, regular, require
from official_plugin_pack import parse_json

FIXTURES = {"eslint": "node_modules/eslint/bin/eslint.js", "tailwind": "node_modules/tailwindcss/dist/lib.js"}


def invoke(arguments, home):
    result = subprocess.run([str(value) for value in arguments], cwd=ROOT,
        env={"PATH": "/usr/bin:/bin", "HOME": str(home), "TMPDIR": str(home)},
        capture_output=True, timeout=600, check=False)
    if result.returncode:
        raise RuntimeError("prerequisite acquisition failed: " + result.stderr.decode(errors="replace")[-16000:])


def acquire(args):
    commit(args.source_commit)
    args.output.mkdir(parents=True, exist_ok=False)
    args.cache.mkdir(parents=True, exist_ok=True)
    node = args.node.resolve(strict=True)
    version = subprocess.check_output([str(node), "--version"], env={"PATH": "/usr/bin:/bin"}, timeout=15).strip()
    require(version == b"v22.19.0", "exact Node 22.19.0 test baseline required")
    manifest = {"schema_version": 1, "authority": "candidate", "publication_authority": False,
                "source_commit": args.source_commit, "node": {"path": str(node), "version": "22.19.0",
                "sha256": digest(regular(node, 256 * 1024 * 1024))}, "fixtures": {}}
    for identifier, entry in FIXTURES.items():
        source = ROOT / "scripts/lsp-catalog-prepare/fixtures" / identifier
        destination = args.output / identifier
        invoke([sys.executable, "-B", ROOT / "scripts/lsp-catalog-prepare/node_acquire.py",
            "--npm-lock", source / "npm-lock.json", "--entry", entry, "--id", identifier + "-fixture",
            "--output", destination, "--cache", args.cache], args.output)
        expected = parse_json((source / "source-lock.json").read_bytes())
        require(parse_json((destination / "source-lock.json").read_bytes()) == expected,
                "test dependency acquisition differs from frozen inventory")
        manifest["fixtures"][identifier] = {"directory": identifier,
            "source_lock_sha256": digest((destination / "source-lock.json").read_bytes()),
            "npm_lock_sha256": digest((source / "npm-lock.json").read_bytes())}
    invoke([sys.executable, "-B", ROOT / "scripts/lsp-native-prepare/go_toolchain.py",
        "--recipe", ROOT / "plugins/lsp/native-recipes/gopls.json", "--cache", args.cache,
        "--output", args.output / "go"], args.output)
    manifest["go"] = {"directory": "go", "manifest_sha256": digest((args.output / "go/toolchain-manifest.json").read_bytes())}
    raw = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    (args.output / "prerequisites.json").write_bytes(raw)
    print(json.dumps({"prerequisites_sha256": digest(raw), "publication_authority": False}))
    return digest(raw)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("node", "output", "cache"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    acquire(parser.parse_args())
