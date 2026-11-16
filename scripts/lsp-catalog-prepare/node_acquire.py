"""Acquire complete npm dependency inventories without installing or executing packages.

Input is an npm package-lock v3 resolved separately with --ignore-scripts. Output
is private candidate material, never publication authority. No npm process runs
here. Every upstream byte is authenticated against the lock's SHA512 integrity.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import urllib.parse
import urllib.request


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def relative(value):
    path = PurePosixPath(value)
    require(value and not path.is_absolute() and str(path) == value
            and all(part not in ("", ".", "..") for part in path.parts)
            and "\\" not in value and not any(ord(c) < 32 for c in value), "unsafe relative path")
    return path


def write_json(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise ValueError("upstream redirects are refused")


def fetch(url, maximum):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and parsed.netloc == "registry.npmjs.org"
            and not parsed.query and not parsed.fragment, "public official npm HTTPS origin required")
    opener = urllib.request.build_opener(NoRedirect)
    request = urllib.request.Request(url, headers={"User-Agent": "Cadencr-held-LSP-acquisition/1"})
    with opener.open(request, timeout=60) as response:
        require(response.status == 200 and response.url == url, "unexpected npm response")
        data = response.read(maximum + 1)
    require(len(data) <= maximum, "npm response exceeds acquisition bound")
    return data


def download(package, cache):
    integrity = package.get("integrity", "")
    require(re.fullmatch(r"sha512-[A-Za-z0-9+/]+=*", integrity), "exact SHA512 npm integrity required")
    cache_path = cache / (hashlib.sha256(integrity.encode()).hexdigest() + ".tgz")
    data = cache_path.read_bytes() if cache_path.exists() else fetch(package["resolved"], 64 * 1024 * 1024)
    require("sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode() == integrity,
            "npm lock SHA512 integrity mismatch")
    if not cache_path.exists():
        with cache_path.open("xb") as stream:
            stream.write(data)
    return data


def unpack(data, destination):
    files, seen, expanded, metadata, prefix = [], set(), 0, None, None
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            relative(member.name.rstrip("/"))
            parts = PurePosixPath(member.name).parts
            require(parts and parts[0] not in (".", "..", "/"), "safe npm top directory required")
            prefix = prefix or parts[0]
            require(parts[0] == prefix, "one shared npm top directory required")
            name = "/".join(parts[1:])
            if member.isdir():
                if name:
                    relative(name)
                continue
            relative(name)
            require(member.isfile() and not member.linkname and not member.issparse(),
                    "only regular npm files accepted")
            require(name not in seen and 0 <= member.size <= 64 * 1024 * 1024,
                    "duplicate or oversized npm file")
            expanded += member.size
            require(expanded <= 512 * 1024 * 1024 and len(files) < 32768,
                    "upstream package exceeds audit bound")
            content = archive.extractfile(member).read(member.size + 1)
            require(len(content) == member.size, "truncated npm file")
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as stream:
                stream.write(content)
            path.chmod(0o644)
            files.append({"path": name, "sha256": digest(content), "size": len(content), "mode": "100644"})
            seen.add(name)
            if name == "package.json":
                metadata = json.loads(content)
    require(metadata is not None, "upstream package metadata missing")
    return sorted(files, key=lambda value: value["path"]), expanded, metadata


def package_source(path, package, output, cache):
    relative(path)
    require(path.startswith("node_modules/") and not package.get("link") and not package.get("dev"),
            "production npm package-lock paths required")
    data = download(package, cache)
    files, expanded, metadata = unpack(data, output / "bundle" / path)
    require(metadata["version"] == package["version"], "npm package version mismatch")
    source = {"name": metadata["name"], "version": metadata["version"], "url": package["resolved"],
              "sha256": digest(data), "destination": path, "expanded_size": expanded, "files": files}
    provenance = {"name": metadata["name"], "version": metadata["version"], "destination": path,
                  "integrity": package["integrity"], "compressed_size": len(data),
                  "license": metadata.get("license"), "repository": metadata.get("repository"),
                  "engines": metadata.get("engines", {}), "scripts": metadata.get("scripts", {}),
                  "has_install_script": bool(package.get("hasInstallScript")),
                  "optional": bool(package.get("optional"))}
    return source, provenance


def acquire(args):
    raw = args.npm_lock.read_bytes()
    lock = json.loads(raw)
    require(lock.get("lockfileVersion") == 3 and isinstance(lock.get("packages"), dict),
            "npm package-lock v3 required")
    require(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.id), "invalid candidate id")
    relative(args.entry)
    args.output.mkdir(mode=0o700)
    (args.output / "bundle").mkdir()
    args.cache.mkdir(parents=True, exist_ok=True)
    selected = set(args.include_optional)
    sources, provenance, omitted = [], [], []
    for path, package in sorted(lock["packages"].items()):
        if not path:
            continue
        if package.get("optional") and path not in selected:
            omitted.append({"path": path, "version": package["version"],
                            "os": package.get("os"), "cpu": package.get("cpu")})
            continue
        source, detail = package_source(path, package, args.output, args.cache)
        sources.append(source)
        provenance.append(detail)
    entry = args.output / "bundle" / args.entry
    require(entry.is_file() and entry.stat().st_size > 0, "real upstream entrypoint missing")
    source_lock = {"schema_version": 2, "id": args.id, "package_version": "0.1.0",
                   "min_app_version": "0.16.1", "runtime": "node", "entry": args.entry,
                   "target": "all", "sources": sources}
    write_json(args.output / "source-lock.json", source_lock)
    with (args.output / "package-lock.json").open("xb") as stream:
        stream.write(raw)
    write_json(args.output / "provenance.json", {"schema_version": 1, "authority": "candidate",
        "npm_lock_sha256": digest(raw), "source_lock_sha256": digest(
            (args.output / "source-lock.json").read_bytes()), "node_validation_version": "22.19.0",
        "acquisition": "official npm tarballs; lock SHA512 and full per-file SHA256 inventory",
        "installers_or_lifecycle_scripts_executed": False, "sources": provenance,
        "omitted_optional_packages": omitted,
        "qualification": "PENDING; acquisition does not prove language intelligence or platform support"})
    files = sum(len(source["files"]) for source in sources)
    print(json.dumps({"id": args.id, "packages": len(sources), "files": files,
        "expanded_bytes": sum(source["expanded_size"] for source in sources),
        "source_lock_bytes": (args.output / "source-lock.json").stat().st_size,
        "optional_omitted": len(omitted)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--npm-lock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--entry", required=True)
    parser.add_argument("--include-optional", action="append", default=[])
    acquire(parser.parse_args())
