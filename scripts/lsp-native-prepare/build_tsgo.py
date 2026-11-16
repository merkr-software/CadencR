#!/usr/bin/env python3
"""Rebuild the reviewed TypeScript native preview executable with a pinned backport."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from archive import executable, sha256

ROOT = Path(__file__).resolve().parents[2]
GOOS = {"linux-x86_64": ("linux", "amd64"), "darwin-aarch64": ("darwin", "arm64"),
        "darwin-x86_64": ("darwin", "amd64")}
REGRESSION_TESTS = ("TestRunExitStatus", "TestRunReportsParentCancellation", "TestRunReportsWriteFailure",
                    "TestRunExitsOnTransportEOFWhileAwaitingClientResponse")


def go_environment(work, offline):
    return {"HOME": str(work), "PATH": "/usr/bin:/bin", "CGO_ENABLED": "0",
            "GOPATH": str(work / "gopath"), "GOCACHE": str(work / "cache"), "GOTOOLCHAIN": "local",
            "GOPROXY": (work / "gopath/pkg/mod/cache/download").as_uri() if offline else "https://proxy.golang.org",
            "GOSUMDB": "off" if offline else "sum.golang.org",
            "GOFLAGS": "-trimpath -mod=readonly -buildvcs=false -modcacherw", "GOTELEMETRY": "off"}


def upstream_entry(recipe, target, files):
    """The reviewed npm executable is what the rebuild replaces; refuse any other."""
    spec = recipe["targets"][target]
    entry = files.get(spec["entry"])
    if entry is None or len(entry) != spec["upstream_entry_size"] or sha256(entry) != spec["upstream_entry_sha256"]:
        raise ValueError("npm executable differs from the reviewed upstream build")
    # A sidecar such as a detached signature attests the replaced bytes, not the rebuild.
    if any(name.startswith(spec["entry"] + ".") for name in files):
        raise ValueError("omit upstream sidecars of the replaced executable")


def reviewed_patch(settings):
    patch = settings["patch"]
    data = (ROOT / patch["path"]).read_bytes()
    if sha256(data) != patch["sha256"]:
        raise ValueError("tsgo backport differs from the reviewed patch")
    return data


def apply_patch(source, patch, data):
    # Ignore any enclosing checkout's configuration; the result hashes below are authoritative.
    env = {"PATH": "/usr/bin:/bin", "HOME": str(source.parent), "GIT_CEILING_DIRECTORIES": str(source.parent)}
    for check in (["--check"], []):
        subprocess.run(["git", "apply", *check, "-"], input=data, cwd=source, env=env, check=True)
    for path, digest in patch["files"].items():
        if sha256((source / path).read_bytes()) != digest:
            raise ValueError("patched tsgo source differs from the reviewed result")


def regression_tests(go, env, source):
    """Run the backport's lifecycle tests; each must report PASS, so a skip fails too."""
    # Upstream test helpers locate the repository root, which -trimpath hides.
    test_env = {**env, "GOFLAGS": env["GOFLAGS"].replace("-trimpath ", "")}
    tests = subprocess.run([str(go), "test", "-count=1", "-v", "-run", "^(" + "|".join(REGRESSION_TESTS) + ")$",
                            "./internal/lsp/"], env=test_env, cwd=source, capture_output=True, check=False)
    output = (tests.stdout + tests.stderr).decode(errors="replace")
    passed = set(re.findall(r"^--- PASS: (\S+) ", output, re.MULTILINE))
    if tests.returncode or not passed.issuperset(REGRESSION_TESTS):
        raise ValueError("tsgo backport regression tests did not all pass: " + output[-4000:])


def module_source(go, settings, env, work):
    module = settings["module"] + "@" + settings["module_version"]
    info = json.loads(subprocess.check_output([str(go), "mod", "download", "-json", module], env=env, cwd=work))
    if info.get("Error") or info["Sum"] != settings["module_sum"] or sha256(Path(info["Zip"]).read_bytes()) != settings["module_zip_sha256"]:
        raise ValueError("tsgo module source differs from the reviewed upstream commit")
    source = work / "source"
    if source.exists():
        shutil.rmtree(source)
    shutil.copytree(info["Dir"], source)
    for directory, _, names in os.walk(source):
        os.chmod(directory, 0o755)
        for name in names:
            os.chmod(os.path.join(directory, name), 0o644)
    return source


def build(recipe, target, go, work, offline=False):
    """Return the rebuilt executable, the shipped patch and provenance for one target."""
    settings = recipe["build"]
    work.mkdir(parents=True, exist_ok=True)
    env = go_environment(work, offline)
    version = subprocess.check_output([str(go), "version"], env=env).decode().split()[2]
    if version != settings["go_version"]:
        raise ValueError("tsgo requires the reviewed Go version")
    patch = reviewed_patch(settings)
    source = module_source(go, settings, env, work)
    apply_patch(source, settings["patch"], patch)
    os_name, arch = GOOS[target]
    host = subprocess.check_output([str(go), "env", "GOOS", "GOARCH"], env=env).decode().split()
    if host == [os_name, arch]:
        regression_tests(go, env, source)
    binary = work / ("tsgo-" + target)
    ldflags = "-s -w -X github.com/microsoft/typescript-go/internal/core.version=" + recipe["version"]
    subprocess.run([str(go), "build", "-tags=" + ",".join(settings["tags"]), "-ldflags=" + ldflags,
                    "-o", str(binary), "./cmd/tsgo"], env={**env, "GOOS": os_name, "GOARCH": arch},
                   cwd=source, check=True)
    data = binary.read_bytes()
    executable(data, target)
    info = subprocess.check_output([str(go), "version", "-m", str(binary)], env=env).decode()
    modules = {}
    for line in info.splitlines():
        fields = line.split()
        if fields and fields[0] == "dep":
            modules[fields[1] + "@" + fields[2]] = fields[3]
    # Architecture-specific packages link a subset of the frozen graph (cpuid is amd64-only).
    if not modules or not modules.items() <= settings["module_sums"].items():
        raise ValueError("tsgo Go dependency graph differs from frozen module sums")
    return data, patch, info.replace(str(binary), "tsgo", 1)
