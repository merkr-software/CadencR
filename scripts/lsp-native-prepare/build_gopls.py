#!/usr/bin/env python3
"""Build reviewed gopls with checksum-verifying Go and a credential-free environment."""
import argparse
import json
from pathlib import Path
import subprocess
import zipfile

from archive import executable, sha256


def build(recipe, target, go, work, output, offline=False):
    work.mkdir(parents=True, exist_ok=True)
    env = {"HOME": str(work), "PATH": str(go.parent) + ":/usr/bin:/bin", "CGO_ENABLED": "0",
           "GOPATH": str(work / "gopath"), "GOCACHE": str(work / "cache"),
           "GOTOOLCHAIN": "local", "GOPROXY": (work / "gopath/pkg/mod/cache/download").as_uri() if offline else "https://proxy.golang.org",
           "GOSUMDB": "off" if offline else "sum.golang.org",
           "GOFLAGS": "-trimpath", "GOTELEMETRY": "off"}
    version = subprocess.check_output([str(go), "version"], env=env).decode().split()[2]
    if version != recipe["build"]["go_version"]:
        raise ValueError("gopls requires the reviewed Go version")
    os_name, arch = {"linux-x86_64": ("linux", "amd64"), "darwin-aarch64": ("darwin", "arm64"),
                     "darwin-x86_64": ("darwin", "amd64")}[target]
    subprocess.run([str(go), "install", "-ldflags=-s -w", "golang.org/x/tools/gopls@v" + recipe["version"]],
                   env={**env, "GOOS": os_name, "GOARCH": arch}, cwd=work, check=True)
    host = subprocess.check_output([str(go), "env", "GOOS", "GOARCH"], env=env).decode().split()
    binary = work / "gopath/bin" / ("" if host == [os_name, arch] else os_name + "_" + arch) / "gopls"
    data = binary.read_bytes()
    executable(data, target)
    info = subprocess.check_output([str(go), "version", "-m", str(binary)], env=env).decode()
    modules = {}
    for line in info.splitlines():
        fields = line.split()
        if fields and fields[0] in ("mod", "dep"):
            modules[fields[1] + "@" + fields[2]] = fields[3]
    if modules != recipe["build"]["module_sums"]:
        raise ValueError("gopls Go dependency graph differs from frozen module sums")
    spec = recipe["targets"][target]
    if sha256(data) != spec["entry_sha256"] or len(data) != spec["entry_size"]:
        raise ValueError("gopls build differs from reviewed executable bytes")
    source = work / "gopath/pkg/mod/cache/download/golang.org/x/tools/gopls/@v" / ("v" + recipe["version"] + ".zip")
    if sha256(source.read_bytes()) != spec["sha256"]:
        raise ValueError("gopls source archive differs from reviewed source")
    with zipfile.ZipFile(source) as archive:
        licenses = [p for p in archive.namelist() if p.endswith("/LICENSE") and p.count("/") == 5]
        if len(licenses) != 1:
            licenses = [p for p in archive.namelist() if p.endswith("/LICENSE")]
        if not licenses:
            raise ValueError("gopls source license missing")
        license_bytes = archive.read(licenses[0])
    output.mkdir(parents=True, exist_ok=False)
    runtime = output / "runtime"
    runtime.mkdir()
    files = {"gopls": data, "LICENSE": license_bytes}
    for module in sorted(modules):
        escaped = "".join("!" + c.lower() if c.isupper() else c for c in module)
        directory = work / "gopath/pkg/mod" / escaped
        notices = [p for p in directory.rglob("*") if p.is_file() and
                   p.name.lower().startswith(("license", "copying", "notice"))]
        for notice in sorted(notices):
            content = notice.read_bytes()
            if len(content) > 2 * 1024 * 1024:
                raise ValueError("dependency notice exceeds budget")
            name = "licenses/" + module.replace("@", "_") + "/" + str(notice.relative_to(directory))
            files[name] = content
    files["licenses/Go-LICENSE"] = (go.parents[1] / "LICENSE").read_bytes()
    for name, content in files.items():
        (runtime / name).parent.mkdir(parents=True, exist_ok=True)
        (runtime / name).write_bytes(content)
        (runtime / name).chmod(0o755 if name == "gopls" else 0o644)
    lock = {"schema_version": 2, "id": "gopls", "package_version": recipe["package_version"],
            "min_app_version": recipe["min_app_version"], "runtime": "native", "entry": "gopls", "target": target,
            "sources": [{"name": "gopls", "version": recipe["version"], "url": spec["url"],
                "sha256": spec["sha256"], "destination": ".", "expanded_size": sum(map(len, files.values())),
                "files": [{"path": name, "sha256": sha256(content), "size": len(content),
                           "mode": "100755" if name == "gopls" else "100644"} for name, content in sorted(files.items())]}]}
    (output / "source-lock.json").write_text(json.dumps(lock, indent=2) + "\n")
    info = subprocess.check_output([str(go), "version", "-m", str(binary)], env=env).decode()
    (output / "build-provenance.txt").write_text(info.replace(str(binary), "gopls", 1))
    return {"id": "gopls", "target": target, "entry_sha256": sha256(data)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("recipe", "go", "work", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()
    print(json.dumps(build(json.loads(args.recipe.read_text()), args.target, args.go.resolve(),
                           args.work.resolve(), args.output.resolve())))
