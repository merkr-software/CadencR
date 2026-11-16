"""Inert fixture orchestration; released CLI owns all business validation."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
import urllib.parse

ROOT = Path(__file__).resolve().parent
TARGETS = ("linux-x86_64", "darwin-aarch64")


def fixture_paths(kind, tab_variant="ui-only"):
    if kind == "theme":
        return [ROOT / "theme.json"]
    paths = sorted(p for p in (ROOT / "fixtures" / kind).rglob("*") if p.is_file())
    return paths + ([ROOT / "native_fixture.py"] if tab_variant == "native-backend" else [])


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def metadata(kind, repository, tag):
    url = "https://github.com/" + repository
    descriptor = {"id": "qa-author-" + kind, "name": "Author CLI QA " + kind,
                  "description": "Inert original-author qualification; never execute.",
                  "version": "1.0.0", "repository": url,
                  "license": "Apache-2.0" if kind == "theme" else "MIT"}
    def distribution(name):
        return {"archive": url + "/releases/download/" + urllib.parse.quote(tag, safe="") +
                "/" + name, "sha256": "0" * 64}
    host = {"publisher": "qa-author", "compatibility": {"min_app_version": "999.0.0" if kind == "tab" else "1.0.0"}}
    if kind == "provider":
        descriptor["distribution"] = {"binary": {
            target: {**distribution("provider-" + target + ".tar.gz"), "cmd": "bin/provider"}
            for target in TARGETS}}
        host["assets"] = {"icon": "icon.svg", "readme": "README.md", "license": "LICENSE"}
    else:
        descriptor["api_version" if kind == "tab" else "document_version"] = 1
        descriptor["distribution"] = distribution(kind + ".tar.gz")
    return {"kind": kind, "package": {"agent" if kind == "provider" else kind: descriptor,
                                        "host": host}}


def prepare(cli, c, root, home, invoke, asset):
    kind = c["kind"]
    source, stage = root / ("qa-author-" + kind), root / "stage"
    stage.mkdir()
    if kind == "theme":
        source.mkdir()
        shutil.copyfile(ROOT / "theme.json", source / "theme.json")
    else:
        shutil.copytree(ROOT / "fixtures" / kind, source)
    package = metadata(kind, c["repository"], c["tag"])
    package_path = root / "package.json"
    write_json(package_path, package)
    validation = ["--json", "plugin", "validate", str(source), "--kind", kind]
    if kind == "provider":
        (source / "bin/provider").chmod(0o755)
        descriptor = root / "qa-author-provider.json"
        write_json(descriptor, {"schema_version": 1, "agent": package["package"]["agent"],
            "installation": {"executable": {"command": str(source / "bin/provider")}}})
        validation += ["--descriptor", str(descriptor)]
    native = c.get("tab_variant") == "native-backend"
    backends = []
    if native:
        import native_fixture
        ui = root / "tab-ui"
        shutil.copytree(source, ui)
        native_fixture.prepare(source, ui)
        validation += ["--no-run"]
        backends = native_fixture.pack(cli, source, stage, package["package"]["tab"],
                                      home, invoke, asset)
        write_json(package_path, package)
    invoke(cli, validation, home)
    archives = pack(cli, kind, ui if native else source, stage, package, package_path, home, invoke, asset) + backends
    packages = root / "packages"
    packages.mkdir()
    write_json(packages / "package.json", package)
    # Disposable validation timestamps never enter author metadata/request bytes.
    now = datetime.now(timezone.utc).replace(microsecond=0)
    timestamp = lambda at: at.isoformat().replace("+00:00", "Z")
    invoke(cli, ["registry", "build-index", "--schema-version", "2", "--packages", str(packages),
        "--generated-at", timestamp(now), "--expires-at", timestamp(now + timedelta(days=1))], home)
    # Catalog validation is deliberately looser than publication validation.
    # Keep the submission/plan private scratch, never release assets.
    submission = root / "submission.json"
    write_json(submission, {"schema_version": 2, "package": package,
        "source": {"repository": "https://github.com/" + c["repository"],
                   "tag": c["tag"], "commit": c["source_commit"]},
        "changelog": "Inert original-author CLI qualification."})
    invoke(cli, ["registry", "plan-publication", "--submission", str(submission),
        "--repository", c["repository"], "--output", str(root / "plan.json")], home)
    write_json(stage / "metadata.json", package)
    return stage, archives


def pack(cli, kind, source, stage, package, package_path, home, invoke, asset):
    archives = []
    targets = TARGETS if kind == "provider" else (None,)
    for target in targets:
        output = stage / ("provider-" + target + ".tar.gz" if target else kind + ".tar.gz")
        args = ["registry", "pack-" + kind, "--directory", str(source), "--output", str(output)]
        if target:
            # pack-provider consumes the provider body, not the schema-2 envelope.
            write_json(package_path, package["package"])
            args += ["--package", str(package_path), "--target", target]
        elif kind == "tab":
            args += ["--package", str(package_path)]
        invoke(cli, args, home)
        archive = asset(output)
        archives.append(archive)
        content = package["package"]["agent" if target else kind]["distribution"]
        (content["binary"][target] if target else content)["sha256"] = archive["sha256"]
    return archives
