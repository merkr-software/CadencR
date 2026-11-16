"""Acquire and inspect official pinned Go toolchain bytes before executing Go."""
from contextlib import contextmanager
import io
from pathlib import Path, PurePosixPath
import platform
import tarfile
import tempfile
import urllib.request

from archive import MAX_DOWNLOAD, bounded, sha256


@contextmanager
def toolchain(recipe, cache, offline):
    host = {("Darwin", "arm64"): "darwin-aarch64", ("Darwin", "x86_64"): "darwin-x86_64",
            ("Linux", "x86_64"): "linux-x86_64"}[(platform.system(), platform.machine())]
    source = recipe["build"]["toolchains"][host]
    if not source["url"].startswith("https://go.dev/dl/go"):
        raise ValueError("Go toolchain must use official go.dev archive")
    path = cache / sha256(source["url"].encode())
    if path.is_symlink():
        raise ValueError("Go archive cache entry must be regular")
    if path.exists():
        with path.open("rb") as stream:
            data = bounded(stream, MAX_DOWNLOAD)
    else:
        if offline:
            raise ValueError("official Go archive missing from offline cache")
        with urllib.request.urlopen(source["url"], timeout=60) as stream:
            data = bounded(stream, MAX_DOWNLOAD)
        with path.open("xb") as stream:
            stream.write(data)
    if len(data) != source["size"] or sha256(data) != source["sha256"]:
        raise ValueError("official Go archive size/hash mismatch")
    with tempfile.TemporaryDirectory(prefix="go-", dir=cache) as temporary:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r|gz") as archive:
            paths, total = set(), 0
            for index, member in enumerate(archive):
                path = PurePosixPath(member.name)
                total += member.size
                if (index >= 20000 or total > 1024 ** 3 or path.is_absolute() or ".." in path.parts
                        or member.name in paths or not path.parts or path.parts[0] != "go"):
                    raise ValueError("unsafe/oversized official Go archive")
                paths.add(member.name)
                destination = Path(temporary) / path
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    raise ValueError("official Go archive contains a link or special member")
                destination.parent.mkdir(parents=True, exist_ok=True)
                content = bounded(archive.extractfile(member), member.size)
                if len(content) != member.size:
                    raise ValueError("official Go archive member truncated")
                destination.write_bytes(content)
                destination.chmod(0o755 if member.mode & 0o111 else 0o644)
        yield Path(temporary) / "go/bin/go"


if __name__ == "__main__":
    import argparse
    import json
    import shutil
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("recipe", "cache", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    recipe = json.loads(args.recipe.read_text())
    with toolchain(recipe, args.cache, args.offline) as go:
        args.output.mkdir(parents=True, exist_ok=False)
        shutil.copytree(go.parents[1], args.output / "go")
    manifest = {"go_version": recipe["build"]["go_version"], "sources": recipe["build"]["toolchains"],
                "go_entry": str((args.output / "go/bin/go").resolve()),
                "go_sha256": sha256((args.output / "go/bin/go").read_bytes())}
    (args.output / "toolchain-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))
