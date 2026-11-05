"""Candidate artifact boundaries and workflow policy; fixtures never execute LSP payloads."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import handoff
import prepare
import runtime

SOURCE = "b" * 40


def write_json(path, value):
    path.write_text(json.dumps(value, sort_keys=True, indent=2) + "\n")


def fixture(root):
    output, work = root / "handoff", root / "prepare-work"
    output.mkdir()
    work.mkdir()
    published = handoff.ROOT / "plugins/lsp/typescript-language-server"
    canonical = (published / "payload/bundle.tar.gz").read_bytes()
    selected = json.loads((published / "package-template.json").read_bytes())["package"]["lsp"]["distribution"]["binary"]
    calls = []
    def invoke(arguments, directory):
        calls.append(arguments)
        if arguments[1:3] == ["plugin", "validate"]:
            return {}
        target = arguments[arguments.index("--target") + 1]
        destination = Path(arguments[-1])
        destination.write_bytes(canonical)
        return {**selected[target], "kind": "lsp", "target": target, "archive": str(destination)}
    with patch.object(prepare, "invoke", side_effect=invoke):
        package = prepare.published_baseline(root / "inert-cli", work / "typescript", output / "typescript-language-server")
    cli = handoff.provenance("source-build", "a" * 64, SOURCE)
    preparation = {"schema_version": 1, "authority": "candidate", "publication_authority": False,
                   "source_commit": SOURCE, "cli": cli, "packages": [package], "full_catalog": False}
    write_json(output / "preparation.json", preparation)
    digest = handoff.create(output, SOURCE, cli)
    return output, digest, package, calls


class HandoffTests(unittest.TestCase):
    def test_native_preparation_validates_every_target_archive_with_the_full_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            work = root / "work"
            source = handoff.ROOT / "plugins/lsp/native-recipes/ruff.json"
            recipe = json.loads(source.read_bytes())
            trees, targets, calls = {}, {}, []

            def acquire(*arguments):
                for target in prepare.TARGETS:
                    tree = work / target
                    tree.mkdir()
                    trees[target] = (tree, tree / "source-lock.json")
                return trees

            def pack(cli, recipe, target, source, work):
                self.assertFalse(any((tree / "lsp.json").exists() for tree, _ in trees.values()))
                content = ("inert " + target).encode()
                (work / (target + ".tar.gz")).write_bytes(content)
                signed = {"runtime": "native", "sha256": handoff.digest(content)}
                targets[target] = signed
                return signed, content, b"inert lock"

            def validate(arguments, directory):
                calls.append(arguments)
                self.assertIn("--json", arguments)
                target = arguments[arguments.index("--target") + 1]
                self.assertEqual(arguments[3], trees[target][0])
                self.assertEqual(Path(arguments[arguments.index("--archive") + 1]).read_bytes(),
                                 ("inert " + target).encode())
                manifest = json.loads((trees[target][0] / "lsp.json").read_bytes())
                self.assertEqual(manifest["package"]["lsp"]["distribution"]["binary"], targets)
                return {}

            with patch.object(prepare, "acquire_native", side_effect=acquire), \
                 patch.object(prepare, "pack_target", side_effect=pack), \
                 patch.object(prepare, "invoke", side_effect=validate):
                result = prepare.prepare_one(root / "inert-cli", source, work, root / "cache", root / "output", SOURCE)
            self.assertEqual(len(calls), 3)
            self.assertEqual(result["status"], "packed")
            self.assertEqual(result["targets"], targets)
            self.assertEqual(json.loads((root / "output/package-template.json").read_bytes()),
                             prepare.metadata(recipe, targets))

    def test_published_baseline_packs_twice_per_target_and_preserves_all_published_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, digest, package, calls = fixture(Path(temporary))
            manifest, packages = handoff.verify(output, digest, SOURCE)
            self.assertEqual(len(calls), 9)
            self.assertEqual([call[1:3] for call in calls[-3:]], [["plugin", "validate"]] * 3)
            self.assertTrue(all("--json" in call for call in calls[-3:]))
            self.assertEqual(package["provenance"], "published-baseline")
            self.assertEqual(manifest["runtime_qualification"], "PENDING")
            self.assertFalse(manifest["publication_authority"])
            self.assertEqual(packages[0]["targets"]["linux-x86_64"]["sha256"], handoff.PUBLISHED_TYPESCRIPT_SHA256)
            self.assertEqual((output / "typescript-language-server/package-template.json").read_bytes(),
                             (handoff.ROOT / "plugins/lsp/typescript-language-server/package-template.json").read_bytes())

    def test_manifest_context_changed_bytes_extras_and_links_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, digest, _, _ = fixture(Path(temporary))
            for checksum, source in (("c" * 64, SOURCE), (digest, "d" * 40)):
                with self.assertRaises(ValueError):
                    handoff.verify(output, checksum, source)
            path = output / "typescript-language-server/recipe.json"
            original = path.read_bytes()
            path.write_bytes(original + b" ")
            with self.assertRaises(ValueError):
                handoff.verify(output, digest, SOURCE)
            path.write_bytes(original)
            extra = output / "unexpected-key.json"
            extra.write_text("never upload this")
            with self.assertRaises(ValueError):
                handoff.verify(output, digest, SOURCE)
            extra.unlink()
            path.unlink()
            path.symlink_to(handoff.ROOT / "package.json")
            with self.assertRaises(ValueError):
                handoff.verify(output, digest, SOURCE)

    def test_closed_handoff_refuses_nondata_files_and_published_digest_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            output, digest, _, _ = fixture(Path(temporary))
            raw = json.loads((output / handoff.MANIFEST).read_bytes())
            raw["files"]["inert-cli"] = {"sha256": handoff.digest(b"binary"), "size": 6}
            (output / "inert-cli").write_bytes(b"binary")
            write_json(output / handoff.MANIFEST, raw)
            with self.assertRaises(ValueError):
                handoff.verify(output, handoff.digest((output / handoff.MANIFEST).read_bytes()), SOURCE)
            (output / "inert-cli").unlink()
            del raw["files"]["inert-cli"]
            preparation = json.loads((output / "preparation.json").read_bytes())
            preparation["packages"][0]["targets"]["linux-x86_64"]["sha256"] = "0" * 64
            write_json(output / "preparation.json", preparation)
            changed = (output / "preparation.json").read_bytes()
            raw["files"]["preparation.json"] = {"sha256": handoff.digest(changed), "size": len(changed)}
            write_json(output / handoff.MANIFEST, raw)
            with self.assertRaisesRegex(ValueError, "baseline bytes changed"):
                handoff.verify(output, handoff.digest((output / handoff.MANIFEST).read_bytes()), SOURCE)

    def test_receipt_json_rejects_duplicate_fields_and_nonfinite_numbers(self):
        with tempfile.TemporaryDirectory() as temporary:
            for raw in (b'{"sha256":"bad","sha256":"good"}', b'{"size":NaN}', b'{"size":1e999}'):
                result = subprocess.CompletedProcess([], 0, stdout=raw, stderr=b"")
                with patch.object(prepare.subprocess, "run", return_value=result), self.assertRaises(ValueError):
                    prepare.invoke(["inert-cli", "registry", "pack-lsp"], Path(temporary))

    def test_cli_provenance_never_confuses_source_build_with_released_pin(self):
        source = handoff.provenance("source-build", "a" * 64, SOURCE)
        released = handoff.provenance("released-pin", "a" * 64, SOURCE, "c" * 64)
        self.assertNotEqual(source, released)
        self.assertEqual(source["source_commit"], SOURCE)
        self.assertNotIn("source_commit", released)
        for origin, digest, pin in (("released-pin", "a" * 64, None), ("source-build", "a" * 64, "c" * 64),
                                    ("published", "a" * 64, None), ("source-build", "PENDING", None)):
            with self.assertRaises(ValueError):
                handoff.provenance(origin, digest, SOURCE, pin)
        for path in ("../escape", "/absolute", "a//b", "a/./b", "a\\b", "secret\nfile"):
            with self.assertRaises(ValueError):
                handoff.relative(path)

    def test_canonical_pack_receipt_drift_fails_before_handoff(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output, _, record, _ = fixture(root)
            extracted = root / "extracted"
            extracted.mkdir()
            recipe, _, selected, bundle, _, archive = runtime.package_input(output, record, "linux-x86_64", extracted)
            scratch = root / "drift"
            scratch.mkdir()
            def changed(arguments, work):
                destination = Path(arguments[-1])
                destination.write_bytes(archive.read_bytes())
                return {**selected, "kind": "lsp", "target": "linux-x86_64", "archive": str(destination), "sha256": "0" * 64}
            with patch.object(prepare, "invoke", side_effect=changed), self.assertRaisesRegex(ValueError, "receipt differs"):
                prepare.pack_target(root / "inert-cli", recipe, "linux-x86_64",
                    (bundle, output / "typescript-language-server/payload/all/source-lock.json"), scratch)



class RuntimeTests(unittest.TestCase):
    def test_verify_only_extracts_exact_baseline_without_starting_a_process_or_claiming_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output, digest, _, _ = fixture(root)
            args = argparse.Namespace(handoff=output, manifest_sha256=digest, source_commit=SOURCE,
                target="darwin-x86_64", prerequisites=None, prerequisites_sha256=None, verify_only=True,
                work=root / "runtime", evidence=root / "evidence", diagnostics=root / "diagnostics")
            with patch.object(runtime, "probe", side_effect=AssertionError("data checks must never execute a payload")):
                self.assertTrue(runtime.run(args))
            evidence = json.loads((args.evidence / "runtime.json").read_bytes())
            self.assertEqual(evidence["status"], "data-verified")
            self.assertEqual(evidence["runtime_qualification"], "PENDING")
            self.assertFalse(evidence["publication_authority"])
            self.assertEqual(evidence["packages"][0]["archive_sha256"], handoff.PUBLISHED_TYPESCRIPT_SHA256)
            self.assertTrue((args.work / "typescript-language-server/bundle/lib/cli.mjs").is_file())

    def test_wrong_host_and_invalid_handoff_preserve_failure_evidence_without_a_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output, digest, _, _ = fixture(root)
            for index, checksum in enumerate((digest, "f" * 64)):
                args = argparse.Namespace(handoff=output, manifest_sha256=checksum, source_commit=SOURCE,
                    target="linux-x86_64", prerequisites=None, prerequisites_sha256=None, verify_only=False,
                    work=root / f"runtime{index}", evidence=root / f"evidence{index}", diagnostics=root / f"diagnostics{index}")
                with patch.object(runtime.isolation, "host_target", return_value="darwin-aarch64"), \
                     patch.object(runtime, "probe", side_effect=AssertionError("wrong host cannot execute payloads")):
                    self.assertFalse(runtime.run(args))
                evidence = json.loads((args.evidence / "runtime.json").read_bytes())
                self.assertEqual(evidence["status"], "failed")
                self.assertEqual(evidence["runtime_qualification"], "PENDING")
                self.assertTrue((args.diagnostics / "runner-failure.json").is_file())

    def test_initialize_alone_and_missing_feature_evidence_never_qualify(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index, feature in enumerate((None, "initialize", "hover")):
                diagnostic = root / str(index)
                diagnostic.mkdir()
                report = diagnostic / "semantic.json"
                write_json(report, {"status": "passed", "network": "denied", "credentials": "none", "feature": feature})
                with patch.object(runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
                    if feature == "hover":
                        self.assertEqual(runtime.probe(["inert"], root, report, diagnostic)["feature"], feature)
                    else:
                        with self.assertRaises(ValueError):
                            runtime.probe(["inert"], root, report, diagnostic)


class IsolationTests(unittest.TestCase):
    def test_linux_refuses_root_network_interfaces_and_retained_capabilities(self):
        with patch.object(runtime.isolation.sys, "platform", "linux"), \
             patch.object(runtime.isolation.os, "geteuid", return_value=0):
            with self.assertRaisesRegex(ValueError, "must not run as root"):
                runtime.isolation.verify([], Path("/unused"))
        with patch.object(runtime.isolation.sys, "platform", "linux"), \
             patch.object(runtime.isolation.os, "geteuid", return_value=1000), \
             patch.object(runtime.isolation.socket, "if_nameindex", return_value=[(1, "lo"), (2, "eth0")]):
            with self.assertRaisesRegex(ValueError, "only loopback"):
                runtime.isolation.verify([], Path("/unused"))
        with patch.object(runtime.isolation.sys, "platform", "linux"), \
             patch.object(runtime.isolation.os, "geteuid", return_value=1000), \
             patch.object(runtime.isolation.socket, "if_nameindex", return_value=[(1, "lo")]), \
             patch.object(runtime.isolation.Path, "read_text", return_value="CapEff: 0\nCapBnd: ffff\nNoNewPrivs: 1\n"):
            with self.assertRaisesRegex(ValueError, "privileges must be dropped"):
                runtime.isolation.verify([], Path("/unused"))

    def test_linux_checks_current_namespace_without_reading_inherited_sysfs(self):
        with patch.object(runtime.isolation.sys, "platform", "linux"), \
             patch.object(runtime.isolation.os, "geteuid", return_value=1000), \
             patch.object(runtime.isolation.socket, "if_nameindex", return_value=[(1, "lo")]), \
             patch.object(runtime.isolation.Path, "iterdir", side_effect=AssertionError("sysfs may belong to the old namespace")), \
             patch.object(runtime.isolation.Path, "read_text", return_value="CapEff: 0\nCapBnd: 0\nNoNewPrivs: 1\n"):
            self.assertEqual(runtime.isolation.verify([], Path("/unused"))["network"], "unshare-net")

    def test_mac_profile_preserves_unix_ipc_and_quotes_protected_paths(self):
        profile = runtime.isolation.mac_profile([Path('/tmp/a"quoted')])
        self.assertIn("(deny network*)", profile)
        self.assertIn("(allow network* (local unix-socket))", profile)
        self.assertIn("(deny file-write* (subpath " + json.dumps(str(Path('/tmp/a"quoted').resolve())) + "))", profile)


class WorkflowTests(unittest.TestCase):
    def test_workflow_is_readonly_exact_artifact_bound_and_has_all_four_real_hosts(self):
        text = (handoff.ROOT / ".github/workflows/lsp-catalog-qualification.yml").read_text()
        self.assertIn("permissions:\n  contents: read", text)
        self.assertNotIn("pull_request_target", text)
        self.assertNotIn("secrets.", text)
        self.assertNotIn("contents: write", text)
        self.assertNotIn("registry publish", text)
        self.assertNotIn("environment:", text)
        self.assertEqual(text.count("persist-credentials: false"), 2)
        self.assertIn("artifact-ids: ${{ needs.package.outputs.artifact_id }}", text)
        self.assertIn("--manifest-sha256", text)
        self.assertIn("sudo unshare --mount --net --fork", text)
        self.assertIn("env -i PATH=/usr/bin:/bin", text)
        self.assertIn("pnpm rust -- build --locked --release -p cadencr-cli", text)
        for runner in ("ubuntu-24.04", "ubuntu-22.04", "macos-15", "macos-15-intel"):
            self.assertIn("runner: " + runner, text)
        for action in re.findall(r"uses: ([^\s#]+)", text):
            self.assertRegex(action, r"@[a-f0-9]{40}$")
        self.assertIn("lsp-runtime-diagnostics-${{ matrix.label }}", text)
        sandbox = (handoff.ROOT / "scripts/lsp-catalog-qa/linux-sandbox.sh").read_text()
        self.assertIn("mount -o remount,bind,ro", sandbox)
        self.assertIn("--bounding-set=-all --no-new-privs env -i", sandbox)
        self.assertLess(sandbox.index("mount -o remount,bind,ro"), sandbox.index("exec setpriv"))


if __name__ == "__main__":
    unittest.main()
