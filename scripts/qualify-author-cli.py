#!/usr/bin/env python3
"""QA orchestration only. Never builds or substitutes the reviewed distributed CLI."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import nullcontext
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "merkr-software/cadencr-registry-qa"
REPOSITORY_ID = 1420296872
LIMIT = 16 * 1024 * 1024
SCRIPTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_ROOT / "author-cli-qa"))
from process_limits import bounded_command

from failure_diagnostics import Rejected, require, failure_json


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value)
        value[key] = item
    return value


def load_candidate(data, confirmation):
    require(len(data) <= 65536 and digest(data) == confirmation)
    c = json.loads(data, object_pairs_hook=unique_object)
    require(type(c) is dict and set(c) - {"tab_variant"} == {
        "cli_version", "cli_sha256", "repository", "repository_id",
        "public", "expected_account", "tag", "source_commit", "kind"})
    require(c["kind"] in ("provider", "theme", "tab"))
    if "tab_variant" in c:
        require(c["kind"] == "tab" and type(c["tab_variant"]) is str
                and c["tab_variant"] in ("ui-only", "native-backend"))
    require(c["repository"] == REPOSITORY and type(c["repository_id"]) is int
            and c["repository_id"] == REPOSITORY_ID and c["public"] is True)
    for field, pattern in {
        "cli_version": r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?",
        "cli_sha256": r"[0-9a-f]{64}", "source_commit": r"[0-9a-f]{40}",
        "expected_account": r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})",
        "tag": r"qa-author-cli/[a-z0-9][a-z0-9-]{5,79}",
    }.items():
        require(type(c[field]) is str and re.fullmatch(pattern, c[field]) is not None)
    return c


def cli_env(home, token=None):
    # No inherited GitHub tokens, credential helpers, proxy, or user CLI config.
    env = {"PATH": "/usr/bin:/bin", "HOME": str(home),
           "XDG_CONFIG_HOME": str(home / "config"), "LANG": "C.UTF-8"}
    if token is not None:
        env["CADENCR_AUTHOR_GITHUB_TOKEN"] = token
    return env


def invoke(cli, args, home, token=None, success=True, expected_error=None):
    # Spool bounded output to private scratch, never forward diagnostics/paths/secrets.
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.run(bounded_command(cli, args, LIMIT), env=cli_env(home, token),
                           cwd=home, stdout=out, stderr=err, timeout=180)
        require(out.tell() <= LIMIT and err.tell() <= LIMIT)
        require((p.returncode == 0) == success)
        out.seek(0)
        stdout = out.read()
        if not success:
            require(p.returncode == 1 and stdout == b"" and expected_error is not None)
            err.seek(0)
            diagnostic = json.loads(err.read())
            require(diagnostic == {"ok": False, "code": "AUTHOR_RELEASE_FAILED",
                                   "message": expected_error})
            return b""
        return stdout


def check_cli(cli, c):
    require(cli.is_file() and not cli.is_symlink() and cli.stat().st_size <= 256*1024*1024)
    data = cli.read_bytes()
    require(digest(data) == c["cli_sha256"])
    # ELF64, little endian, x86-64 or AArch64; no source-script fallback.
    require(data[:6] == b"\x7fELF\x02\x01" and len(data) >= 64
            and int.from_bytes(data[18:20], "little") in (62, 183))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Rejected("unexpected API redirect")


def network_operation(method):
    def bounded(self, *args, **kwargs):
        previous = self.deadline
        self.deadline = min(previous, time.monotonic() + 30, kwargs.pop("deadline", previous))
        try:
            result = method(self, *args, **kwargs)
            self.remaining()  # Never accept a valid-looking result after the shared deadline.
            return result
        except Rejected as error:
            error.operations.append(method.__name__)
            raise
        finally:
            self.deadline = previous
    return bounded


class GitHub:
    def __init__(self):
        self.deadline = time.monotonic() + 900
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0)
        return min(30, remaining)

    def read(self, response):
        chunks = []
        size = 0
        while True:
            self.remaining()
            raw = getattr(getattr(response, "fp", None), "raw", None)
            sock = getattr(raw, "_sock", None)
            if sock is not None:
                sock.settimeout(self.remaining())
            reader = getattr(response, "read1", response.read)
            chunk = reader(min(65536, LIMIT + 1 - size))
            self.remaining()
            size += len(chunk)
            require(size <= LIMIT)
            chunks.append(chunk)
            if not chunk:
                return b"".join(chunks)

    @network_operation
    def get(self, path, token=None, absent=False):
        require(path.startswith("/repos/" + REPOSITORY + "/") or
                path in ("/repos/" + REPOSITORY, "/user"))
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "cadencr-author-cli-qa"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request("https://api.github.com" + path, headers=headers)
        try:
            with self.opener.open(request, timeout=self.remaining()) as response:
                data = self.read(response)
                return json.loads(data)
        except urllib.error.HTTPError as error:
            self.remaining()
            if error.code == 404 and absent:
                return None
            raise Rejected("GitHub read failed", code="HTTP_READ_FAILED",
                           http_status=error.code) from None

    @network_operation
    def identity(self, c, token):
        repo = self.get("/repos/" + REPOSITORY)
        require(repo["id"] == REPOSITORY_ID and repo["private"] is False
                and repo["full_name"] == REPOSITORY)
        tag = urllib.parse.quote(c["tag"], safe="")
        commit = self.get("/repos/" + REPOSITORY + "/commits/" + tag)
        require(commit["sha"] == c["source_commit"])
        from packages import fixture_paths
        for path in fixture_paths(c["kind"], c.get("tab_variant", "ui-only")):
            relative = path.relative_to(SCRIPTS_ROOT).as_posix()
            source = self.get("/repos/" + REPOSITORY + "/contents/scripts/" +
                              relative + "?ref=" + c["source_commit"])
            require(source["type"] == "file" and source["encoding"] == "base64"
                    and type(source["content"]) is str and source["size"] <= 256*1024)
            actual = base64.b64decode(source["content"].replace("\n", ""), validate=True)
            require(actual == path.read_bytes() and len(actual) == source["size"])
        if token:
            require(self.get("/user", token)["login"] == c["expected_account"])

    @network_operation
    def draft(self, c, token):
        found = []
        for page in range(1, 11):
            releases = self.get("/repos/" + REPOSITORY +
                                "/releases?per_page=100&page=" + str(page), token)
            require(type(releases) is list)
            found.extend(r for r in releases if r["tag_name"] == c["tag"])
            if len(releases) < 100:
                require(len(found) <= 1)
                return found[0] if found else None
        raise Rejected("release inventory exceeded bound")

    @network_operation
    def inventory(self, c, assets):
        release = self.get("/repos/" + REPOSITORY + "/releases/tags/" +
                           urllib.parse.quote(c["tag"], safe=""), absent=True)
        if release is None:
            return None
        require(type(release["id"]) is int and release["id"] > 0
                and type(release["body"]) is str and len(release["body"]) <= 65536)
        require(release["draft"] is False and release["prerelease"] is True
                and release["tag_name"] == c["tag"]
                and release["target_commitish"] == c["source_commit"])
        remote = self.get("/repos/" + REPOSITORY + "/releases/" +
                          str(release["id"]) + "/assets?per_page=100")
        require(type(remote) is list and len(remote) == len(assets))
        proof = []
        for a in remote:
            require(a["name"] in assets)
            expected = assets[a["name"]]
            require(type(a["id"]) is int and a["id"] > 0
                    and a["size"] == expected["size"] and a["state"] == "uploaded"
                    and a["digest"] == "sha256:" + expected["sha256"])
            # Browser downloads are anonymous; redirects only to GitHub asset hosts.
            url = a["browser_download_url"]
            require(url in {"https://github.com/" + REPOSITORY + "/releases/download/" +
                    tag + "/" + a["name"] for tag in
                    (c["tag"], urllib.parse.quote(c["tag"], safe=""))})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), AssetRedirect(self.remaining))
            with opener.open(url, timeout=self.remaining()) as response:
                data = self.read(response)
            require(len(data) == expected["size"] and digest(data) == expected["sha256"])
            proof.append({"id": a["id"], **expected})
        require(len({p["name"] for p in proof}) == len(assets))
        self.remaining()
        return {"release_id": release["id"], "body_sha256": digest(release["body"].encode()),
                "assets": sorted(proof, key=lambda a: a["name"])}


class AssetRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, remaining):
        super().__init__()
        self.remaining = remaining

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        req.timeout = self.remaining()
        parsed = urllib.parse.urlsplit(newurl)
        require(parsed.scheme == "https" and parsed.hostname in
                {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
                and parsed.username is None and parsed.port in (None, 443))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def asset(path):
    data = path.read_bytes()
    require(len(data) <= LIMIT)
    return {"name": path.name, "size": len(data), "sha256": digest(data)}


def local(cli, c, root):
    home = root / "home"
    home.mkdir()
    require(invoke(cli, ["--version"], home).decode().strip() == "cadencr " + c["cli_version"])
    from packages import prepare
    stage, archives = prepare(cli, c, root, home, invoke, asset)
    assets = [*archives, asset(stage / "metadata.json")]
    request = {"schema_version": 1, "repository": REPOSITORY,
               "expected_repository_id": REPOSITORY_ID, "expected_account": c["expected_account"],
               "tag": c["tag"], "source_commit": c["source_commit"],
               "release_notes": "Inert original-author CLI qualification.", "prerelease": True,
               "archive": archives[0], "metadata": assets[-1],
               "additional_archives": archives[1:]}
    path = stage / "request.json"
    path.write_text(json.dumps(request, sort_keys=True, separators=(",", ":")) + "\n")
    sha = digest(path.read_bytes())
    args = ["--request", str(path), "--directory", str(stage)]
    receipt = json.loads(invoke(cli, ["plugin", "inspect-release", *args], home))
    require(receipt["local_only"] is True and receipt["request_sha256"] == sha
            and receipt["request"]["repository"] == REPOSITORY)
    invoke(cli, ["--json", "plugin", "publish-release", *args,
                 "--confirm-request-sha256", "0"*64], home, success=False,
                 expected_error="request SHA-256 confirmation does not match")
    return home, stage, path, sha, {a["name"]: a for a in assets}


def source_inventory(c):
    from packages import fixture_paths
    return {p.relative_to(SCRIPTS_ROOT).as_posix(): digest(p.read_bytes())
            for p in fixture_paths(c["kind"], c.get("tab_variant", "ui-only"))}


def qualify(cli, c, publish, network=None, interrupt_draft=False):
    require(not interrupt_draft or publish)
    check_cli(cli, c)
    with nullcontext(tempfile.mkdtemp(prefix="author-cli-qa-")) as scratch:
        root = Path(scratch)
        root.chmod(0o700)
        print("Private QA scratch retained.", file=sys.stderr)
        home, stage, request, sha, assets = local(cli, c, root)
        proof = {"schema_version": 1, "cli_sha256": c["cli_sha256"],
                 "cli_version": c["cli_version"], "request_sha256": sha,
                 "kind": c["kind"], "runtime": "not_executed",
                 "source_fixtures": source_inventory(c),
                 "local_inspect": "passed", "bad_confirmation": "rejected",
                 "interrupted_draft": "not_exercised", "publication": "not_requested"}
        if c["kind"] == "tab":
            proof["tab_variant"] = c.get("tab_variant", "ui-only")
        if not publish:
            return proof
        token = os.environ.get("QA_AUTHOR_GITHUB_TOKEN")
        require(type(token) is str and bool(token.strip())
                and token not in {os.environ.get("GITHUB_TOKEN"), os.environ.get("GH_TOKEN")})
        network = network or GitHub()
        network.identity(c, token)
        before = network.inventory(c, assets)
        interrupted_id = None
        if interrupt_draft:
            require(before is None)
            sys.path.insert(0, str(SCRIPTS_ROOT / "author-cli-qa"))
            from interruption import interrupt
            interrupted_id = interrupt(cli, ["plugin", "publish-release", "--request",
                str(request), "--directory", str(stage), "--confirm-request-sha256", sha],
                home, token, network, c, sha, cli_env, require)
        for n in range(3):
            # Third attempt has entirely fresh scratch and no prior CLI state.
            if n == 2:
                fresh = root / "fresh"
                fresh.mkdir()
                shutil.copytree(stage, fresh / "stage")
                home = fresh / "home"
                home.mkdir()
                request = fresh / "stage/request.json"
                stage = fresh / "stage"
            receipt = json.loads(invoke(cli, ["plugin", "publish-release", "--request",
                str(request), "--directory", str(stage), "--confirm-request-sha256", sha], home, token))
            require(receipt["ok"] is True and receipt["request_sha256"] == sha
                    and receipt["already_published"] is (before is not None or n > 0))
            current = None
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                current = network.inventory(c, assets, deadline=deadline)
                require(time.monotonic() < deadline)
                if current is not None:
                    break
                time.sleep(min(1, max(0, deadline - time.monotonic())))
            require(current is not None and (before is None or current == before))
            require(interrupted_id is None or current["release_id"] == interrupted_id)
            before = current
        from negative_probes import reject_changes
        reject_changes(cli, home, stage, request, sha, token, network, c, assets,
                       before, invoke, require)
        if interrupted_id is not None:
            proof["interrupted_draft"] = "observed_empty_draft_terminated_owned_cli_resumed_same_id"
        proof.update(publication="verified", repository=REPOSITORY,
                     repository_id=REPOSITORY_ID, source_commit=c["source_commit"],
                     tag=c["tag"], inventory=before, completed_retries=2,
                     changed_bytes="rejected_inventory_unchanged",
                     changed_request="rejected_inventory_unchanged")
        return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--confirm-candidate-sha256", required=True)
    parser.add_argument("--cli", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--interrupt-draft", action="store_true")
    args = parser.parse_args()
    if args.interrupt_draft and not args.publish:
        parser.error("--interrupt-draft requires --publish")
    try:
        require(args.candidate.is_file() and not args.candidate.is_symlink()
                and args.candidate.stat().st_size <= 65536)
        c = load_candidate(args.candidate.read_bytes(), args.confirm_candidate_sha256)
        proof = qualify(args.cli.absolute(), c, args.publish, interrupt_draft=args.interrupt_draft)
        # Exclusive creation prevents accidentally replacing reviewed evidence.
        with args.output.open("x") as output:
            json.dump(proof, output, sort_keys=True, indent=2)
            output.write("\n")
    except (Rejected, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(failure_json(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
