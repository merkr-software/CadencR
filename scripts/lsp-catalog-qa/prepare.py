"""Prepare held LSP candidates; no publication credentials or registry mutations."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
TARGETS = ("darwin-aarch64", "darwin-x86_64", "linux-x86_64")
REPOSITORY = "https://github.com/merkr-software/CadencR"
sys.path.insert(0, str(ROOT / "scripts"))
from official_plugin_lsp_archive import inventory, inspect_bundle, unpack, MAX_ARCHIVE, MAX_EXPANDED
from handoff import cli_version, create, provenance, regular, require, commit, PUBLISHED_TYPESCRIPT_SHA256
from official_plugin_pack import parse_json


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def invoke(args, work):
    env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "TMPDIR": str(work),
           "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
    result = subprocess.run([str(arg) for arg in args], env=env, cwd=ROOT,
                            capture_output=True, timeout=600, check=False)
    if result.returncode:
        raise RuntimeError(f"candidate preparation failed: {result.stderr.decode(errors='replace')[-16000:]}")
    return parse_json(result.stdout)


def acquire_node(recipe, path, work, cache, source_commit):
    lock_path = path.parent / "payload/source-lock.json"
    expected = parse_json(lock_path.read_bytes())
    npm_path = path.parent / "payload/npm-lock.json"
    npm = parse_json(npm_path.read_bytes())
    selected = {source["destination"] for source in expected["sources"]}
    args = [sys.executable, "-B", ROOT / "scripts/lsp-catalog-prepare/node_acquire.py",
            "--npm-lock", npm_path, "--id", recipe["id"], "--entry", recipe.get("upstream_entry", recipe["entry"]),
            "--cache", cache, "--output", work / "acquired"]
    for name, package in npm["packages"].items():
        if name in selected and package.get("optional"):
            args.extend(["--include-optional", name])
    invoke(args, work)
    acquired = work / "acquired"
    if parse_json((acquired / "source-lock.json").read_bytes()) != expected:
        raise ValueError("acquired Node inventory differs from the reviewed source lock")
    if recipe.get("local_overlay"):
        invoke([sys.executable, "-B", ROOT / "scripts/lsp-catalog-prepare/node_overlay.py",
                "--source-commit", source_commit, "--recipe", path, "--candidate", acquired], work)
    return {target: (acquired / "bundle", acquired / "source-lock.json") for target in TARGETS}


def acquire_native(recipe, path, work, cache):
    targets = {}
    for target in TARGETS:
        output = work / target
        args = [sys.executable, "-B", ROOT / "scripts/lsp-native-prepare/prepare.py",
                "--recipe", path, "--target", target, "--cache", cache, "--output", output]
        if recipe["targets"][target].get("transform") == "gnu-strip-debug-2.42":
            args.extend(["--strip-program", "/usr/bin/strip"])
        invoke(args, work)
        targets[target] = (output / "runtime", output / "source-lock.json")
    return targets


def pack_target(cli, recipe, target, source, work):
    tree, lock_path = source
    lock = parse_json(lock_path.read_bytes())
    expected = inventory(lock)
    entry_path = lock["entry"] if "entry" in lock else recipe["entry"]
    runtime = lock["runtime"] if "runtime" in lock else recipe["runtime"]
    entry = expected[entry_path]
    output = work / (target + ".tar.gz")
    args = [cli, "registry", "pack-lsp", "--directory", tree, "--target", target,
            "--entry", entry_path, "--runtime", runtime, "--output"]
    receipt = invoke([*args, output], work)
    data = output.read_bytes()
    facts = {"kind": "lsp", "target": target, "archive": str(output), "sha256": digest(data),
             "size": len(data), "entry": entry_path, "entry_sha256": entry["sha256"],
             "entry_size": entry["size"], "runtime": runtime}
    if receipt != facts:
        raise ValueError("canonical CLI receipt differs from the reviewed inventory")
    repeat = work / ("repeat-" + target + ".tar.gz")
    if invoke([*args, repeat], work) != dict(facts, archive=str(repeat)) or repeat.read_bytes() != data:
        raise ValueError("non-deterministic canonical LSP archive")
    inspect_bundle(data, expected, MAX_EXPANDED, MAX_ARCHIVE)
    name = f"lsp-{recipe['id']}-{recipe['package_version']}-{target}.tar.gz"
    tag = f"lsp-{recipe['id']}-v{recipe['package_version']}"
    signed = {key: facts[key] for key in ("sha256", "size", "entry", "entry_sha256", "entry_size", "runtime")}
    signed["archive"] = f"{REPOSITORY}/releases/download/{tag}/{name}"
    if runtime == "node" and lock["schema_version"] == 2:
        signed["node_min_version"] = recipe["runtime_requirements"]["minimum_version"]
    if runtime == "native" and "macos_min_version" in recipe["targets"][target]:
        signed["macos_min_version"] = recipe["targets"][target]["macos_min_version"]
    return signed, data, lock_path.read_bytes()


def metadata(recipe, targets):
    descriptor = {key: recipe[key] for key in (
        "id", "name", "description", "license", "args", "role", "languages", "root_markers",
        "initialization_options")}
    descriptor.update(version=recipe["package_version"], repository=REPOSITORY,
                      protocol_version=1, distribution={"binary": targets})
    return {"kind": "lsp", "package": {"lsp": descriptor, "host": {
        "publisher": "merkr-software", "compatibility": {"min_app_version": recipe["min_app_version"]}}}}


def prepare_one(cli, path, work, cache, output, source_commit):
    recipe = parse_json(path.read_bytes())
    work.mkdir()
    output.mkdir()
    native = "targets" in recipe
    acquired = acquire_native(recipe, path, work, cache) if native else acquire_node(recipe, path, work, cache, source_commit)
    targets, locks = {}, {}
    for target in TARGETS:
        signed, data, lock_bytes = pack_target(cli, recipe, target, acquired[target], work)
        targets[target] = signed
        folder = target if native else "all"
        if folder in locks:
            if locks[folder] != (digest(data), digest(lock_bytes)):
                raise ValueError("shared Node bundle differs between targets")
            continue
        destination = output / "payload" / folder
        destination.mkdir(parents=True)
        (destination / "bundle.tar.gz").write_bytes(data)
        (destination / "source-lock.json").write_bytes(lock_bytes)
        locks[folder] = (digest(data), digest(lock_bytes))
    package = metadata(recipe, targets)
    write_json(output / "package-template.json", package)
    for tree in {source[0] for source in acquired.values()}:
        write_json(tree / "lsp.json", package)
    for target in TARGETS:
        invoke([cli, "plugin", "validate", acquired[target][0], "--kind", "lsp",
                "--target", target, "--archive", work / (target + ".tar.gz"), "--json"], work)
    (output / "recipe.json").write_bytes(path.read_bytes())
    return {"id": recipe["id"], "status": "packed", "provenance": "held-candidate", "source_recipe_sha256": digest(path.read_bytes()),
            "manifest_sha256": digest((output / "package-template.json").read_bytes()), "targets": targets}


def published_baseline(cli, work, output):
    source = ROOT / "plugins/lsp/typescript-language-server"
    package_bytes = (source / "package-template.json").read_bytes()
    package = parse_json(package_bytes)
    descriptor = package["package"]["lsp"]
    archive = (source / "payload/bundle.tar.gz").read_bytes()
    require(digest(archive) == PUBLISHED_TYPESCRIPT_SHA256, "published TypeScript archive digest changed")
    work.mkdir()
    output.mkdir()
    runtime = work / "runtime"
    unpack(source / "payload", runtime, "0.1.0", "0.16.1")
    recipe = {**{key: value for key, value in descriptor.items() if key not in ("distribution", "protocol_version", "version")},
              "package_version": "0.1.0", "min_app_version": "0.16.1", "entry": "lib/cli.mjs", "runtime": "node",
              "runtime_requirements": {"minimum_version": "20.0.0", "qualified_version": "22.19.0"}}
    for target in TARGETS:
        signed, data, _ = pack_target(cli, recipe, target, (runtime, source / "payload/source-lock.json"), work)
        require(signed == descriptor["distribution"]["binary"][target] and data == archive,
                "published TypeScript baseline must remain byte-identical")
    payload = output / "payload/all"
    payload.mkdir(parents=True)
    for name in ("bundle.tar.gz", "source-lock.json"):
        shutil.copyfile(source / "payload" / name, payload / name)
    (output / "package-template.json").write_bytes(package_bytes)
    write_json(output / "recipe.json", recipe)
    write_json(runtime / "lsp.json", package)
    for target in TARGETS:
        invoke([cli, "plugin", "validate", runtime, "--kind", "lsp", "--target", target,
                "--archive", work / (target + ".tar.gz"), "--json"], work)
    return {"id": descriptor["id"], "status": "packed", "provenance": "published-baseline",
            "source_recipe_sha256": digest((output / "recipe.json").read_bytes()),
            "manifest_sha256": digest(package_bytes), "targets": descriptor["distribution"]["binary"]}


def cli_provenance(args):
    commit(args.source_commit)
    require(re.fullmatch(r"[a-f0-9]{64}", args.cli_sha256), "exact CLI checksum required")
    cli = regular(args.cli, 128 * 1024 * 1024)
    require(digest(cli) == args.cli_sha256, "CLI checksum mismatch")
    require(cli[:6] == b"\x7fELF\x02\x01" and cli[18:20] == b">\0", "canonical packing requires the Linux x86_64 CLI")
    result = subprocess.run([str(args.cli), "--version"], env={"PATH": "/usr/bin:/bin"},
                            capture_output=True, timeout=30, check=True)
    expected_version = cli_version(args.cli_origin)
    require(result.stdout.strip() == ("cadencr " + expected_version).encode(), "CLI origin/version mismatch")
    pin_sha256 = None
    if args.cli_origin == "released-pin":
        require(args.released_pin is not None and args.released_pin.resolve() == ROOT / "scripts/cli-qualification.env",
                "released CLI mode requires the checked-in qualification pin")
        raw = regular(args.released_pin, 4096)
        pins = dict(line.split("=", 1) for line in raw.decode().splitlines() if line and not line.startswith("#"))
        require(pins == {"CADENCR_RELEASE_VERSION": "0.15.6", "CADENCR_RELEASE_SHA256": args.cli_sha256,
                         "CADENCR_RELEASE_TAG": "cli/v0.15.6"}, "released CLI pin is not the reviewed 0.15.6 pin")
        pin_sha256 = digest(raw)
    else:
        require(args.released_pin is None, "source builds cannot claim a released CLI pin")
    return provenance(args.cli_origin, args.cli_sha256, args.source_commit, pin_sha256)


def source_snapshot(source_commit):
    actual = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"]).decode().strip()
    require(actual == source_commit, "source commit must equal checked-out HEAD")
    paths = ["plugins/lsp", "scripts/lsp-catalog-qa", "scripts/lsp-catalog-prepare", "scripts/lsp-native-prepare",
             "packages/cli/Cargo.toml", "packages/cli/package.json"]
    subprocess.run(["git", "-C", str(ROOT), "diff", "--quiet", source_commit, "--", *paths], check=True)
    untracked = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "--others", "--exclude-standard", "--", *paths])
    require(not untracked, "all candidate sources and qualification helpers must be committed")


def prepare(args):
    source_snapshot(args.source_commit)
    cli = cli_provenance(args)
    args.output.mkdir(parents=True, exist_ok=False)
    args.work.mkdir(parents=True, exist_ok=False)
    diagnostics = args.work / "diagnostics"
    diagnostics.mkdir()
    cache = args.work / "source-cache"
    cache.mkdir()
    paths = sorted((ROOT / "plugins/lsp").glob("*/recipe.json"))
    paths += sorted((ROOT / "plugins/lsp/native-recipes").glob("*.json"))
    recipes = {}
    for path in paths:
        identifier = parse_json(path.read_bytes())["id"]
        require(identifier not in recipes, "duplicate candidate recipe id")
        recipes[identifier] = path
    recipes["typescript-language-server"] = None
    selected = args.ids.split(",") if args.ids else sorted(recipes)
    require(len(set(selected)) == len(selected) and all(identifier in recipes for identifier in selected),
            "requested candidate IDs must be unique reviewed recipes")
    require(bool(args.ids) or len(selected) == 25, "full qualification requires 24 held candidates and the published TypeScript baseline")
    evidence = {"schema_version": 1, "authority": "candidate", "publication_authority": False,
                "source_commit": args.source_commit, "cli": cli, "full_catalog": not bool(args.ids),
                "scope": "canonical packaging only; runtime and app qualification are separate", "packages": []}
    for identifier in selected:
        try:
            if recipes[identifier] is None:
                result = published_baseline(args.cli, args.work / identifier, args.output / identifier)
            else:
                result = prepare_one(args.cli, recipes[identifier], args.work / identifier,
                                     cache, args.output / identifier, args.source_commit)
        except (Exception, SystemExit) as error:
            write_json(diagnostics / (identifier + ".json"), {"id": identifier, "error": type(error).__name__ + ": " + str(error)})
            result = {"id": identifier, "status": "failed", "failure_code": type(error).__name__}
        evidence["packages"].append(result)
        print(json.dumps({key: result[key] for key in ("id", "status")}), flush=True)
    write_json(args.output / "preparation.json", evidence)
    passed = all(package["status"] == "packed" for package in evidence["packages"])
    if passed:
        manifest_sha256 = create(args.output, args.source_commit, cli)
        print(json.dumps({"manifest_sha256": manifest_sha256, "publication_authority": False}), flush=True)
    return passed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ("cli", "work", "output"):
        parser.add_argument("--" + argument, type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--cli-sha256", required=True)
    parser.add_argument("--cli-origin", choices=("source-build", "released-pin"), required=True)
    parser.add_argument("--released-pin", type=Path)
    parser.add_argument("--ids")
    sys.exit(0 if prepare(parser.parse_args()) else 1)
