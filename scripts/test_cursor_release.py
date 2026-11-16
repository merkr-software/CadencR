"""Publication-boundary tests: native bytes are data, never executable input."""
import argparse
import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

import cursor_release_prepare as prepare

SPEC = importlib.util.spec_from_file_location("cursor_stage", pathlib.Path(__file__).with_name("cursor-release-stage.py"))
stage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stage)
SOURCE = "a" * 40


class PayloadTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="cursor-release-test-"))
        (self.root / "bin").mkdir()
        (self.root / "bin/provider").write_bytes(b"inert native artifact")
        for name in ("LICENSE", "README.md", "icon.svg"):
            (self.root / name).write_bytes(name.encode())
        self.evidence = {"schema_version": 1, "target": "darwin-aarch64", "source_commit": SOURCE,
                         "version": "0.1.0", "executable_sha256": prepare.digest(b"inert native artifact"),
                         "runtime": "scripted-cursor-cli", "real_cursor_cli": False,
                         "checks": prepare.CHECKS, "result": "PASS"}
        self.save()

    def save(self):
        (self.root / "qualification.json").write_text(json.dumps(self.evidence))

    def validate(self):
        with patch.object(prepare, "tracked", side_effect=lambda repo, commit, name: name.encode()):
            return prepare.payload(self.root, "darwin-aarch64", SOURCE, "0.1.0", self.root)

    def test_accepts_exact_native_source_binding(self):
        self.assertEqual(self.validate(), self.evidence)
        self.assertTrue((self.root / "bin/provider").stat().st_mode & 0o111)

    def test_rejects_changed_binary_source_target_version_or_evidence(self):
        for key, value in (("target", "linux-x86_64"), ("source_commit", "b" * 40),
                           ("version", "9.9.9"), ("executable_sha256", "0" * 64),
                           ("checks", []), ("real_cursor_cli", True), ("result", "FAIL")):
            with self.subTest(key=key):
                original = self.evidence[key]
                self.evidence[key] = value
                self.save()
                with self.assertRaises(ValueError):
                    self.validate()
                self.evidence[key] = original
        self.save()
        (self.root / "bin/provider").write_bytes(b"different bytes")
        with self.assertRaises(ValueError):
            self.validate()

    def test_rejects_extra_files_and_directories(self):
        (self.root / "extra").mkdir()
        with self.assertRaises(ValueError):
            self.validate()

    def test_rejects_symlink_instead_of_binary(self):
        other = self.root / "other"
        other.write_bytes(b"inert native artifact")
        (self.root / "bin/provider").unlink()
        (self.root / "bin/provider").symlink_to(other)
        with self.assertRaises(ValueError):
            self.validate()

    def test_rejects_changed_source_document(self):
        (self.root / "README.md").write_text("changed")
        with self.assertRaises(ValueError):
            self.validate()

    def test_bounded_regular_read(self):
        with self.assertRaises(ValueError):
            prepare.read(self.root / "bin/provider", 1)


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.args = argparse.Namespace(build_run="123", source_commit=SOURCE)
        self.policy = {"repository_id": 10}
        self.run = {"head_sha": SOURCE, "status": "completed", "conclusion": "success",
                    "path": ".github/workflows/cursor-provider-build.yml", "event": "push",
                    "repository": {"id": 10}, "head_repository": {"id": 10}}
        self.artifacts = [{"name": f"cursor-native-{target}-{SOURCE}", "expired": False, "size_in_bytes": 100}
                          for target in prepare.TARGETS]

    def download(self):
        listing = {"total_count": len(self.artifacts), "artifacts": self.artifacts}
        with patch.object(stage, "api", side_effect=[self.run, listing]), \
                patch.object(stage.subprocess, "run") as run:
            stage.download(self.args, self.policy, pathlib.Path("/inert-payloads"))
            return run

    def test_accepts_exact_run_and_downloads_only_four_named_artifacts(self):
        run = self.download()
        self.assertEqual(run.call_count, 4)
        self.assertTrue(all(call.args[0][:3] == ["gh", "run", "download"] for call in run.call_args_list))

    def test_rejects_foreign_sha_workflow_repository_event_or_failed_build(self):
        for key, value in (("head_sha", "b" * 40), ("path", ".github/workflows/other.yml"),
                           ("repository", {"id": 99}), ("head_repository", {"id": 99}),
                           ("event", "pull_request"), ("conclusion", "failure"), ("status", "in_progress")):
            with self.subTest(key=key):
                original = copy.deepcopy(self.run)
                self.run[key] = value
                with self.assertRaises(ValueError):
                    self.download()
                self.run = original

    def test_rejects_missing_duplicate_expired_and_oversized_artifacts(self):
        original = copy.deepcopy(self.artifacts)
        for artifacts in (original[:-1], original + [original[0]],
                          [{**original[0], "expired": True}, *original[1:]],
                          [{**original[0], "size_in_bytes": 41 * 1024 * 1024}, *original[1:]]):
            self.artifacts = artifacts
            with self.assertRaises(ValueError):
                self.download()

    def test_rejects_untrusted_context_before_any_network_or_process(self):
        with patch.dict(stage.os.environ, {}, clear=True), patch.object(stage, "api") as api, \
                patch.object(stage.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                stage.validate_context(self.args)
            api.assert_not_called()
            run.assert_not_called()


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="cursor-request-test-"))
        self.template = (pathlib.Path(__file__).parent.parent /
                         "plugins/providers/cursor/package-template.json").read_bytes()
        self.inputs = self.root / "inputs"
        self.inputs.mkdir()
        for target in prepare.TARGETS:
            directory = self.inputs / f"cursor-native-{target}-{SOURCE}"
            (directory / "bin").mkdir(parents=True)
            binary = b"inert test payload " + target.encode()
            (directory / "bin/provider").write_bytes(binary)
            for name in ("LICENSE", "README.md", "icon.svg"):
                (directory / name).write_bytes(name.encode())
            evidence = {"schema_version": 1, "target": target, "source_commit": SOURCE,
                        "version": "0.1.0", "executable_sha256": prepare.digest(binary),
                        "runtime": "scripted-cursor-cli", "real_cursor_cli": False,
                        "checks": prepare.CHECKS, "result": "PASS"}
            (directory / "qualification.json").write_text(json.dumps(evidence))

    def tracked(self, repo, commit, name):
        if name == "package-template.json":
            return self.template
        if name == "package.json":
            return b'{"version":"0.1.0"}'
        return name.encode()

    def pack(self, args, **kwargs):
        self.assertEqual(args[:2], ["/trusted/cli", "registry"])
        self.assertEqual(args[2], "pack-provider")
        target = args[args.index("--target") + 1]
        archive = pathlib.Path(args[args.index("--output") + 1])
        data = b"canonical packer fixture " + target.encode()
        archive.write_bytes(data)
        return json.dumps({"target": target, "archive": str(archive),
                           "sha256": prepare.digest(data), "size": len(data)}).encode()

    def build(self, name):
        args = argparse.Namespace(input=self.inputs, output=self.root / name, source_repo=self.root,
                                  source_commit=SOURCE, cli=pathlib.Path("/trusted/cli"))
        with patch.object(prepare, "tracked", side_effect=self.tracked), \
                patch.object(prepare.subprocess, "check_output", side_effect=self.pack), \
                patch.object(prepare.subprocess, "run") as validate:
            digest = prepare.prepare(args)
            self.assertEqual(validate.call_count, 2)
        return digest, args.output

    def test_inspect_and_publish_reconstruction_have_identical_request_bytes(self):
        first, one = self.build("inspection")
        second, two = self.build("publication")
        self.assertEqual(first, second)
        self.assertEqual((one / "request.json").read_bytes(), (two / "request.json").read_bytes())
        request = json.loads((one / "request.json").read_bytes())
        self.assertEqual(request["source_commit"], SOURCE)
        self.assertEqual(len(request["additional_archives"]), 3)
        for item in [request["metadata"], request["archive"], *request["additional_archives"]]:
            self.assertEqual(prepare.digest((one / item["name"]).read_bytes()), item["sha256"])

    def test_changed_artifact_is_refused_before_request_creation(self):
        target = prepare.TARGETS[0]
        (self.inputs / f"cursor-native-{target}-{SOURCE}" / "bin/provider").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            self.build("refused")
        self.assertFalse((self.root / "refused/request.json").exists())


if __name__ == "__main__":
    unittest.main()
