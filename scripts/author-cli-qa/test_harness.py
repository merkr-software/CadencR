"""Offline guard and orchestration tests: never authorize remote publication."""
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent

spec = importlib.util.spec_from_file_location(
    "qualification", ROOT.parent / "qualify-author-cli.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


def candidate():
    return dict(kind="theme", cli_version="1.2.3", cli_sha256="b"*64, repository=qa.REPOSITORY,
                repository_id=qa.REPOSITORY_ID, public=True, expected_account="qa-author",
                tag="qa-author-cli/fixture-001", source_commit="a"*40)


sys.path.insert(0, str(ROOT))
from proxy import Gate, Tunnel


class Guards(unittest.TestCase):
    def test_failure_json_never_exports_exception_payloads(self):
        secret = "token-secret /private/scratch https://private.example/token-secret"
        errors = [qa.Rejected(secret), OSError(secret), ValueError(secret),
                  KeyError(secret), TypeError(secret),
                  subprocess.CalledProcessError(1, [secret], output=secret, stderr=secret),
                  subprocess.TimeoutExpired([secret], 1, output=secret, stderr=secret),
                  qa.urllib.error.URLError(secret)]
        for error in errors:
            with self.subTest(kind=type(error).__name__), tempfile.TemporaryDirectory() as scratch:
                c = Path(scratch) / "candidate.json"
                c.write_text(json.dumps(candidate()))
                stderr = io.StringIO()
                args = ["qa", "--candidate", str(c), "--confirm-candidate-sha256",
                        qa.digest(c.read_bytes()), "--cli", secret, "--output", str(c)]
                with patch.object(sys, "argv", args), patch.object(
                    qa, "qualify", side_effect=error
                ), patch.object(sys, "stderr", stderr):
                    self.assertEqual(qa.main(), 1)
                diagnostic = json.loads(stderr.getvalue())
                self.assertFalse(diagnostic["ok"])
                self.assertNotIn(secret, stderr.getvalue())
                self.assertNotIn(scratch, stderr.getvalue())
                self.assertEqual(json.loads(c.read_text()), candidate())
        poisoned = qa.Rejected(secret, code=secret, http_status=secret)
        poisoned.operations = [secret] * 100 + ["get"] * 100
        diagnostic = json.loads(qa.failure_json(poisoned))
        self.assertEqual(diagnostic, {"ok": False, "code": "GUARD_REJECTED",
            "category": "REJECTED", "operations": ["get"] * 4})

    def test_real_qualification_failure_does_not_print_retained_scratch_path(self):
        secret = "private-token https://secret.example/private /private/raw-secret"
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            c = root / "candidate.json"
            c.write_text(json.dumps(candidate()))
            stderr = io.StringIO()
            args = ["qa", "--candidate", str(c), "--confirm-candidate-sha256",
                    qa.digest(c.read_bytes()), "--cli", secret, "--output", str(root / "proof")]
            with patch.object(sys, "argv", args), patch.object(qa, "check_cli"), patch.object(
                qa.tempfile, "mkdtemp", return_value=scratch
            ), patch.object(qa, "local", side_effect=ValueError(secret)), patch.object(
                sys, "stderr", stderr
            ):
                self.assertEqual(qa.main(), 1)
            lines = stderr.getvalue().splitlines()
            self.assertEqual(lines[0], "Private QA scratch retained.")
            self.assertEqual(json.loads(lines[1]), {
                "ok": False, "code": "QUALIFICATION_FAILED", "category": "VALUE"})
            self.assertNotIn(scratch, stderr.getvalue())
            self.assertNotIn(secret, stderr.getvalue())
            self.assertFalse((root / "proof").exists())

    def test_http_failure_has_only_bounded_status_and_closed_operation_trace(self):
        network = qa.GitHub()
        error = qa.urllib.error.HTTPError("https://secret.example/private", 403,
                                         "private-token", {"secret": "token"}, None)
        with patch.object(network.opener, "open", side_effect=error):
            with self.assertRaises(qa.Rejected) as caught:
                network.identity(candidate(), "private-token")
        self.assertEqual(json.loads(qa.failure_json(caught.exception)), {
            "ok": False, "code": "HTTP_READ_FAILED", "category": "REJECTED",
            "http_status": 403, "operations": ["get", "identity"]})
        for operation in ("draft", "inventory"):
            with patch.object(network.opener, "open", side_effect=error):
                with self.assertRaises(qa.Rejected) as caught:
                    getattr(network, operation)(candidate(), {} if operation == "inventory" else "token")
            self.assertEqual(json.loads(qa.failure_json(caught.exception))["operations"],
                             ["get", operation])
        error.close()

    def test_cli_environment_does_not_inherit_credentials(self):
        with patch.dict(os.environ, {"GITHUB_TOKEN": "secret", "GH_TOKEN": "secret",
                "QA_AUTHOR_GITHUB_TOKEN": "secret", "HTTPS_PROXY": "secret",
                "CADENCR_AUTHOR_GITHUB_TOKEN": "ambient-secret"}):
            env = qa.cli_env(Path("/scratch"))
            self.assertEqual(set(env), {"PATH", "HOME", "XDG_CONFIG_HOME", "LANG"})
            self.assertNotIn("secret", json.dumps(env))
            self.assertEqual(qa.cli_env(Path("/scratch"), "explicit-token"),
                             {**env, "CADENCR_AUTHOR_GITHUB_TOKEN": "explicit-token"})

    def test_symlink_entry_uses_canonical_fixture_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            alias = Path(directory) / "scripts-alias"
            alias.symlink_to(ROOT.parent, target_is_directory=True)
            # Import fixtures through the alias before loading the canonical entrypoint.
            # This reproduces mixed /tmp and /private/tmp module paths on macOS.
            program = """
import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(sys.argv[1]) / "author-cli-qa"))
import packages
spec = importlib.util.spec_from_file_location("qualification", sys.argv[2])
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
assert packages.ROOT == packages.ROOT.resolve()
assert qa.SCRIPTS_ROOT == qa.SCRIPTS_ROOT.resolve()
import base64
for kind, variant in (("provider", "ui-only"), ("theme", "ui-only"),
                      ("tab", "ui-only"), ("tab", "native-backend")):
    candidate = {"kind": kind, "tag": "qa-author-cli/fixture-001", "source_commit": "a" * 40}
    if kind == "tab":
        candidate["tab_variant"] = variant
    inventory = qa.source_inventory(candidate)
    assert inventory and all(key.startswith("author-cli-qa/") for key in inventory)
    def get(path, token=None):
        if path == "/repos/" + qa.REPOSITORY:
            return {"id": qa.REPOSITORY_ID, "private": False, "full_name": qa.REPOSITORY}
        if "/commits/" in path:
            return {"sha": candidate["source_commit"]}
        relative = path.split("/contents/scripts/", 1)[1].split("?", 1)[0]
        data = (qa.SCRIPTS_ROOT / relative).read_bytes()
        return {"type": "file", "encoding": "base64", "size": len(data),
                "content": base64.b64encode(data).decode()}
    network = qa.GitHub()
    with patch.object(network, "get", side_effect=get):
        network.identity(candidate, None)
    if variant == "native-backend":
        def changed_generator(path, token=None):
            response = get(path, token)
            if "/native_fixture.py?" in path:
                response["content"] = base64.b64encode(b"tampered generator").decode()
            return response
        try:
            with patch.object(network, "get", side_effect=changed_generator):
                network.identity(candidate, None)
        except qa.Rejected:
            pass
        else:
            raise RuntimeError("source generator tampering was accepted")
"""
            result = subprocess.run([sys.executable, "-B", "-c", program,
                str(alias), str(ROOT.parent / "qualify-author-cli.py")],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_proxy_upload_gate_and_destination_rejection(self):
        gate = Gate.__new__(Gate)
        gate.server_address = ("127.0.0.1", 1234)
        gate.upload_held = threading.Event()
        gate.api_seen = threading.Event()
        gate.stop = threading.Event()
        gate.stop.set()
        env = gate.environment({"NO_PROXY": "*", "https_proxy": "bad", "HOME": "/x"})
        self.assertEqual(set(env), {"HOME", "HTTPS_PROXY"})
        class Connection:
            def __init__(self, host):
                self.host = host
                self.sent = b""
            def settimeout(self, value):
                pass
            def recv(self, limit):
                return b"CONNECT " + self.host + b":443 HTTP/1.1\r\n\r\n"
            def sendall(self, data):
                self.sent += data
        tunnel = Tunnel.__new__(Tunnel)
        tunnel.server = gate
        tunnel.request = Connection(b"uploads.github.com")
        thread = threading.Thread(target=tunnel.tunnel)
        thread.start()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(gate.upload_held.is_set())
        self.assertFalse(gate.api_seen.is_set())
        tunnel.request = Connection(b"evil.example")
        tunnel.tunnel()
        self.assertIn(b"403 Forbidden", tunnel.request.sent)

    def test_interruption_observation_precedes_owned_termination(self):
        import interruption
        trace = []
        class FakeGate:
            def __init__(self):
                FakeGate.last = self
                self.transport_failed = threading.Event()
                self.api_seen = threading.Event()
                self.upload_held = threading.Event()
                self.api_seen.set()
                self.upload_held.set()
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def environment(self, env):
                return env
        class Process:
            returncode = None
            def poll(self):
                return self.returncode
            def terminate(self):
                trace.append("terminate-owned")
                FakeGate.last.transport_failed.set()  # Expected disconnect after owned shutdown.
                self.returncode = -15
            def wait(self, timeout):
                trace.append("wait-owned")
        c = candidate()
        bound = {"id": 123, "draft": True, "prerelease": True, "tag_name": c["tag"],
                 "target_commitish": c["source_commit"],
                 "body": "Inert original-author CLI qualification.\n\n"
                         "<!-- cadencr-publication-binding:sha256:" + "d"*64 + " -->"}
        class Network:
            calls = 0
            def draft(self, c, token, deadline=None):
                qa.require(deadline is not None)
                self.calls += 1
                trace.append("draft")
                return None if self.calls == 1 else bound
            def get(self, path, token, deadline=None):
                qa.require(deadline is not None)
                trace.append("empty-assets")
                return []
        with patch.object(interruption, "bounded_command", return_value=["/cli"]), patch.object(interruption, "Gate", FakeGate), patch.object(
            interruption.subprocess, "Popen", return_value=Process()
        ):
            release_id = interruption.interrupt(Path("/cli"), [], Path("/scratch"),
                "private-token", Network(), c, "d"*64, qa.cli_env, qa.require)
        self.assertEqual(release_id, 123)
        self.assertEqual(trace, ["draft", "draft", "empty-assets", "terminate-owned", "wait-owned"])
        class FailedGate(FakeGate):
            def __init__(self):
                super().__init__()
                self.transport_failed.set()
        trace.clear()
        with patch.object(interruption, "bounded_command", return_value=["/cli"]), patch.object(
            interruption, "Gate", FailedGate
        ), patch.object(interruption.subprocess, "Popen", return_value=Process()), self.assertRaises(qa.Rejected):
            interruption.interrupt(Path("/cli"), [], Path("/scratch"),
                "private-token", Network(), c, "d"*64, qa.cli_env, qa.require)
        self.assertEqual(trace, ["draft", "terminate-owned", "wait-owned"])

    def test_interruption_requires_publish_and_namespaced_tag(self):
        with self.assertRaises(qa.Rejected):
            qa.qualify(Path("/not-executed"), candidate(), False, interrupt_draft=True)
        bad = {**candidate(), "tag": "qa-author-cli-hyphen-only"}
        data = json.dumps(bad).encode()
        with self.assertRaises(qa.Rejected):
            qa.load_candidate(data, qa.digest(data))

    def test_identity_requires_exact_tracked_source_fixture(self):
        import base64
        c = candidate()
        theme = (ROOT / "theme.json").read_bytes()
        trace = []
        def get(path, token=None):
            trace.append(path)
            if path == "/repos/" + qa.REPOSITORY:
                return dict(id=qa.REPOSITORY_ID, private=False, full_name=qa.REPOSITORY)
            if "/commits/" in path:
                return {"sha": c["source_commit"]}
            if "/contents/" in path:
                return dict(type="file", encoding="base64", size=len(theme),
                            content=base64.b64encode(theme).decode())
            return {"login": c["expected_account"]}
        network = qa.GitHub()
        with patch.object(network, "get", side_effect=get):
            network.identity(c, "author-token")
        self.assertEqual(trace, ["/repos/" + qa.REPOSITORY,
            "/repos/" + qa.REPOSITORY + "/commits/qa-author-cli%2Ffixture-001",
            "/repos/" + qa.REPOSITORY +
            "/contents/scripts/author-cli-qa/theme.json?ref=" + c["source_commit"], "/user"])
        def mismatch(path, token=None):
            value = get(path, token)
            if "/contents/" in path:
                value["content"] = base64.b64encode(b"wrong").decode()
            return value
        with patch.object(network, "get", side_effect=mismatch), self.assertRaises(qa.Rejected):
            network.identity(c, "author-token")

    def test_negative_probe_requires_exact_structured_failure(self):
        expected = "request SHA-256 confirmation does not match"
        cases = [
            (1, {"ok": False, "code": "AUTHOR_RELEASE_FAILED", "message": expected}, True),
            (-9, {"ok": False, "code": "AUTHOR_RELEASE_FAILED", "message": expected}, False),
            (1, {"ok": False, "code": "AUTHOR_RELEASE_FAILED",
                 "message": "CADENCR_AUTHOR_GITHUB_TOKEN is required"}, False),
            (2, {"ok": False, "code": "CLI_USAGE_ERROR", "message": expected}, False),
            (1, {"ok": False, "code": "AUTHOR_RELEASE_FAILED",
                 "message": "author release local validation failed"}, False),
        ]
        for code, diagnostic, accepted in cases:
            def run(command, **kwargs):
                self.assertNotIn("preexec_fn", kwargs)
                kwargs["stderr"].write(json.dumps(diagnostic).encode())
                return type("Result", (), {"returncode": code})()
            with self.subTest(code=code, diagnostic=diagnostic), patch.object(
                qa, "bounded_command", return_value=["/usr/bin/prlimit", "--", "/cli"]
            ), patch.object(qa.subprocess, "run", side_effect=run):
                if accepted:
                    qa.invoke(Path("/cli"), [], Path("/scratch"), success=False,
                              expected_error=expected)
                else:
                    with self.assertRaises(qa.Rejected):
                        qa.invoke(Path("/cli"), [], Path("/scratch"), success=False,
                                  expected_error=expected)

    def test_valid_json_returned_after_deadline_is_rejected(self):
        network = qa.GitHub()
        network.deadline = 10
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, limit):
                clock[0] = 11
                return b'{"ok":true}'
        class Opener:
            def open(self, request, timeout):
                return Response()
        network.opener = Opener()
        clock = [1]
        with patch.object(qa.time, "monotonic", side_effect=lambda: clock[0]), self.assertRaises(qa.Rejected):
            network.get("/repos/" + qa.REPOSITORY)

    def test_operation_cannot_accept_overdeadline_mocked_pagination(self):
        network = qa.GitHub()
        previous = network.deadline
        clock = [1]
        def get(path, token=None):
            clock[0] = 32
            return []
        with patch.object(qa.time, "monotonic", side_effect=lambda: clock[0]), patch.object(
            network, "get", side_effect=get
        ), self.assertRaises(qa.Rejected):
            network.draft(candidate(), "private-token")
        self.assertEqual(network.deadline, previous)

    def test_prlimit_exec_wrapper_has_no_shell_or_fork_callback(self):
        from process_limits import bounded_command
        with patch.object(Path, "is_file", return_value=True):
            self.assertEqual(bounded_command(Path("/reviewed/cli"), ["--version"], 1024),
                             ["/usr/bin/prlimit", "--fsize=1024:1024", "--",
                              "/reviewed/cli", "--version"])

    def test_enclosing_deadline_caps_nested_network_timeout(self):
        for now, deadline in ((29, 30), (59, 60)):
            network = qa.GitHub()
            timeouts = []
            class Response:
                def __enter__(self):
                    return self
                def __exit__(self, *args):
                    pass
                data = b'{}'
                def read(self, limit):
                    data, self.data = self.data, b""
                    return data
            class Opener:
                def open(self, request, timeout):
                    timeouts.append(timeout)
                    return Response()
            network.opener = Opener()
            with patch.object(qa.time, "monotonic", return_value=now):
                network.get("/repos/" + qa.REPOSITORY, deadline=deadline)
            self.assertEqual(timeouts, [1])

    def test_candidate_exact_shape_identity_and_pin(self):
        c = candidate()
        data = json.dumps(c).encode()
        self.assertEqual(qa.load_candidate(data, qa.digest(data)), c)
        for variant in ("ui-only", "native-backend"):
            valid = {**c, "kind": "tab", "tab_variant": variant}
            encoded = json.dumps(valid).encode()
            self.assertEqual(qa.load_candidate(encoded, qa.digest(encoded)), valid)
        for kind, variant in (("theme", "native-backend"), ("provider", "ui-only"),
                              ("tab", None), ("tab", "native"), ("tab", True),
                              ("tab", ["native-backend"])):
            encoded = json.dumps({**c, "kind": kind, "tab_variant": variant}).encode()
            with self.subTest(kind=kind, variant=variant), self.assertRaises(qa.Rejected):
                qa.load_candidate(encoded, qa.digest(encoded))
        with self.assertRaises(qa.Rejected):
            qa.load_candidate(data, "0"*64)
        for field, value in [("repository", "CadencR/registry"), ("repository_id", True),
                             ("public", False), ("source_commit", "main"),
                             ("tag", "v1"), ("cli_sha256", "bad"),
                             ("expected_account", "user/other"), ("cli_version", 123),
                             ("kind", "unknown"), ("unexpected", "secret")]:
            bad = {**c, field: value}
            data = json.dumps(bad).encode()
            with self.subTest(field=field), self.assertRaises(qa.Rejected):
                qa.load_candidate(data, qa.digest(data))

    def test_environment_cannot_inherit_credentials_or_proxy(self):
        with patch.dict(os.environ, {"GITHUB_TOKEN": "actions-secret", "GH_TOKEN": "other",
                                    "HTTPS_PROXY": "https://bad", "HOME": "/private/user"}):
            env = qa.cli_env(Path("/scratch"))
            self.assertEqual(set(env), {"PATH", "HOME", "XDG_CONFIG_HOME", "LANG"})
            self.assertNotIn("secret", json.dumps(env))
            self.assertEqual(qa.cli_env(Path("/scratch"), "author")[
                "CADENCR_AUTHOR_GITHUB_TOKEN"], "author")

    def test_script_or_wrong_pin_is_not_a_distributed_cli(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "cli"
            p.write_bytes(b"#!/bin/sh\necho cadencr 1.2.3")
            c = {**candidate(), "cli_sha256": qa.digest(p.read_bytes())}
            with self.assertRaises(qa.Rejected):
                qa.check_cli(p, c)

    def test_api_paths_are_fixed_and_never_write(self):
        network = qa.GitHub()
        for path in ("/repos/CadencR/registry", "/user?token=secret", "https://bad"):
            with self.assertRaises(qa.Rejected):
                network.get(path)
        seen = []

        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            sent = False
            def read(self, limit):
                if self.sent:
                    return b""
                self.sent = True
                return b'{"id":1420296872}'

        class Opener:
            def open(self, request, timeout):
                seen.append((request.get_method(), request.full_url, dict(request.header_items())))
                return Response()
        network.opener = Opener()
        network.get("/repos/" + qa.REPOSITORY)
        self.assertEqual(seen, [("GET", "https://api.github.com/repos/" + qa.REPOSITORY,
                               {"Accept": "application/vnd.github+json",
                                "User-agent": "cadencr-author-cli-qa"})])

    def test_completed_retry_trace_and_allowlisted_proof(self):
        trace = []
        with tempfile.TemporaryDirectory() as root:
            p = Path(root)
            home, stage = p / "home", p / "stage"
            home.mkdir()
            stage.mkdir()
            request = stage / "request.json"
            request.write_bytes(b'{}')
            (stage / "theme.tar.gz").write_bytes(b"archive")
            assets = {"theme.tar.gz": qa.asset(stage / "theme.tar.gz")}
            inventory = {"release_id": 1, "assets": [{"id": 2, **assets["theme.tar.gz"]}]}

            class Network:
                count = 0
                def identity(self, c, token):
                    trace.append("identity")
                def inventory(self, c, a, deadline=None):
                    trace.append("inventory")
                    self.count += 1
                    return None if self.count == 1 else inventory

            calls = []
            def invoke(cli, args, home, token=None, success=True, expected_error=None):
                calls.append((list(args), str(home), token, success))
                trace.append("publish" if success else "reject")
                return json.dumps(dict(ok=True, request_sha256="d"*64,
                                       already_published=len(calls) > 1)).encode()

            with patch.object(qa, "check_cli"), patch.object(
                qa, "local", return_value=(home, stage, request, "d"*64, assets)
            ), patch.object(qa, "invoke", side_effect=invoke), patch.dict(
                os.environ, {"QA_AUTHOR_GITHUB_TOKEN": "private-author-secret"}, clear=True
            ):
                proof = qa.qualify(Path("/reviewed/cli"), candidate(), True, Network())
            self.assertEqual(trace, ["identity", "inventory", "publish", "inventory",
                                    "publish", "inventory", "publish", "inventory",
                                    "reject", "inventory", "reject", "inventory"])
            self.assertNotEqual(calls[1][1], calls[2][1])
            self.assertEqual(proof["completed_retries"], 2)
            self.assertEqual(proof["interrupted_draft"], "not_exercised")
            serialized = json.dumps(proof)
            for secret in ("private-author-secret", "/scratch", "/reviewed", str(p)):
                self.assertNotIn(secret, serialized)

    def test_all_kinds_prepare_complete_metadata_without_executing_payload(self):
        import packages
        for kind in ("provider", "theme", "tab"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                home = root / "home"
                home.mkdir()
                calls = []
                def invoke(cli, args, home):
                    calls.append(args)
                    if "--output" in args:
                        Path(args[args.index("--output") + 1]).write_bytes(b"inert archive")
                    return b"{}"
                c = {**candidate(), "kind": kind}
                data = json.dumps(c).encode()
                self.assertEqual(qa.load_candidate(data, qa.digest(data)), c)
                stage, archives = packages.prepare(Path("/released/cli"), c, root,
                                                   home, invoke, qa.asset)
                self.assertEqual(len(archives), 2 if kind == "provider" else 1)
                validation = next(args for args in calls if args[:3] == ["--json", "plugin", "validate"])
                self.assertEqual(Path(validation[3]).name, "qa-author-" + kind)
                index = next(args for args in calls if args[:2] == ["registry", "build-index"])
                from datetime import datetime, timedelta, timezone
                generated = datetime.fromisoformat(index[index.index("--generated-at") + 1])
                expires = datetime.fromisoformat(index[index.index("--expires-at") + 1])
                self.assertEqual(expires - generated, timedelta(days=1))
                self.assertLess(abs(datetime.now(timezone.utc) - generated), timedelta(minutes=1))
                metadata = json.loads((stage / "metadata.json").read_bytes())
                self.assertEqual(metadata["kind"], kind)
                planning = next(args for args in calls if args[:2] == ["registry", "plan-publication"])
                submission = json.loads(Path(planning[planning.index("--submission") + 1]).read_text())
                self.assertEqual(submission, {"schema_version": 2, "package": metadata,
                    "source": {"repository": "https://github.com/" + c["repository"],
                               "tag": c["tag"], "commit": c["source_commit"]},
                    "changelog": "Inert original-author CLI qualification."})
                self.assertEqual(Path(planning[planning.index("--output") + 1]), root / "plan.json")
                self.assertEqual({path.name for path in stage.iterdir()},
                                 {"metadata.json", *(archive["name"] for archive in archives)})
                descriptor = metadata["package"]["agent" if kind == "provider" else kind]
                self.assertEqual(descriptor["id"], "qa-author-" + kind)
                distributions = descriptor["distribution"]
                distributions = distributions["binary"].values() if kind == "provider" else [distributions]
                for distribution in distributions:
                    self.assertIn("qa-author-cli%2Ffixture-001/", distribution["archive"])
                    self.assertEqual(distribution["sha256"], qa.digest(b"inert archive"))
                self.assertTrue(any(args[:2] == ["registry", "build-index"] and
                                    args[args.index("--schema-version") + 1] == "2" for args in calls))
                self.assertTrue(all("/released/cli" not in args for args in calls))
                self.assertTrue(packages.fixture_paths(kind))
                self.assertTrue(all(path.is_file() for path in packages.fixture_paths(kind)))
                if kind == "tab":
                    paths = packages.fixture_paths(kind)
                    self.assertEqual({path.name for path in paths}, {"tab.json", "index.html"})
                    manifest = next(path for path in paths if path.name == "tab.json")
                    entry = manifest.parent / json.loads(manifest.read_text())["entry"]
                    self.assertIn(entry, paths)

    def test_tab_fixture_is_a_trackable_closed_compiled_payload(self):
        import packages
        source = ROOT / "fixtures/tab"
        paths = {path.relative_to(source).as_posix() for path in packages.fixture_paths("tab")}
        self.assertEqual(paths, {"tab.json", "dist/index.html"})
        self.assertEqual(json.loads((source / "tab.json").read_text())["entry"], "dist/index.html")
        # A global dist exclusion must not silently remove the fixture from delivery.
        result = subprocess.run(["git", "check-ignore", "--no-index", "--stdin"],
            input="scripts/author-cli-qa/fixtures/tab/dist/index.html\n"
                  "scripts/author-cli-qa/fixtures/tab/dist/unexpected.js\n"
                  "packages/desktop/dist/index.html\n", cwd=ROOT.parents[1],
            capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            "scripts/author-cli-qa/fixtures/tab/dist/unexpected.js",
            "packages/desktop/dist/index.html"])

    def test_provider_publication_assets_are_present_and_bound_to_source_inventory(self):
        import packages
        package = packages.metadata("provider", qa.REPOSITORY, candidate()["tag"])["package"]
        self.assertEqual(package["host"]["assets"], {
            "icon": "icon.svg", "readme": "README.md", "license": "LICENSE"})
        source = ROOT / "fixtures/provider"
        paths = packages.fixture_paths("provider")
        self.assertEqual({path.relative_to(source).as_posix() for path in paths},
                         {"bin/provider", "icon.svg", "README.md", "LICENSE"})
        native = qa.source_inventory({**candidate(), "kind": "tab",
                                      "tab_variant": "native-backend"})
        self.assertEqual(set(native), {"author-cli-qa/fixtures/tab/tab.json",
            "author-cli-qa/fixtures/tab/dist/index.html", "author-cli-qa/native_fixture.py"})
        self.assertEqual(native["author-cli-qa/native_fixture.py"],
                         qa.digest((ROOT / "native_fixture.py").read_bytes()))
        inventory = qa.source_inventory({**candidate(), "kind": "provider"})
        for asset in package["host"]["assets"].values():
            path = source / asset
            self.assertIn(path, paths)
            self.assertEqual(inventory[path.relative_to(qa.SCRIPTS_ROOT).as_posix()],
                             qa.digest(path.read_bytes()))
        self.assertIn("dedicated inert author CLI QA provider fixture only",
                      (source / "LICENSE").read_text())
        self.assertIn("Never execute", (source / "README.md").read_text())

    @unittest.skipUnless(os.environ.get("CADENCR_DEVELOPMENT_FIXTURE_CLI"),
                         "explicit development CLI required; not released-CLI qualification")
    def test_development_cli_packs_and_plans_real_fixtures(self):
        import hashlib
        import packages
        import tarfile
        cli = Path(os.environ["CADENCR_DEVELOPMENT_FIXTURE_CLI"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="author-fixture-development-") as scratch:
            for kind in ("provider", "theme", "tab"):
                with self.subTest(kind=kind):
                    root = Path(scratch).resolve() / kind
                    root.mkdir()
                    home = root / "home"
                    home.mkdir()
                    def invoke(cli, args, home):
                        # No credentials, ambient proxies, publication, or fixture execution.
                        result = subprocess.run([str(cli), *map(str, args)],
                            env=qa.cli_env(home), capture_output=True, timeout=30)
                        self.assertEqual(result.returncode, 0, result.stderr.decode())
                        return result.stdout
                    stage, archives = packages.prepare(cli, {**candidate(), "kind": kind},
                                                       root, home, invoke, qa.asset)
                    metadata = json.loads((stage / "metadata.json").read_text())
                    submission = json.loads((root / "submission.json").read_text())
                    self.assertEqual(submission["schema_version"], 2)
                    self.assertEqual(submission["package"], metadata)
                    self.assertTrue((root / "plan.json").is_file())
                    expected = {path.relative_to(ROOT / "fixtures" / kind).as_posix()
                                for path in packages.fixture_paths(kind)} if kind != "theme" else {"theme.json"}
                    for archive in archives:
                        path = stage / archive["name"]
                        self.assertEqual(archive["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
                        with tarfile.open(path) as tar:
                            self.assertEqual({member.name for member in tar if member.isfile()}, expected)

    @unittest.skipUnless(os.environ.get("CADENCR_DEVELOPMENT_FIXTURE_CLI"),
                         "explicit development CLI required; not released-CLI qualification")
    def test_development_cli_packs_and_plans_a_backend_tab(self):
        """Exercise the shared publication request path, without running native headers."""
        import packages
        import native_fixture
        import tarfile
        cli = Path(os.environ["CADENCR_DEVELOPMENT_FIXTURE_CLI"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="author-fixture-backend-") as scratch:
            root = Path(scratch).resolve()
            c = {**candidate(), "kind": "tab", "tab_variant": "native-backend"}
            version = subprocess.run([str(cli), "--version"], capture_output=True,
                                     check=True, text=True, timeout=30).stdout.strip().split(" ")[1]
            c["cli_version"] = version
            calls = []
            original_invoke = qa.invoke
            def traced(cli, args, home, *a, **kw):
                calls.append(args)
                return original_invoke(cli, args, home, *a, **kw)
            # Development macOS runs lack Linux prlimit; production guards stay unchanged.
            with patch.object(qa, "bounded_command", side_effect=lambda cli, args, limit:
                              [str(cli), *map(str, args)]):
                with patch.object(qa, "invoke", side_effect=traced):
                    home, stage, request, sha, assets = qa.local(cli, c, root)
                    ui_root = root / "ui-only"
                    ui_root.mkdir()
                    _, ui_stage, ui_request, _, ui_assets = qa.local(
                        cli, {**c, "tab_variant": "ui-only"}, ui_root)
                    self.assertEqual(json.loads(ui_request.read_text())["additional_archives"], [])
                    self.assertEqual(set(ui_assets), {"tab.tar.gz", "metadata.json"})
                    self.assertNotIn("backend", json.loads((ui_stage / "metadata.json").read_text())
                                     ["package"]["tab"])
            validate = next(args for args in calls if args[:3] == ["--json", "plugin", "validate"])
            self.assertIn("--no-run", validate)
            commands = [args[1] for args in calls if args[0] == "registry"]
            self.assertEqual(commands[:4], ["pack-tab-backend"] * 3 + ["pack-tab"])
            ui_pack = next(args for args in calls if args[:2] == ["registry", "pack-tab"])
            self.assertIn("--package", ui_pack)
            bound = json.loads(request.read_text())
            self.assertEqual(bound["archive"]["name"], "tab.tar.gz")
            self.assertEqual([a["name"] for a in bound["additional_archives"]],
                             ["tab-backend-" + t + ".tar.gz" for t in native_fixture.TARGETS])
            metadata = json.loads((stage / "metadata.json").read_text())
            binary = metadata["package"]["tab"]["distribution"]["binary"]
            self.assertEqual(set(binary), set(native_fixture.TARGETS))
            for target, header in native_fixture.headers().items():
                entry = binary[target]
                archive = stage / ("tab-backend-" + target + ".tar.gz")
                self.assertEqual(entry["sha256"], qa.digest(archive.read_bytes()))
                self.assertEqual(entry["executable_sha256"], qa.digest(header))
                self.assertEqual(entry["executable_size"], len(header))
                with tarfile.open(archive) as tar:
                    members = tar.getmembers()
                    self.assertEqual([(m.name, m.mode, m.isfile()) for m in members],
                                     [("bin/" + target + "/backend", 0o755, True)])
                    self.assertEqual(tar.extractfile(members[0]).read(), header)
            with tarfile.open(stage / "tab.tar.gz") as tar:
                self.assertEqual({m.name for m in tar if m.isfile()},
                                 {"tab.json", "dist/index.html"})
            plan = json.loads((root / "plan.json").read_text())
            self.assertEqual([t["target"] for t in plan["targets"]],
                             ["tab", *("backend-" + t for t in sorted(binary))])
            class Network:
                def inventory(self, c, assets):
                    return "unchanged"
            from negative_probes import reject_changes
            # Local validation must reject every changed archive and metadata before auth.
            with patch.object(qa, "bounded_command", side_effect=lambda cli, args, limit:
                              [str(cli), *map(str, args)]):
                reject_changes(cli, home, stage, request, sha, None, Network(), c, assets,
                               "unchanged", qa.invoke, qa.require)

    def test_actions_token_cannot_be_author_token(self):
        with tempfile.TemporaryDirectory() as root, patch.object(
            qa, "check_cli"
        ), patch.object(qa, "local", return_value=(
            Path(root), Path(root), Path(root)/"r", "d"*64, {}
        )), patch.dict(os.environ, {
            "QA_AUTHOR_GITHUB_TOKEN": "same-token", "GITHUB_TOKEN": "same-token"
        }, clear=True), self.assertRaises(qa.Rejected):
            qa.qualify(Path("/cli"), candidate(), True)


if __name__ == "__main__":
    unittest.main()
