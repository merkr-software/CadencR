"""Source orchestration tests only: no executable bundle or publication is run."""
import copy
import gzip
import importlib.util
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from official_plugin_pack import digest, json_bytes, pack
from official_plugin_lsp_archive import inventory, inspect_bundle, decode_bundle, member_path, unpack
from official_plugin_tags import release_tag, release_notes

ROOT = Path(__file__).resolve().parent.parent
TAG = "lsp-typescript-language-server-v0.1.0"
PLUGIN = "lsp-typescript-language-server"
SOURCE = "plugins/lsp/typescript-language-server"
TARGETS = ("darwin-aarch64", "darwin-x86_64", "linux-x86_64")
ENTRY = "lib/cli.mjs"


def fixture():
    contents = {ENTRY: b"throw new Error('inert test fixture must never execute')"}
    contents.update({"node_modules/typescript/file-%03d.js" % i: b"inert" for i in range(144)})
    sources = []
    for name, destination in (("typescript-language-server", "."), ("typescript", "node_modules/typescript")):
        files = []
        for path, data in sorted(contents.items()):
            if (destination == ".") != (path == ENTRY):
                continue
            files.append(dict(path=path if destination == "." else path[len(destination) + 1:],
                              sha256=digest(data), size=len(data)))
        sources.append(dict(name=name, destination=destination, files=files,
                            expanded_size=sum(item["size"] for item in files)))
    lock = dict(schema_version=1, package_version="0.1.0", min_app_version="0.16.1",
                node_version="22.19.0", sources=sources)
    return contents, lock


def tar_bytes(contents, mutate=None, names=None):
    pieces = []
    for name in names or sorted(contents):
        data = contents[name]
        info = tarfile.TarInfo(name)
        info.mode, info.size = 0o644, len(data)
        if mutate:
            mutate(info)
        pieces += [info.tobuf(tarfile.USTAR_FORMAT), data,
                   bytes((-len(data)) % 512)]
    return b"".join(pieces) + bytes(1024)


def stage_fixture(root):
    contents, lock = fixture()
    canonical = gzip.compress(tar_bytes(contents), mtime=0)
    stage = root / "stage"
    stage.mkdir()
    for name, data in (("bundle.tar.gz", canonical), ("source-lock.json", json_bytes(lock))):
        (stage / name).write_bytes(data)
        (stage / name).chmod(0o644)
    package = json.loads((ROOT / SOURCE / "package-template.json").read_bytes())
    targets = package["package"]["lsp"]["distribution"]["binary"]
    for target in TARGETS:
        targets[target].update(sha256=digest(canonical), size=len(canonical),
            entry_sha256=digest(contents[ENTRY]), entry_size=len(contents[ENTRY]))
    entry = dict(kind="lsp", id="typescript-language-server")
    return contents, canonical, stage, entry, package


class ArchiveTests(unittest.TestCase):
    def test_primary_reviewed_archive_matches_all_145_locked_files(self):
        payload = ROOT / SOURCE / "payload"
        lock = json.loads((payload / "source-lock.json").read_bytes())
        data = (payload / "bundle.tar.gz").read_bytes()
        self.assertEqual(digest(data), "295472a5ede14af100e3a0fb0eb121d71d2818ee05399ffb3dac3290b0ec7286")
        self.assertEqual(len(inspect_bundle(data, inventory(lock))), 145)

    def test_unpack_checks_every_member_before_creating_runtime_and_never_executes_node(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            contents, canonical, stage, _, _ = stage_fixture(root)
            runtime = root / "runtime"
            self.assertEqual(unpack(stage, runtime, "0.1.0", "0.16.1"), canonical)
            files = [path for path in runtime.rglob("*") if path.is_file()]
            self.assertEqual(len(files), 145)
            for path in files:
                self.assertEqual(path.stat().st_mode & 0o777, 0o644)
                self.assertEqual(path.read_bytes(), contents[path.relative_to(runtime).as_posix()])
            (stage / "bundle.tar.gz").write_bytes(canonical + b"trailing")
            with self.assertRaises(SystemExit):
                unpack(stage, root / "rejected", "0.1.0", "0.16.1")
            self.assertFalse((root / "rejected").exists())

    def test_tar_member_types_modes_and_owner_timestamps_are_closed(self):
        contents, lock = fixture()
        for change in (lambda i: setattr(i, "mode", 0o755), lambda i: setattr(i, "uid", 1),
            lambda i: setattr(i, "gid", 1), lambda i: setattr(i, "mtime", 1),
            lambda i: setattr(i, "uname", "user"), lambda i: setattr(i, "gname", "group"),
            lambda i: setattr(i, "linkname", "elsewhere"),
            *(lambda i, kind=kind: setattr(i, "type", kind) for kind in (
                tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE,
                tarfile.CHRTYPE, tarfile.GNUTYPE_SPARSE, tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME))):
            with self.assertRaises(SystemExit):
                inspect_bundle(gzip.compress(tar_bytes(contents, change), mtime=0), inventory(lock))

    def test_extra_duplicate_missing_unordered_and_changed_members_are_rejected(self):
        contents, lock = fixture()
        expected = inventory(lock)
        for names in (sorted(contents)[:-1], [*sorted(contents), ENTRY], list(reversed(sorted(contents)))):
            with self.assertRaises(SystemExit):
                inspect_bundle(gzip.compress(tar_bytes(contents, names=names), mtime=0), expected)
        changed = dict(contents)
        changed[ENTRY] = bytes(len(contents[ENTRY]))
        extra = {**contents, "extra.js": b"extra"}
        for values in (changed, extra):
            with self.assertRaises(SystemExit):
                inspect_bundle(gzip.compress(tar_bytes(values), mtime=0), expected)

    def test_gzip_tar_terminators_padding_and_expansion_are_bounded(self):
        contents, lock = fixture()
        raw = tar_bytes(contents)
        compressed = gzip.compress(raw, mtime=0)
        padding = bytearray(raw)
        padding[512 + len(contents[ENTRY])] = 1
        header = bytearray(raw)
        header[0] ^= 1
        for value in (compressed[:-1], compressed + b"junk", compressed + gzip.compress(b"", mtime=0),
            gzip.compress(raw[:-512], mtime=0), gzip.compress(raw + bytes(512), mtime=0),
            gzip.compress(raw + raw, mtime=0), gzip.compress(padding, mtime=0), gzip.compress(header, mtime=0)):
            with self.assertRaises(SystemExit):
                inspect_bundle(value, inventory(lock))
        with patch("official_plugin_lsp_archive.MAX_BUNDLE", 200), self.assertRaises(SystemExit):
            decode_bundle(gzip.compress(bytes(1000), mtime=0))
        with self.assertRaises(SystemExit):
            decode_bundle(b"not gzip")

    def test_lock_inventory_and_paths_reject_aliases_links_and_partial_reviews(self):
        _, lock = fixture()
        for path in ("../escape", "/absolute", "a//b", "a/.hidden", "a/../b", "a\\b", "a:b", "x\0y"):
            with self.assertRaises(SystemExit):
                member_path(path)
        for change in (lambda d: d["sources"].pop(), lambda d: d["sources"][0]["files"].pop(),
            lambda d: d["sources"][0].update(destination="../outside"),
            lambda d: d["sources"][0]["files"][0].update(sha256="wrong"),
            lambda d: d["sources"][0]["files"][0].update(size=True),
            lambda d: d.update(schema_version=True),
            lambda d: d["sources"][0]["files"].append(d["sources"][0]["files"][0])):
            changed = copy.deepcopy(lock)
            change(changed)
            with self.assertRaises(SystemExit):
                inventory(changed)


class PolicyTests(unittest.TestCase):
    def test_flat_tag_requires_exact_allowlisted_policy_identity_source_and_version(self):
        policy = json.loads((ROOT / "plugins/release-policy.json").read_bytes())
        self.assertEqual(release_tag(TAG, policy), (PLUGIN, "0.1.0"))
        for tag in ("plugins/lsp-typescript-language-server/v0.1.0", "lsp-other-v0.1.0", TAG + "\n", TAG.replace("0.1.0", "00.1.0")):
            with self.assertRaises(ValueError):
                release_tag(tag, policy)
        for field, value in (("kind", "provider"), ("id", "other"), ("version", "1.0.0"),
            ("source_path", "plugins/other"), ("package", "plugins/other/package.json"), ("preparation", "PENDING")):
            changed = copy.deepcopy(policy)
            changed["plugins"][PLUGIN][field] = value
            with self.assertRaises(ValueError):
                release_tag(TAG, changed)
        self.assertEqual(release_tag("plugins/theme-graphite/v0.1.0", {}), ("theme-graphite", "0.1.0"))

    def test_lsp_candidate_policy_must_equal_trusted_main_policy(self):
        spec = importlib.util.spec_from_file_location("official_prepare", ROOT / "scripts/official-plugin-prepare.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        policy = json.loads((ROOT / "plugins/release-policy.json").read_bytes())
        changed = copy.deepcopy(policy)
        changed["plugins"][PLUGIN]["release_notes"] += " unreviewed change"
        with patch.dict(os.environ, {"ROOT": str(ROOT)}), patch.object(module, "source", return_value=json_bytes(changed)):
            with self.assertRaises(SystemExit):
                module.read_policy("unused", "a" * 40, TAG, "author-approved")

    def test_reviewed_lsp_notes_are_bounded_and_other_kinds_keep_generic_notes(self):
        self.assertEqual(release_notes({"kind": "lsp", "release_notes": "Reviewed\nnotes"}, TAG), "Reviewed\nnotes")
        for notes in (None, 1, " ", "bad\0notes", "x" * 16385, "é" * 8193):
            with self.assertRaises(ValueError):
                release_notes({"kind": "lsp", "release_notes": notes}, TAG)
        self.assertEqual(release_notes({"kind": "theme", "release_notes": None}, TAG), "Official plugin release " + TAG)


class PackTests(unittest.TestCase):
    def test_all_three_targets_pack_twice_and_validate_after_capture_with_exact_receipts(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            contents, canonical, stage, entry, package = stage_fixture(root)
            calls = []
            def run(*args):
                calls.append(args)
                if args[:2] == ("plugin", "validate"):
                    self.assertTrue((Path(args[2]) / "lsp.json").is_file())
                    return b""
                output = Path(args[args.index("--output") + 1])
                output.write_bytes(canonical)
                return json_bytes(dict(kind="lsp", target=args[args.index("--target") + 1],
                    archive=str(output), sha256=digest(canonical), size=len(canonical), entry=ENTRY,
                    entry_sha256=digest(contents[ENTRY]), entry_size=len(contents[ENTRY]), runtime="node"))
            before = copy.deepcopy(package)
            archives = pack(run, root, entry, package, {target: stage for target in TARGETS}, TAG, "0.1.0")
            self.assertEqual(package, before)
            self.assertEqual([a["target"] for a in archives], list(TARGETS))
            self.assertEqual(len(calls), 7)
            self.assertEqual(calls[-1][:2], ("plugin", "validate"))

    def test_receipt_and_byte_equality_gates_refuse_every_binding_drift(self):
        for field in ("kind", "target", "archive", "sha256", "size", "entry", "entry_sha256", "entry_size", "runtime", "bytes"):
            with tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                contents, canonical, stage, entry, package = stage_fixture(root)
                def run(*args):
                    output = Path(args[args.index("--output") + 1])
                    output.write_bytes(canonical if field != "bytes" else canonical + b"changed")
                    receipt = dict(kind="lsp", target=args[args.index("--target") + 1], archive=str(output),
                        sha256=digest(canonical), size=len(canonical), entry=ENTRY,
                        entry_sha256=digest(contents[ENTRY]), entry_size=len(contents[ENTRY]), runtime="node")
                    if field != "bytes":
                        receipt[field] = "changed"
                    return json_bytes(receipt)
                with self.assertRaises(SystemExit):
                    pack(run, root, entry, package, {target: stage for target in TARGETS}, TAG, "0.1.0")


if __name__ == "__main__":
    unittest.main()
