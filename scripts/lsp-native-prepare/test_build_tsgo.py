"""Reviewed tsgo rebuild boundaries; Go builds themselves run in qualification CI."""
from contextlib import contextmanager
import copy
import io
import json
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import build_tsgo
from archive import sha256
from prepare import prepare

ROOT = Path(__file__).resolve().parents[2]
RECIPE = json.loads((ROOT / "plugins/lsp/native-recipes/tsgo.json").read_text())
GOPLS = json.loads((ROOT / "plugins/lsp/native-recipes/gopls.json").read_text())
UPSTREAM = b"\xcf\xfa\xed\xfe" + struct.pack("<I", 0x100000c) + b"microsoft"
REBUILT = b"\xcf\xfa\xed\xfe" + struct.pack("<I", 0x100000c) + b"cadencr"


def npm_tarball(entry):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, data in (("package/LICENSE", b"license"), ("package/lib/lib.d.ts", b"declare var x;"),
                           ("package/lib/tsgo", entry)):
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


def synthetic_recipe():
    recipe = copy.deepcopy(RECIPE)
    spec = recipe["targets"]["darwin-aarch64"]
    data = npm_tarball(UPSTREAM)
    spec.update(sha256=sha256(data), size=len(data), upstream_entry_sha256=sha256(UPSTREAM),
                upstream_entry_size=len(UPSTREAM), entry_sha256=sha256(REBUILT), entry_size=len(REBUILT))
    return recipe, data


@contextmanager
def no_toolchain(recipe, cache, offline):
    yield Path("/unused/go")


class TsgoRebuildTests(unittest.TestCase):
    def test_recipe_pins_the_reviewed_patch_toolchain_and_upstream_executables(self):
        build = RECIPE["build"]
        self.assertEqual(sha256((ROOT / build["patch"]["path"]).read_bytes()), build["patch"]["sha256"])
        self.assertEqual((build["go_version"], build["toolchains"]),
                         (GOPLS["build"]["go_version"], GOPLS["build"]["toolchains"]))
        self.assertEqual(len(build["source_commit"]), 40)
        self.assertTrue(build["module_version"].endswith(build["source_commit"][:12]))
        self.assertIn("-ldflags=-s -w -X github.com/microsoft/typescript-go/internal/core.version="
                      + RECIPE["version"], build["flags"])
        self.assertIn("-tags=" + ",".join(build["tags"]), build["flags"])
        for spec in RECIPE["targets"].values():
            self.assertNotEqual(spec["entry_sha256"], spec["upstream_entry_sha256"])

    def test_every_selected_regression_test_is_defined_by_the_shipped_patch(self):
        shipped = (ROOT / RECIPE["build"]["patch"]["path"]).read_text()
        self.assertIn("TestRunExitsOnTransportEOFWhileAwaitingClientResponse", build_tsgo.REGRESSION_TESTS)
        for name in build_tsgo.REGRESSION_TESTS:
            self.assertIn("+func " + name + "(t *testing.T) {", shipped)

    def test_regression_tests_require_every_selected_test_to_pass(self):
        passing = "".join("--- PASS: " + name + " (0.00s)\n" for name in build_tsgo.REGRESSION_TESTS)
        skipped = passing.replace("--- PASS: TestRunExitsOnTransportEOFWhileAwaitingClientResponse",
                                  "--- SKIP: TestRunExitsOnTransportEOFWhileAwaitingClientResponse")
        env = {"GOFLAGS": "-trimpath -mod=readonly"}
        for output, returncode, accepted in ((passing, 0, True), (skipped, 0, False), (passing, 1, False)):
            result = subprocess.CompletedProcess([], returncode, output.encode(), b"")
            with self.subTest(returncode=returncode, accepted=accepted), \
                    patch("build_tsgo.subprocess.run", return_value=result) as run:
                if accepted:
                    build_tsgo.regression_tests(Path("/go"), env, Path("/source"))
                else:
                    with self.assertRaisesRegex(ValueError, "did not all pass"):
                        build_tsgo.regression_tests(Path("/go"), env, Path("/source"))
                self.assertIn("-v", run.call_args.args[0])
                self.assertEqual(run.call_args.kwargs["env"]["GOFLAGS"], "-mod=readonly")

    def test_rebuild_refuses_an_unreviewed_npm_executable_or_patch(self):
        recipe, _ = synthetic_recipe()
        build_tsgo.upstream_entry(recipe, "darwin-aarch64", {"lib/tsgo": UPSTREAM})
        with self.assertRaisesRegex(ValueError, "reviewed upstream build"):
            build_tsgo.upstream_entry(recipe, "darwin-aarch64", {"lib/tsgo": UPSTREAM + b"x"})
        with self.assertRaisesRegex(ValueError, "reviewed upstream build"):
            build_tsgo.upstream_entry(recipe, "darwin-aarch64", {})
        recipe["build"]["patch"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "reviewed patch"):
            build_tsgo.reviewed_patch(recipe["build"])

    def test_patch_applies_only_to_the_module_copy_and_checks_the_result(self):
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            subprocess.run(["git", "init", "-q", str(checkout)], check=True)
            source = checkout / "work/source"
            (source / "pkg").mkdir(parents=True)
            (checkout / "pkg").mkdir()
            for root in (source, checkout):
                (root / "pkg/file.go").write_text("before\n")
            diff = b"--- a/pkg/file.go\n+++ b/pkg/file.go\n@@ -1 +1 @@\n-before\n+after\n"
            reviewed = {"files": {"pkg/file.go": sha256(b"after\n")}}
            build_tsgo.apply_patch(source, reviewed, diff)
            self.assertEqual((source / "pkg/file.go").read_text(), "after\n")
            self.assertEqual((checkout / "pkg/file.go").read_text(), "before\n")
            (source / "pkg/file.go").write_text("before\n")
            with self.assertRaisesRegex(ValueError, "reviewed result"):
                build_tsgo.apply_patch(source, {"files": {"pkg/file.go": "0" * 64}}, diff)

    def test_prepare_replaces_only_the_executable_and_records_both_sources(self):
        recipe, data = synthetic_recipe()
        rebuilt = (REBUILT, b"patch", "provenance")
        with tempfile.TemporaryDirectory() as directory, \
                patch("prepare.acquire", return_value=data), \
                patch("go_toolchain.toolchain", no_toolchain), \
                patch("build_tsgo.build", return_value=rebuilt):
            output = Path(directory) / "output"
            prepare(recipe, "darwin-aarch64", Path(directory) / "cache", output)
            runtime = output / "runtime"
            lock = json.loads((output / "source-lock.json").read_text())
            self.assertEqual((runtime / "lib/tsgo").read_bytes(), REBUILT)
            self.assertEqual((runtime / recipe["build"]["patch"]["shipped_as"]).read_bytes(), b"patch")
            self.assertEqual((output / "build-provenance.txt").read_text(), "provenance")
        npm, built = lock["sources"]
        self.assertEqual((npm["url"], npm["sha256"]), (recipe["targets"]["darwin-aarch64"]["url"], sha256(data)))
        self.assertEqual([entry["path"] for entry in npm["files"]], ["LICENSE", "lib/lib.d.ts"])
        self.assertEqual((built["url"], built["sha256"], built["version"]),
                         (recipe["build"]["module_url"], recipe["build"]["module_zip_sha256"],
                          recipe["build"]["module_version"]))
        self.assertEqual({entry["path"]: (entry["sha256"], entry["mode"]) for entry in built["files"]}, {
            "lib/tsgo": (sha256(REBUILT), "100755"),
            recipe["build"]["patch"]["shipped_as"]: (sha256(b"patch"), "100644")})

    def test_prepare_rejects_a_rebuild_that_differs_from_the_pinned_executable(self):
        recipe, data = synthetic_recipe()
        with tempfile.TemporaryDirectory() as directory, \
                patch("prepare.acquire", return_value=data), \
                patch("go_toolchain.toolchain", no_toolchain), \
                patch("build_tsgo.build", return_value=(REBUILT + b"x", b"patch", "")):
            with self.assertRaisesRegex(ValueError, "differs from reviewed recipe"):
                prepare(recipe, "darwin-aarch64", Path(directory) / "cache", Path(directory) / "output")


if __name__ == "__main__":
    unittest.main()
