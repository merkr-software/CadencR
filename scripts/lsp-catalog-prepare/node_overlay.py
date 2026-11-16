"""Bind reviewed first-party adapters to an immutable Git source commit.

This step only copies committed regular blobs and inventories them. It does not
run a compiler, npm, the adapter, upstream code or publication commands.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
from urllib.parse import quote

from node_acquire import relative, require

REPOSITORY = Path(__file__).resolve().parents[2]


def committed(commit, path):
    result = subprocess.run(["git", "-C", str(REPOSITORY), "show", f"{commit}:{path}"],
                            capture_output=True, check=False)
    require(result.returncode == 0, "reviewed overlay blob unavailable in source commit")
    mode = subprocess.run(["git", "-C", str(REPOSITORY), "ls-tree", commit, "--", path],
                          capture_output=True, check=False)
    require(mode.returncode == 0 and mode.stdout.startswith(b"100644 blob "),
            "overlay requires tracked regular non-executable Git blobs")
    require(len(result.stdout) <= 1024 * 1024, "overlay source blob exceeds bound")
    return result.stdout


def archive_bytes(contents):
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as archive:
            for name, data in sorted(contents.items(), key=lambda item: item[0].split("/")):
                member = tarfile.TarInfo("package/" + name)
                member.size, member.mode, member.mtime = len(data), 0o644, 0
                archive.addfile(member, io.BytesIO(data))
    return stream.getvalue()


def source_bindings(contents, recipe, commit, source_path, destination):
    sources = []
    for name, data in sorted(contents.items()):
        sha256 = hashlib.sha256(data).hexdigest()
        file = {"path": name, "sha256": sha256, "size": len(data), "mode": "100644"}
        token = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        suffix = hashlib.sha256(name.encode()).hexdigest()[:8]
        path = quote(f"{commit}/{source_path}/{name}", safe="/")
        sources.append({"name": f"cadencr-{recipe['id']}-overlay-{token}-{suffix}",
            "version": recipe["package_version"],
            "url": f"https://raw.githubusercontent.com/merkr-software/CadencR/{path}",
            "sha256": sha256, "destination": destination, "expanded_size": len(data), "files": [file]})
    return sources


def overlay(args):
    require(re.fullmatch(r"[a-f0-9]{40}", args.source_commit), "exact reviewed source commit required")
    recipe = json.loads(args.recipe.read_text())
    spec = recipe["local_overlay"]
    source_path = spec["path"]
    relative(source_path)
    require(source_path.startswith(f"plugins/lsp/{recipe['id']}/"), "overlay source must belong to candidate")
    destination = source_path.rsplit("/", 1)[1]
    relative(destination)
    contents = {}
    for name in spec["files"]:
        relative(name)
        require("/" not in name, "flat explicit overlay file list required")
        contents[name] = committed(args.source_commit, source_path + "/" + name)
    require(contents and len(contents) <= 32, "bounded nonempty overlay required")
    archive = archive_bytes(contents)
    files = [{"path": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "mode": "100644"}
             for name, data in sorted(contents.items())]
    lock_path = args.candidate / "source-lock.json"
    lock = json.loads(lock_path.read_text())
    require(lock["id"] == recipe["id"] and lock["entry"] == recipe.get("upstream_entry", recipe["entry"]),
            "fresh matching upstream acquisition required")
    sources = source_bindings(contents, recipe, args.source_commit, source_path, destination)
    for name, data in contents.items():
        path = args.candidate / "bundle" / destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            require(path.is_file() and not path.is_symlink() and path.read_bytes() == data,
                    "existing overlay differs; retained for review")
        else:
            with path.open("xb") as stream:
                stream.write(data)
        path.chmod(0o644)
    lock["entry"] = recipe["entry"]
    lock["sources"].extend(sources)
    archive_path = args.candidate / "adapter-source.tar.gz"
    require(not archive_path.exists(), "fresh overlay archive output required")
    with archive_path.open("xb") as stream:
        stream.write(archive)
    lock_path.write_text(json.dumps(lock, indent=2) + "\n")
    provenance_path = args.candidate / "provenance.json"
    provenance = json.loads(provenance_path.read_text())
    provenance["source_lock_sha256"] = hashlib.sha256(lock_path.read_bytes()).hexdigest()
    provenance["local_overlays"] = [{"source_commit": args.source_commit, "source_path": source_path,
                                     "license": "First-party Apache-2.0; third-party notices retain their stated licenses",
                                     "source_bindings": [{"url": source["url"], "sha256": source["sha256"],
                                                          "path": source["files"][0]["path"]} for source in sources],
                                     "private_synthesized_archive": {"file": archive_path.name,
                                         "sha256": hashlib.sha256(archive).hexdigest(),
                                         "authority": "private evidence only; no download URL"}, "files": files}]
    provenance_path.write_text(json.dumps(provenance, indent=2) + "\n")
    print(json.dumps({"id": recipe["id"], "source_commit": args.source_commit,
                      "source_bindings": len(sources), "files": len(files)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--recipe", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    overlay(parser.parse_args())
