"""Verify an artifact-bound candidate, then exercise real features on its native host."""
import argparse
import json
import os
from pathlib import Path
import stat
import resource
import platform
import subprocess
import sys

from handoff import ROOT, TARGETS, digest, hex_digest, regular, require, verify
import isolation
sys.path.insert(0, str(ROOT / "scripts"))
from official_plugin_lsp_archive import inventory, unpack
from official_plugin_pack import parse_json


class ProbeFailure(ValueError):
    pass


def write_json(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write("\n")


def verify_tree(root, expected):
    actual = set()
    for folder, directories, names in os.walk(root, followlinks=False):
        require(all(not (Path(folder) / name).is_symlink() for name in directories), "runtime directory link refused")
        for name in names:
            path = Path(folder) / name
            name = path.relative_to(root).as_posix()
            require(name in expected and name not in actual, "runtime contains unreviewed content")
            item = expected[name]
            data = regular(path, 256 * 1024 * 1024)
            require(len(data) == item["size"] and digest(data) == item["sha256"], "runtime inventory content changed")
            mode = 0o755 if item.get("mode") == "100755" else 0o644
            require(stat.S_IMODE(path.stat().st_mode) == mode, "runtime inventory mode changed")
            actual.add(name)
    require(actual == set(expected), "runtime inventory is incomplete")


def prerequisites(root, expected_sha256, source_commit):
    require(hex_digest(expected_sha256), "exact prerequisite manifest hash required")
    raw = regular(root / "prerequisites.json", 1024 * 1024)
    require(digest(raw) == expected_sha256, "prerequisite manifest digest mismatch")
    value = parse_json(raw)
    require(value["source_commit"] == source_commit and value["authority"] == "candidate"
            and value["publication_authority"] is False, "prerequisite source context mismatch")
    node = Path(value["node"]["path"])
    require(node.is_absolute() and value["node"]["version"] == "22.19.0"
            and digest(regular(node, 256 * 1024 * 1024)) == value["node"]["sha256"], "Node test binary differs from prerequisite receipt")
    dependencies = {}
    require(set(value["fixtures"]) == {"eslint", "tailwind"}, "both frozen project fixtures are required")
    for identifier, fixture in value["fixtures"].items():
        require(fixture["directory"] == identifier, "invalid project fixture directory")
        folder = root / identifier
        lock = regular(folder / "source-lock.json", 16 * 1024 * 1024)
        require(digest(lock) == fixture["source_lock_sha256"], "project fixture inventory digest mismatch")
        verify_tree(folder / "bundle", inventory(parse_json(lock)))
        dependencies[identifier] = folder / "bundle/node_modules"
    go_raw = regular(root / "go/toolchain-manifest.json", 1024 * 1024)
    require(value["go"]["directory"] == "go" and digest(go_raw) == value["go"]["manifest_sha256"], "Go toolchain receipt mismatch")
    go = parse_json(go_raw)
    go_entry = root / "go/go/bin/go"
    recipe = parse_json(regular(ROOT / "plugins/lsp/native-recipes/gopls.json", 1024 * 1024))
    require(go["go_version"] == recipe["build"]["go_version"] and go["sources"] == recipe["build"]["toolchains"]
            and Path(go["go_entry"]) == go_entry.resolve()
            and digest(regular(go_entry, 256 * 1024 * 1024)) == go["go_sha256"], "Go runtime is not the reviewed pinned toolchain")
    return node, dependencies, go_entry.parent


def package_input(handoff, record, target, work):
    source = handoff / record["id"]
    raw = regular(source / "package-template.json", 1024 * 1024)
    package = parse_json(raw)
    recipe_raw = regular(source / "recipe.json", 1024 * 1024)
    recipe = parse_json(recipe_raw)
    descriptor = package["package"]["lsp"]
    require(digest(raw) == record["manifest_sha256"] and digest(recipe_raw) == record["source_recipe_sha256"], "candidate metadata or recipe drift")
    require(package["kind"] == "lsp" and descriptor["id"] == record["id"] == recipe["id"]
            and descriptor["version"] == recipe["package_version"]
            and descriptor["distribution"]["binary"] == record["targets"], "candidate identity or target bindings differ")
    selected = record["targets"][target]
    folder = target if selected["runtime"] == "native" else "all"
    stage = source / "payload" / folder
    archive = regular(stage / "bundle.tar.gz", 64 * 1024 * 1024)
    require(digest(archive) == selected["sha256"] and len(archive) == selected["size"], "candidate archive differs from signed target")
    lock_raw = regular(stage / "source-lock.json", 16 * 1024 * 1024)
    expected = inventory(parse_json(lock_raw))
    require(selected["entry"] in expected and selected["entry_sha256"] == expected[selected["entry"]]["sha256"]
            and selected["entry_size"] == expected[selected["entry"]]["size"], "candidate launch entry differs from source inventory")
    require(recipe["entry"] == selected["entry"] if selected["runtime"] == "node" else
            recipe["targets"][target]["entry"] == selected["entry"], "recipe launch entry mismatch")
    if selected["runtime"] == "node":
        require(selected.get("node_min_version", "20.0.0") == recipe["runtime_requirements"]["minimum_version"], "signed Node prerequisite mismatch")
    destination = work / "bundle"
    unpack(stage, destination, descriptor["version"], package["package"]["host"]["compatibility"]["min_app_version"],
           identity=record["id"], target=target, runtime=selected["runtime"], entry=selected["entry"])
    verify_tree(destination, expected)
    return recipe, source / "recipe.json", selected, destination, expected, stage / "bundle.tar.gz"


def probe(arguments, work, report, diagnostics):
    with (diagnostics / "stdout.log").open("xb") as stdout, (diagnostics / "stderr.log").open("xb") as stderr:
        completed = subprocess.run([str(value) for value in arguments], cwd=ROOT,
            env={"PATH": "/usr/bin:/bin", "HOME": str(work), "TMPDIR": str(work), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
            stdout=stdout, stderr=stderr, timeout=180, check=False,
            preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024)))
    require(report.is_file(), "semantic probe produced no report")
    result = parse_json(regular(report, 4 * 1024 * 1024))
    if completed.returncode or result.get("status") != "passed":
        raise ProbeFailure("real semantic probe failed; inspect the separate diagnostic artifact")
    require(result.get("network") == "denied" and result.get("credentials") == "none"
            and result.get("feature") in {"diagnostics", "diagnostic", "push", "hover", "completion", "documentSymbol"},
            "a passing real language feature is required; initialization alone is insufficient")
    return result


def candidate(args, record, node, dependencies, go_bin, read_only):
    identifier = record["id"]
    work = args.work / identifier
    work.mkdir()
    diagnostic = args.diagnostics / identifier
    diagnostic.mkdir()
    summary = {"id": identifier, "target": args.target, "provenance": record["provenance"],
               "archive_sha256": record["targets"][args.target]["sha256"], "status": "failed"}
    try:
        recipe, recipe_path, selected, bundle, expected, archive = package_input(args.handoff, record, args.target, work)
        if args.verify_only:
            summary["status"] = "data-verified"
            return summary
        report = diagnostic / "semantic.json"
        if selected["runtime"] == "node":
            command = [sys.executable, "-B", ROOT / "scripts/lsp-catalog-prepare/node_smoke.py", "--recipe", recipe_path,
                       "--bundle", bundle, "--node", node, "--work", work / "probe", "--output", report, "--empty-host-settings"]
            project = "tailwind" if identifier == "tailwindcss-language-server" else identifier
            if project in dependencies:
                command.extend(["--project-dependencies", dependencies[project]])
        else:
            command = [sys.executable, "-B", ROOT / "scripts/lsp-native-prepare/native_semantic.py", "--recipe", recipe_path,
                       "--bundle", bundle, "--target", args.target, "--output", report]
            if identifier == "gopls":
                command.extend(["--toolchain-path", go_bin])
        for root in read_only:
            command.extend(["--read-only-root", root])
        result = probe(command, work, report, diagnostic)
        verify_tree(bundle, expected)
        require(digest(regular(archive, 64 * 1024 * 1024)) == selected["sha256"], "tested candidate archive changed")
        summary.update(status="passed", feature=result["feature"], report_sha256=digest(report.read_bytes()))
    except (Exception, SystemExit) as error:
        write_json(diagnostic / "failure.json", {"error": type(error).__name__ + ": " + str(error)})
        summary["failure_code"] = type(error).__name__
    finally:
        stderr = work / "probe/stderr.log"
        if stderr.is_file() and not stderr.is_symlink():
            with stderr.open("rb") as stream:
                stream.seek(max(0, stderr.stat().st_size - 16384))
                (diagnostic / "server-stderr.log").write_bytes(stream.read(16384))
    return summary


def run(args):
    args.work.mkdir(parents=True, exist_ok=False)
    args.evidence.mkdir(parents=True, exist_ok=False)
    args.diagnostics.mkdir(parents=True, exist_ok=False)
    evidence = {"schema_version": 1, "authority": "candidate", "publication_authority": False,
                "source_commit": args.source_commit, "handoff_sha256": args.manifest_sha256,
                "target": args.target, "host": {"platform": platform.system(), "architecture": platform.machine(),
                    "kernel": platform.release(), "distribution": platform.freedesktop_os_release().get("PRETTY_NAME") if sys.platform == "linux" else platform.mac_ver()[0]},
                "runtime_qualification": "PENDING", "packages": []}
    try:
        manifest, packages = verify(args.handoff, args.manifest_sha256, args.source_commit)
        evidence["cli"] = manifest["cli"]
        if args.verify_only:
            node, dependencies, go_bin, read_only = None, {}, None, []
            evidence["scope"] = "data verification only; no candidate process executed"
        else:
            require(isolation.host_target() == args.target, "runtime target must match the real host OS and architecture")
            isolation.verify_source(args.source_commit)
            require(args.prerequisites is not None, "preacquired runtime prerequisites are required")
            node, dependencies, go_bin = prerequisites(args.prerequisites, args.prerequisites_sha256, args.source_commit)
            read_only = [ROOT, args.handoff, args.prerequisites, node.parent.parent]
            evidence["isolation"] = isolation.verify(read_only, args.work)
            evidence["scope"] = "real semantic features on the exact canonical candidate archive; app qualification is separate"
        for record in packages:
            result = candidate(args, record, node, dependencies, go_bin, read_only)
            evidence["packages"].append(result)
            print(json.dumps({key: result[key] for key in ("id", "target", "status")}), flush=True)
        verify(args.handoff, args.manifest_sha256, args.source_commit)
        passed = all(package["status"] == ("data-verified" if args.verify_only else "passed") for package in evidence["packages"])
        evidence["status"] = "data-verified" if args.verify_only and passed else "passed" if passed else "failed"
        if passed and not args.verify_only:
            evidence["runtime_qualification"] = "passed-on-this-target-only"
    except (Exception, SystemExit) as error:
        write_json(args.diagnostics / "runner-failure.json", {"error": type(error).__name__ + ": " + str(error)})
        evidence.update(status="failed", failure_code=type(error).__name__)
        passed = False
    write_json(args.evidence / "runtime.json", evidence)
    return passed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("handoff", "work", "evidence", "diagnostics"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--target", choices=TARGETS, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--prerequisites", type=Path)
    parser.add_argument("--prerequisites-sha256")
    parser.add_argument("--verify-only", action="store_true")
    sys.exit(0 if run(parser.parse_args()) else 1)
