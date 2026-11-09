#!/usr/bin/env python3
"""Acquire a reviewed native recipe without running upstream code or installers."""
import argparse
import json
from pathlib import Path
import urllib.parse
import urllib.request

from transform import transform

from archive import MAX_DOWNLOAD, bounded, executable, safe_name, retained, sha256

HOSTS = {"github.com", "registry.npmjs.org", "releases.hashicorp.com", "raw.githubusercontent.com"}


def acquire(spec, cache, offline):
    parsed = urllib.parse.urlsplit(spec["url"])
    if parsed.scheme != "https" or parsed.hostname not in HOSTS or parsed.username or parsed.password:
        raise ValueError("source must use an approved public HTTPS origin")
    digest = spec["sha256"]
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("recipe must pin a SHA-256 before acquisition")
    path = cache / sha256(spec["url"].encode())
    if path.is_symlink():
        raise ValueError("cache entry must not be a symlink")
    if path.exists():
        with path.open("rb") as stream:
            data = bounded(stream, MAX_DOWNLOAD)
    else:
        if offline:
            raise ValueError(f"missing offline cache entry: {path}")
        with urllib.request.urlopen(spec["url"], timeout=60) as response:
            data = bounded(response, MAX_DOWNLOAD)
        with path.open("xb") as stream:
            stream.write(data)
    if len(data) != spec["size"] or sha256(data) != digest:
        raise ValueError("source size or SHA-256 mismatch")
    return data


def prepare(recipe, target, cache, output, offline=False, strip_program=None):
    spec = recipe["targets"][target]
    if spec["format"] == "go-source":
        from build_gopls import build
        from go_toolchain import toolchain
        cache.mkdir(parents=True, exist_ok=True)
        with toolchain(recipe, cache, offline) as go:
            return build(recipe, target, go, cache / "gopls-build", output, offline)
    if recipe.get("blocked"):
        raise ValueError(recipe["blocked"])
    if not safe_name(spec["entry"]):
        raise ValueError("unsafe executable destination")
    cache.mkdir(parents=True, exist_ok=True)
    data = acquire(spec, cache, offline)
    files = retained(data, spec)
    rebuilt = None
    if recipe.get("build", {}).get("kind") == "patched-go-module":
        from build_tsgo import build, upstream_entry
        from go_toolchain import toolchain
        upstream_entry(recipe, target, files)
        with toolchain(recipe, cache, offline) as go:
            rebuilt = build(recipe, target, go, cache / "tsgo-build", offline)
        files[spec["entry"]] = rebuilt[0]
    else:
        files[spec["entry"]] = transform(files[spec["entry"]], spec, target, strip_program)
    entry = files[spec["entry"]]
    executable(entry, target)
    if len(entry) != spec["entry_size"] or sha256(entry) != spec["entry_sha256"]:
        raise ValueError("selected executable differs from reviewed recipe")
    main_files = files.copy()
    extra_files = []
    if rebuilt:
        patch_path = recipe["build"]["patch"]["shipped_as"]
        if not safe_name(patch_path) or patch_path in files:
            raise ValueError("unsafe/duplicate shipped patch destination")
        del main_files[spec["entry"]]
        files[patch_path] = rebuilt[1]
    for source in recipe.get("extra_sources", []):
        if not safe_name(source["path"]) or source["path"] in files:
            raise ValueError("unsafe/duplicate extra source destination")
        content = acquire(source, cache, offline)
        files[source["path"]] = content
        extra_files.append((source, content))
    output.mkdir(parents=True, exist_ok=False)
    runtime = output / "runtime"
    runtime.mkdir()
    for name, content in files.items():
        path = runtime / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(0o755 if name == spec["entry"] else 0o644)
    lock = {"schema_version": 2, "id": recipe["id"], "package_version": recipe["package_version"],
            "min_app_version": recipe["min_app_version"], "runtime": "native", "entry": spec["entry"],
            "target": target, "sources": [{"name": recipe["id"], "version": recipe["version"],
            "url": spec["url"], "sha256": spec["sha256"], "destination": ".",
            "expanded_size": sum(map(len, main_files.values())), "files": [
            {"path": name, "sha256": sha256(content), "size": len(content),
             "mode": "100755" if name == spec["entry"] else "100644"}
            for name, content in sorted(main_files.items())]}]}
    for source, content in extra_files:
        lock["sources"].append({"name": source["name"], "version": source["version"], "url": source["url"],
            "sha256": source["sha256"], "destination": ".", "expanded_size": len(content),
            "files": [{"path": source["path"], "sha256": sha256(content), "size": len(content), "mode": "100644"}]})
    if rebuilt:
        settings = recipe["build"]
        built = {spec["entry"]: rebuilt[0], patch_path: rebuilt[1]}
        lock["sources"].append({"name": recipe["id"] + "-patched-build", "version": settings["module_version"],
            "url": settings["module_url"], "sha256": settings["module_zip_sha256"], "destination": ".",
            "expanded_size": sum(map(len, built.values())), "files": [
            {"path": name, "sha256": sha256(content), "size": len(content),
             "mode": "100755" if name == spec["entry"] else "100644"} for name, content in sorted(built.items())]})
        (output / "build-provenance.txt").write_text(rebuilt[2])
    (output / "source-lock.json").write_text(json.dumps(lock, indent=2) + "\n")
    return {"id": recipe["id"], "target": target, "entry_size": len(entry),
            "entry_sha256": sha256(entry), "runtime_directory": str(runtime.resolve())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recipe", type=Path, required=True)
    parser.add_argument("--target", choices=["linux-x86_64", "darwin-aarch64", "darwin-x86_64"], required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--strip-program", type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(json.loads(args.recipe.read_text()), args.target, args.cache, args.output, args.offline, args.strip_program)))


if __name__ == "__main__":
    main()
