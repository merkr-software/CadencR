"""Exercise the exact native distribution executable against a scripted agy."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import re
import subprocess
import sys

PLUGIN = pathlib.Path(__file__).resolve().parent.parent
REPO = PLUGIN.parents[2]
sys.path.insert(0, str(REPO / "scripts"))
from native_provider_release_prepare import PROVIDERS, TARGETS, require


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True, type=pathlib.Path)
    parser.add_argument("--target", required=True, choices=TARGETS)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    require(re.fullmatch("[0-9a-f]{40}", args.source_commit), "full source SHA required")
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    machine = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64"}.get(platform.machine())
    require(args.target == f"{system}-{machine}", "qualification must execute on the declared native target")
    binary = args.binary.resolve(strict=True)
    sha256 = hashlib.sha256(binary.read_bytes()).hexdigest()
    version = json.loads((PLUGIN / "package.json").read_text())["version"]
    require(subprocess.check_output([str(binary), "version"], text=True, timeout=10).strip() == version,
            "connector version mismatch")
    integration = json.loads(subprocess.check_output(
        [str(binary), "host-integration", "--format", "cadencr-host-integration-v1"], timeout=10))
    require(integration["compactCommand"] == "compact" and integration["excludeLauncherPorts"] is True and
            integration["resumeCommand"] == {"program": "agy", "args": ["--conversation", "{session_id}"]} and
            ".agents/rules" in integration["worktreeConfigPaths"], "host integration mismatch")
    subprocess.run(["pnpm", "rust", "--", "test", "--locked", "-p",
                    "cadencr-plugin-provider-antigravity", "--test", "proxy_e2e"],
                   cwd=REPO, check=True, timeout=180,
                   env={**os.environ, "CADENCR_ANTIGRAVITY_TEST_BINARY": str(binary)})
    require(hashlib.sha256(binary.read_bytes()).hexdigest() == sha256,
            "distribution executable changed during qualification")
    evidence = PROVIDERS["antigravity"].evidence(args.target, args.source_commit, version, sha256)
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(evidence, output, sort_keys=True, indent=2)
        output.write("\n")


if __name__ == "__main__":
    main()
