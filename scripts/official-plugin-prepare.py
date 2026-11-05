"""Trusted orchestration only; Rust owns archive and registry business rules.

Never import, build, or execute candidate content. Prepared payloads must already
be reviewed tracked blobs with an exact policy allowlist, including file modes.
"""
import contextlib
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import threading

from official_plugin_pack import REPOSITORY, digest, fail, json_bytes, pack, parse_json, relative
from official_plugin_tags import release_tag

MAX_FILE = 32 * 1024 * 1024
MAX_TREE = 64 * 1024 * 1024
# LSP archives may reach the core 64 MiB ceiling; one bounded 16 MiB lock accompanies them.
MAX_LSP_FILE = 64 * 1024 * 1024
MAX_LSP_TREE = 80 * 1024 * 1024


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", repo, *args], stderr=subprocess.DEVNULL, timeout=30)


def source(repo, commit, path, expected_mode="100644"):
    relative(path)
    entry = git(repo, "ls-tree", commit, "--", path).decode().split()
    if not entry or entry[0] != expected_mode or entry[1] != "blob":
        fail("source must be regular tracked file with reviewed mode")
    size = git(repo, "cat-file", "-s", commit + ":" + path).decode().strip()
    if not size.isdecimal() or int(size) > MAX_FILE:
        fail("source file exceeds preparation limit")
    return git(repo, "show", commit + ":" + path)


def read_policy(repo, commit, tag, mode):
    policy = parse_json(source(repo, commit, "plugins/release-policy.json"))
    publication = "APPROVED" if mode == "author-approved" else "PENDING"
    if policy.get("schema_version") != 2 or policy.get("publication") != publication:
        fail("unreviewed release policy")
    plugin, version = release_tag(tag, policy)
    entry = policy.get("plugins", {}).get(plugin)
    if not isinstance(entry, dict):
        fail("unknown or unapproved official plugin")
    if entry.get("version") != version:
        fail("source plugin version mismatch")
    kind = entry.get("kind")
    if kind not in ("theme", "provider", "tab", "lsp") or plugin != kind + "-" + entry.get("id", ""):
        fail("invalid official plugin identity")
    relative(entry.get("source_path"))
    if not entry["source_path"].startswith("plugins/"):
        fail("invalid official plugin source root")
    if entry.get("preparation") != "READY":
        fail("official plugin source/package/target review is PENDING")
    if kind == "lsp":
        trusted = parse_json((pathlib.Path(os.environ["ROOT"]) / "plugins/release-policy.json").read_bytes())
        release_tag(tag, trusted)
        if trusted.get("plugins", {}).get(plugin) != entry:
            fail("LSP source policy differs from the trusted release policy")
    return policy, entry, plugin, version


def read_blobs(repo, objects, *, max_file=MAX_FILE, max_tree=MAX_TREE):
    process = subprocess.Popen(["git", "-C", repo, "cat-file", "--batch"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    timer = threading.Timer(60, process.kill)
    timer.start()
    remaining = max_tree
    try:
        for name, object_id in objects:
            if not re.fullmatch("[0-9a-f]{40}", object_id):
                fail("invalid tracked blob identity")
            process.stdin.write(object_id.encode() + b"\n")
            process.stdin.flush()
            header = process.stdout.readline(128).split()
            if (len(header) != 3 or header[:2] != [object_id.encode(), b"blob"]
                    or not header[2].isdigit()):
                fail("invalid tracked blob response")
            size = int(header[2])
            if size > max_file or size > remaining:
                fail("source payload exceeds preparation limit")
            remaining -= size
            data = process.stdout.read(size)
            if len(data) != size or process.stdout.read(1) != b"\n":
                fail("incomplete tracked blob response")
            yield name, data
        process.stdin.close()
        if process.wait(timeout=30) != 0:
            fail("tracked blob snapshot failed")
    finally:
        timer.cancel()
        timer.join()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.stdin.close()
        process.stdout.close()


def stage_payload(repo, commit, entry, target, specification, stage):
    if set(specification) - {"directory", "files", "closed_directories"} or not {"directory", "files"} <= set(specification):
        fail("invalid reviewed payload specification")
    directory = relative(specification["directory"])
    if directory != entry["source_path"] and not directory.startswith(entry["source_path"] + "/"):
        fail("payload directory escapes official source root")
    files = specification["files"]
    if not isinstance(files, dict) or not files or len(files) > 4096:
        fail("invalid reviewed payload file allowlist")
    sources = {}
    for name, declaration in files.items():
        relative(name)
        if (not isinstance(declaration, dict)
                or set(declaration) - {"sha256", "mode", "source", "source_mode"}
                or not {"sha256", "mode"} <= set(declaration)):
            fail("invalid reviewed payload file")
        sources[name] = relative(declaration.get("source", name))
    # Closed runtime directories reject extra modules; unrelated author source is
    # deliberately not copied. Mapping blobs is not executing a build script.
    closed = specification.get("closed_directories", ["."])
    if not isinstance(closed, list) or not closed:
        fail("reviewed closed runtime directories required")
    actual = {}
    for record in git(repo, "ls-tree", "-r", "-z", commit, "--", directory + "/").split(b"\0"):
        if not record:
            continue
        header, path = record.decode().split("\t", 1)
        file_mode, file_type, object_id = header.split()
        actual[path.removeprefix(directory + "/")] = (file_mode, file_type, object_id)
    for subtree in closed:
        prefix = "" if subtree == "." else relative(subtree) + "/"
        if ({name for name in actual if name.startswith(prefix)}
                != {name for name in sources.values() if name.startswith(prefix)}):
            fail("reviewed payload contains missing or extra source content")
    stage.mkdir()
    objects = []
    for name, declaration in sorted(files.items()):
        file_mode = declaration["mode"]
        source_mode = declaration.get("source_mode", file_mode)
        if (file_mode not in ("100644", "100755") or source_mode not in ("100644", "100755")
                or actual.get(sources[name], ())[:2] != (source_mode, "blob")):
            fail("unreviewed payload mode or non-regular file")
        if (entry["kind"] != "provider" and not (entry["kind"] == "tab" and target.startswith("backend-"))
                and file_mode != "100644"):
            fail("web/declarative payload must be non-executable")
        if not re.fullmatch("[0-9a-f]{64}", declaration["sha256"]):
            fail("payload digest review is PENDING")
        objects.append((name, actual[sources[name]][2]))
    limits = {"max_file": MAX_LSP_FILE, "max_tree": MAX_LSP_TREE} if entry["kind"] == "lsp" else {}
    with contextlib.closing(read_blobs(repo, objects, **limits)) as blobs:
        for name, data in blobs:
            declaration = files[name]
            if digest(data) != declaration["sha256"]:
                fail("reviewed payload content mismatch")
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            destination.chmod(0o755 if declaration["mode"] == "100755" else 0o644)


def metadata(repo, commit, entry, version):
    path = relative(entry.get("package"))
    if not path.startswith(entry["source_path"] + "/"):
        fail("metadata escapes official source root")
    version_file = entry.get("version_file")
    if version_file is not None:
        relative(version_file)
        if not version_file.startswith(entry["source_path"] + "/"):
            fail("version manifest escapes official source root")
        if parse_json(source(repo, commit, version_file)).get("version") != version:
            fail("source plugin version mismatch")
    package = parse_json(source(repo, commit, path))
    host = package.get("package", {}).get("host", {})
    compatibility = host.get("compatibility", {})
    if (host.get("publisher") == "PENDING"
            or any(value == "PENDING" for value in compatibility.values())):
        fail("official plugin publisher/compatibility decisions are PENDING")
    kind = entry["kind"]
    if package.get("kind") != kind or not isinstance(package.get("package"), dict):
        fail("expected discriminated schema-2 package template")
    body = package["package"]
    identity = body.get("agent" if kind == "provider" else kind, {})
    if identity.get("id") != entry["id"] or identity.get("version") != version:
        fail("package template identity mismatch")
    if identity.get("repository") != "https://github.com/" + REPOSITORY:
        fail("package template source repository mismatch")
    return package, identity


def prepare(mode, repo, commit, tag, output):
    if mode not in ("production", "qualification", "author-approved"):
        fail("invalid preparation mode")
    if not re.fullmatch("[0-9a-f]{40}", commit):
        fail("full source commit required")
    origin = git(repo, "remote", "get-url", "origin").decode().strip()
    if origin not in ("https://github.com/" + REPOSITORY, "https://github.com/" + REPOSITORY + ".git",
                      "git@github.com:" + REPOSITORY + ".git"):
        fail("unexpected source repository")
    if mode == "author-approved":
        if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
                or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
                or os.environ.get("GITHUB_REF") != "refs/heads/main"):
            fail("author preparation requires trusted main dispatch")
    if mode == "production":
        if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or os.environ.get("GITHUB_SHA") != commit
                or os.environ.get("GITHUB_REF") != "refs/tags/" + tag):
            fail("production requires matching authoritative GitHub tag context")
    policy, entry, plugin, version = read_policy(repo, commit, tag, mode)
    for ref in (commit, "refs/tags/" + tag):
        if git(repo, "rev-parse", "--verify", ref + "^{commit}").decode().strip() != commit:
            fail("tag source mismatch")
    out = pathlib.Path(output)
    if not out.is_absolute() or out.exists() or out.is_symlink() or out.parent.resolve() != out.parent:
        fail("output must be new absolute canonical path")
    package, _ = metadata(repo, commit, entry, version)
    work = pathlib.Path(tempfile.mkdtemp(prefix="official-plugin-"))
    print("Private preparation scratch retained: " + str(work), file=sys.stderr)
    stages = {}
    payloads = entry.get("payloads")
    if not isinstance(payloads, dict) or not payloads:
        fail("reviewed payload targets are PENDING")
    for index, (target, specification) in enumerate(sorted(payloads.items())):
        parent = work / ("payload-" + str(index))
        parent.mkdir()
        stage = parent / (entry["id"] if entry["kind"] == "tab" else "stage")
        stage_payload(repo, commit, entry, target, specification, stage)
        stages[target] = stage
    root = pathlib.Path(os.environ["ROOT"])
    home = work / "home"
    home.mkdir()
    env = {"PATH": os.environ["PATH"], "HOME": str(home)}
    pin = "scripts/cli-qualification.env" if mode == "qualification" else "tooling/marketplace-registry/ci/released-cli.env"
    cli = subprocess.check_output(["sh", str(root / "tooling/marketplace-registry/scripts/ci/fetch-released-cli.sh"),
                                   str(root / pin), str(work / "cli")], env=env, timeout=300).decode().strip()
    def run(*args):
        label = args[0] + " " + args[1]
        diagnostics = work / "cli-diagnostics.log"
        def retain(data):
            previous = diagnostics.read_bytes() if diagnostics.exists() else b""
            diagnostics.write_bytes((previous + label.encode() + b"\n" + data[:16384] + b"\n")[-65536:])
            diagnostics.chmod(0o600)
        try:
            completed = subprocess.run([cli, *args], env=env, timeout=60,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        except OSError as error:
            retain(str(error).encode())
            fail("official plugin " + label + " failed (CLI_START_FAILED); private CLI diagnostics retained in scratch")
        except subprocess.TimeoutExpired as error:
            retain(error.stderr or b"")
            fail("official plugin " + label + " timed out; private CLI diagnostics retained in scratch")
        retain(completed.stderr)
        if completed.returncode != 0:
            match = re.search(rb"error\[([A-Z][A-Z0-9_]{0,79})\]", completed.stderr)
            code = match.group(1).decode() if match else "CLI_OPERATION_FAILED"
            fail("official plugin " + label + " failed (" + code + "); private CLI diagnostics retained in scratch")
        return completed.stdout
    archives = pack(run, work, entry, package, stages, tag, version)
    submission = {"schema_version": 2, "package": package,
                  "source": {"repository": "https://github.com/" + REPOSITORY, "commit": commit, "tag": tag},
                  "changelog": "Official plugin release " + tag}
    submission_file = work / "submission.json"
    submission_file.write_bytes(json_bytes(submission))
    # Existing Rust submission and publication validators are authoritative.
    run("registry", "plan-publication", "--submission", str(submission_file),
        "--repository", REPOSITORY, "--output", str(work / "plan.json"))
    metadata_file = json_bytes(package)
    release = {"schema_version": 2, "plugin": plugin, "version": version, "source_repository": REPOSITORY,
               "source_commit": commit, "source_path": entry["source_path"], "tag": tag,
               "archives": archives, "package": {"name": "package.json", "sha256": digest(metadata_file), "size": len(metadata_file)},
               "publication": policy["publication"], "authority": mode}
    out.mkdir(mode=0o700)
    for archive in archives:
        (out / archive["name"]).write_bytes((work / archive["name"]).read_bytes())
    (out / "package.json").write_bytes(metadata_file)
    (out / "submission.json").write_bytes(submission_file.read_bytes())
    (out / "SHA256SUMS").write_text("".join(a["sha256"] + "  " + a["name"] + "\n" for a in archives))
    (out / "release.json").write_bytes(json_bytes(release))


if __name__ == "__main__":
    try:
        prepare(*sys.argv[1:])
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        fail("official plugin preparation failed; inspect reviewed inputs and retained scratch privately")
