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
from official_plugin_lsp_archive import inventory, inspect_bundle, decode_bundle, member_path, declarative_path, unpack
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


def declarative_fixture(root, runtime="node", target="all"):
    entry = "dist/server.js" if runtime == "node" else "bin/server"
    contents = {entry: b"inert " + target.encode()}
    if runtime == "node":
        contents["node_modules/dependency/empty.txt"] = b""
    files = [dict(path=name, sha256=digest(data), size=len(data),
                  mode="100755" if runtime == "native" else "100644") for name, data in sorted(contents.items())]
    lock = dict(schema_version=2, id="example", package_version="0.2.0", min_app_version="0.16.1",
                runtime=runtime, entry=entry, target=target, sources=[dict(name="example", version="1.2.3",
                    url="https://example.com/releases/example.tar.gz", sha256="a" * 64,
                    destination=".", expanded_size=sum(map(len, contents.values())), files=files)])
    raw = tar_bytes(contents, (lambda item: setattr(item, "mode", 0o755)) if runtime == "native" else None)
    canonical = gzip.compress(raw, mtime=0)
    stage = root / ("stage-" + target)
    stage.mkdir()
    (stage / "bundle.tar.gz").write_bytes(canonical)
    (stage / "source-lock.json").write_bytes(json_bytes(lock))
    for path in stage.iterdir():
        path.chmod(0o644)
    return contents, lock, canonical, stage


class DeclarativeTests(unittest.TestCase):
    def test_node_and_each_native_target_unpack_with_reviewed_modes(self):
        for runtime, target in (("node", "all"), *(("native", target) for target in TARGETS)):
            with tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                contents, lock, canonical, stage = declarative_fixture(root, runtime, target)
                destination = root / "runtime"
                self.assertEqual(unpack(stage, destination, "0.2.0", "0.16.1", "example",
                                        TARGETS[0] if target == "all" else target, runtime, lock["entry"]), canonical)
                for path, value in contents.items():
                    self.assertEqual((destination / path).read_bytes(), value)
                    self.assertEqual((destination / path).stat().st_mode & 0o777,
                                     0o755 if runtime == "native" else 0o644)

    def test_closed_schema_inventory_provenance_and_portable_paths(self):
        with tempfile.TemporaryDirectory() as scratch:
            _, lock, _, _ = declarative_fixture(Path(scratch))
            mutations = (
                lambda value: value.update(extra="script"),
                lambda value: value.update(id="../escape"),
                lambda value: value.update(package_version=True),
                lambda value: value.update(min_app_version="PENDING"),
                lambda value: value.update(target="linux-x86_64"),
                lambda value: value.update(entry="missing.js"),
                lambda value: value.update(runtime="python"),
                lambda value: value["sources"][0].update(extra="install.sh"),
                lambda value: value["sources"][0].update(url="https://user:secret@example.com/source"),
                lambda value: value["sources"][0].update(url="https://example.com/source?token=secret"),
                lambda value: value["sources"][0].update(sha256="unreviewed"),
                lambda value: value["sources"][0].update(destination="../escape"),
                lambda value: value["sources"][0].update(expanded_size=0),
                lambda value: value["sources"][0]["files"][0].update(mode="100755"),
                lambda value: value["sources"][0]["files"][0].update(size=True),
                lambda value: value["sources"][0]["files"][0].update(path="../escape"),
                lambda value: value["sources"][0]["files"][0].update(extra="link"),
                lambda value: value["sources"].append(copy.deepcopy(value["sources"][0])),
            )
            for mutate in mutations:
                changed = copy.deepcopy(lock)
                mutate(changed)
                with self.assertRaises(SystemExit):
                    inventory(changed)
            for path in ("DIST/server.js", "dist", "DIST/server.js/child"):
                changed = copy.deepcopy(lock)
                changed["sources"][0]["files"][1]["path"] = path
                with self.assertRaises(SystemExit):
                    inventory(changed)

    def test_native_data_is_readable_and_context_mismatch_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            contents, lock, _, stage = declarative_fixture(root, "native", "linux-x86_64")
            changed = copy.deepcopy(lock)
            changed["sources"][0]["files"].append(dict(path="companion.so", sha256=digest(b""), size=0, mode="100644"))
            self.assertEqual(inventory(changed)["companion.so"]["mode"], "100644")
            raw = tar_bytes({**contents, "companion.so": b""},
                            lambda item: setattr(item, "mode", 0o755 if item.name == "bin/server" else 0o644))
            (stage / "bundle.tar.gz").write_bytes(gzip.compress(raw, mtime=0))
            (stage / "source-lock.json").write_bytes(json_bytes(changed))
            unpack(stage, root / "accepted", "0.2.0", "0.16.1", "example", "linux-x86_64", "native", "bin/server")
            self.assertEqual((root / "accepted/companion.so").stat().st_mode & 0o777, 0o644)
            changed["sources"][0]["files"][-1]["mode"] = "100755"
            with self.assertRaises(SystemExit):
                inventory(changed)
            for identity, target, runtime, entry in (("other", "linux-x86_64", "native", "bin/server"),
                    ("example", "darwin-aarch64", "native", "bin/server"),
                    ("example", "linux-x86_64", "node", "bin/server"),
                    ("example", "linux-x86_64", "native", "elsewhere")):
                with self.assertRaises(SystemExit):
                    unpack(stage, root / "rejected", "0.2.0", "0.16.1", identity, target, runtime, entry)
                self.assertFalse((root / "rejected").exists())
            for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.XHDTYPE):
                raw = tar_bytes({"bin/server": b"inert linux-x86_64"}, lambda item: (setattr(item, "mode", 0o755), setattr(item, "type", kind)))
                with self.assertRaises(SystemExit):
                    inspect_bundle(gzip.compress(raw, mtime=0), inventory(lock), 1024 * 1024, 1024 * 1024)

    def test_schema_two_uses_explicit_larger_budgets_without_widening_legacy(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            _, lock, canonical, stage = declarative_fixture(root)
            with patch("official_plugin_lsp_archive.MAX_BUNDLE", 200):
                with self.assertRaises(SystemExit):
                    decode_bundle(canonical)
                self.assertEqual(unpack(stage, root / "runtime", "0.2.0", "0.16.1", "example",
                                        "linux-x86_64", "node", lock["entry"]), canonical)
            with self.assertRaises(SystemExit):
                decode_bundle(canonical, expanded_limit=200, archive_limit=1024 * 1024)
            with patch("official_plugin_lsp_archive.MAX_FILES", 1), self.assertRaises(SystemExit):
                inventory(lock)
            with patch("official_plugin_lsp_archive.MAX_ARCHIVE", len(canonical) - 1), self.assertRaises(SystemExit):
                unpack(stage, root / "oversized", "0.2.0", "0.16.1", "example", "linux-x86_64", "node", lock["entry"])
            self.assertFalse((root / "oversized").exists())

    def test_declarative_paths_include_required_npm_names_and_reject_secret_components(self):
        for path in ("node_modules/protocol.$.js", ".github/workflows/check.yml", "node_modules/.bin-data/runtime.js",
                     "meta/default utf8/basic.lua", "meta/français/basic.lua"):
            self.assertEqual(declarative_path(path), path)
        for path in ("../escape", "/absolute", "a//b", "a/../b", "a/./b", "a\\b", "a:b", "x\0y",
                     ".git/config", "node_modules/.env", "foo/.env.production", "foo/SECRET.KEY", "id_rsa",
                     "name./file", "name /file", "COM1.txt", "name\x85file"):
            with self.assertRaises(SystemExit):
                declarative_path(path)
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            contents, lock, _, stage = declarative_fixture(root)
            path = "node_modules/protocol.$.js"
            old = "node_modules/dependency/empty.txt"
            contents[path] = contents.pop(old)
            lock["sources"][0]["files"][1]["path"] = path
            (stage / "bundle.tar.gz").write_bytes(gzip.compress(tar_bytes(contents), mtime=0))
            (stage / "source-lock.json").write_bytes(json_bytes(lock))
            unpack(stage, root / "accepted", "0.2.0", "0.16.1", "example", "linux-x86_64", "node", lock["entry"])
            self.assertEqual((root / "accepted" / path).read_bytes(), b"")

    def test_schema_two_rejects_unicode_normalization_aliases(self):
        with tempfile.TemporaryDirectory() as scratch:
            _, lock, _, _ = declarative_fixture(Path(scratch))
            for path in ("caf\u00e9/file.js", "cafe\u0301/file.js"):
                lock["sources"][0]["files"].append(dict(path=path, sha256=digest(b""), size=0, mode="100644"))
            with self.assertRaises(SystemExit):
                inventory(lock)

    def test_schema_two_accepts_canonical_depth_first_prefix_siblings(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            contents, lock, _, stage = declarative_fixture(root)
            contents.update({"a/child.txt": b"nested", "a-file.txt": b"sibling"})
            source = lock["sources"][0]
            source["files"] += [dict(path=name, sha256=digest(contents[name]), size=len(contents[name]), mode="100644")
                                for name in ("a/child.txt", "a-file.txt")]
            source["expanded_size"] = sum(map(len, contents.values()))
            names = sorted(contents, key=lambda name: name.split("/"))
            self.assertNotEqual(names, sorted(contents))
            canonical = gzip.compress(tar_bytes(contents, names=names), mtime=0)
            expected = inventory(lock)
            self.assertEqual(inspect_bundle(canonical, expected), contents)
            with self.assertRaises(SystemExit):
                inspect_bundle(gzip.compress(tar_bytes(contents), mtime=0), expected)

    def test_generic_flat_tag_remains_closed_by_policy(self):
        policy = {"plugins": {"lsp-example": dict(kind="lsp", id="example", version="0.2.0",
                    source_path="plugins/lsp/example", package="plugins/lsp/example/package-template.json", preparation="READY")}}
        self.assertEqual(release_tag("lsp-example-v0.2.0", policy), ("lsp-example", "0.2.0"))
        for tag in ("lsp-other-v0.2.0", "lsp-example-v0.2.1", "lsp-example-v00.2.0"):
            with self.assertRaises(ValueError):
                release_tag(tag, policy)

    def test_target_specific_native_packing_uses_six_exact_receipts_and_three_validations(self):
        with tempfile.TemporaryDirectory() as scratch:
            root, stages, targets, captured, calls = Path(scratch), {}, {}, {}, []
            tag = "lsp-example-v0.2.0"
            for target in TARGETS:
                contents, lock, canonical, stage = declarative_fixture(root, "native", target)
                stages[target], captured[target] = stage, canonical
                name = "lsp-example-0.2.0-" + target + ".tar.gz"
                targets[target] = dict(archive="https://github.com/merkr-software/CadencR/releases/download/" + tag + "/" + name,
                    sha256=digest(canonical), size=len(canonical), entry=lock["entry"],
                    entry_sha256=digest(contents[lock["entry"]]), entry_size=len(contents[lock["entry"]]), runtime="native")
            package = dict(kind="lsp", package=dict(lsp=dict(id="example", version="0.2.0", distribution=dict(binary=targets)),
                            host=dict(compatibility=dict(min_app_version="0.16.1"))))
            def run(*args):
                calls.append(args)
                if args[:2] == ("plugin", "validate"):
                    self.assertEqual(json.loads((Path(args[2]) / "lsp.json").read_bytes()), package)
                    target = args[args.index("--target") + 1]
                    self.assertEqual(Path(args[args.index("--archive") + 1]).read_bytes(), captured[target])
                    self.assertEqual((Path(args[2]) / "bin/server").read_bytes(), b"inert " + target.encode())
                    return b""
                target = args[args.index("--target") + 1]
                self.assertEqual(args[args.index("--runtime") + 1], "native")
                stage = Path(args[args.index("--directory") + 1])
                self.assertFalse((stage / "lsp.json").exists())
                self.assertEqual((stage / "bin/server").stat().st_mode & 0o777, 0o755)
                output = Path(args[args.index("--output") + 1])
                output.write_bytes(captured[target])
                return json_bytes({**targets[target], "kind": "lsp", "target": target, "archive": str(output)})
            before = copy.deepcopy(package)
            archives = pack(run, root, dict(kind="lsp", id="example"), package, stages, tag, "0.2.0")
            self.assertEqual(package, before)
            self.assertEqual(len({archive["sha256"] for archive in archives}), 3)
            self.assertEqual(len(calls), 9)
            self.assertEqual([call[:2] for call in calls[-3:]], [("plugin", "validate")] * 3)


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
    def test_original_node_payload_uses_only_0155_compatible_validation(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            contents, canonical, stage, entry, package = stage_fixture(root)
            calls = []
            def run(*args):
                calls.append(args)
                if args[:2] == ("plugin", "validate"):
                    self.assertEqual(args[3:], ("--kind", "lsp"))
                    self.assertEqual(json.loads((Path(args[2]) / "lsp.json").read_bytes()), package)
                    return b""
                output = Path(args[args.index("--output") + 1])
                output.write_bytes(canonical)
                return json_bytes(dict(kind="lsp", target=args[args.index("--target") + 1],
                    archive=str(output), sha256=digest(canonical), size=len(canonical), entry=ENTRY,
                    entry_sha256=digest(contents[ENTRY]), entry_size=len(contents[ENTRY]), runtime="node"))
            archives = pack(run, root, entry, package, {target: stage for target in TARGETS}, TAG, "0.1.0")
            self.assertEqual(len(archives), 3)
            self.assertEqual(len(calls), 7)
            self.assertEqual(calls[-1][:2], ("plugin", "validate"))

    def test_schema_two_node_without_a_minimum_still_verifies_each_real_archive(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            contents, lock, canonical, stage = declarative_fixture(root)
            entry = lock["entry"]
            tag = "lsp-example-v0.2.0"
            targets = {target: dict(archive="https://github.com/merkr-software/CadencR/releases/download/" + tag
                        + "/lsp-example-0.2.0-" + target + ".tar.gz", sha256=digest(canonical),
                        size=len(canonical), entry=entry, entry_sha256=digest(contents[entry]),
                        entry_size=len(contents[entry]), runtime="node") for target in TARGETS}
            package = dict(kind="lsp", package=dict(lsp=dict(id="example", version="0.2.0",
                        distribution=dict(binary=targets)), host=dict(compatibility=dict(min_app_version="0.16.1"))))
            calls = []
            def run(*args):
                calls.append(args)
                target = args[args.index("--target") + 1]
                if args[:2] == ("plugin", "validate"):
                    self.assertEqual(json.loads((Path(args[2]) / "lsp.json").read_bytes()), package)
                    self.assertEqual(Path(args[args.index("--archive") + 1]).read_bytes(), canonical)
                    return b""
                output = Path(args[args.index("--output") + 1])
                output.write_bytes(canonical)
                return json_bytes({**targets[target], "kind": "lsp", "target": target, "archive": str(output)})
            pack(run, root, dict(id="example", kind="lsp"), package,
                 {target: stage for target in TARGETS}, tag, "0.2.0")
            self.assertEqual(len(calls), 9)
            self.assertEqual([call[:2] for call in calls[-3:]], [("plugin", "validate")] * 3)

    def test_all_three_targets_pack_twice_and_validate_after_capture_with_exact_receipts(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            contents, canonical, stage, entry, package = stage_fixture(root)
            calls = []
            for target in TARGETS:
                package["package"]["lsp"]["distribution"]["binary"][target]["node_min_version"] = "22.18.0"
            def run(*args):
                calls.append(args)
                if args[:2] == ("plugin", "validate"):
                    self.assertEqual(json.loads((Path(args[2]) / "lsp.json").read_bytes()), package)
                    target = args[args.index("--target") + 1]
                    self.assertIn(target, TARGETS)
                    self.assertEqual(Path(args[args.index("--archive") + 1]).read_bytes(), canonical)
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
            self.assertEqual(len(calls), 9)
            self.assertEqual([call[:2] for call in calls[-3:]], [("plugin", "validate")] * 3)

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
