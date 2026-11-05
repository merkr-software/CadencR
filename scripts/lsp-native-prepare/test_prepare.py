"""Security and architecture checks for native acquisition; no candidate execution."""
import io
import json
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from archive import bounded, executable, retained, safe_name, selected
from prepare import acquire
from transform import macho_slice, transform


def tar(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, data, kind in entries:
            entry = tarfile.TarInfo(name)
            entry.size, entry.type = len(data), kind
            archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


def macho(cpu):
    return b"\xcf\xfa\xed\xfe" + struct.pack("<I", cpu) + bytes(24)


class NativePreparationTests(unittest.TestCase):
    def test_paths_reject_traversal_absolute_empty_and_backslash(self):
        for name in ("/absolute", "../escape", "a/../b", "a//b", "a/./b", "a\\b", ""):
            self.assertFalse(safe_name(name), name)
        self.assertTrue(safe_name("lib/clang/23/include/stddef.h"))

    def test_selected_tar_refuses_duplicates_and_symlinks(self):
        with self.assertRaisesRegex(ValueError, "unique regular"):
            selected(tar([("server", b"a", tarfile.REGTYPE), ("server", b"b", tarfile.REGTYPE)]), "tar.gz", "server")
        with self.assertRaisesRegex(ValueError, "unique regular"):
            selected(tar([("server", b"", tarfile.SYMTYPE)]), "tar.gz", "server")

    def test_retained_tree_refuses_paths_links_and_native_companions(self):
        spec = {"entry": "server", "format": "tar.gz", "retain_tree": True}
        for entries in ([('../escape', b'a', tarfile.REGTYPE)], [('link', b'', tarfile.SYMTYPE)],
                        [('helper', b'\x7fELFdata', tarfile.REGTYPE)]):
            with self.assertRaises(ValueError):
                retained(tar(entries), spec)

    def test_retained_tree_normalizes_prefix_and_keeps_data(self):
        spec = {"entry": "server", "format": "tar.gz", "retain_tree": True, "strip_prefix": "package/"}
        result = retained(tar([('package/server', b'bin', tarfile.REGTYPE),
                               ('package/lib/standard.d.ts', b'types', tarfile.REGTYPE)]), spec)
        self.assertEqual(result, {"server": b"bin", "lib/standard.d.ts": b"types"})

    def test_clangd_allowlist_omits_unneeded_native_runtime_objects(self):
        spec = {"entry": "bin/clangd", "format": "tar.gz", "retain_tree": True,
                "strip_prefix": "root/", "retain_prefixes": ["bin/clangd", "lib/clang/23/include/"]}
        result = retained(tar([('root/bin/clangd', b'bin', tarfile.REGTYPE),
            ('root/lib/clang/23/lib/runtime.o', b'\x7fELFobject', tarfile.REGTYPE),
            ('root/lib/clang/23/include/stddef.h', b'header', tarfile.REGTYPE)]), spec)
        self.assertEqual(set(result), {"bin/clangd", "lib/clang/23/include/stddef.h"})

    def test_audited_git_pointer_omission_keeps_lua_runtime_stubs(self):
        spec = {"entry": "bin/server", "format": "tar.gz", "retain_tree": True,
                "omit_files": ["meta/third/.git"]}
        result = retained(tar([("bin/server", b"bin", tarfile.REGTYPE),
            ("meta/third/.git", b"gitdir: unavailable", tarfile.REGTYPE),
            ("meta/third/library.lua", b"return {}", tarfile.REGTYPE)]), spec)
        self.assertEqual(set(result), {"bin/server", "meta/third/library.lua"})

    def test_decompression_budget_is_charged_to_real_bytes(self):
        with self.assertRaisesRegex(ValueError, "budget"):
            bounded(io.BytesIO(b"1234"), 3)
        with patch("archive.MAX_EXECUTABLE", 3), self.assertRaisesRegex(ValueError, "budget"):
            selected(tar([('server', b'1234', tarfile.REGTYPE)]), "tar.gz", "server")

    def test_architecture_mismatch_and_universal_slice_bounds(self):
        arm, intel = macho(0x100000c), macho(0x1000007)
        data = b"\xca\xfe\xba\xbe" + struct.pack(">I", 2)
        data += struct.pack(">IIIII", 0x100000c, 0, 48, len(arm), 0)
        data += struct.pack(">IIIII", 0x1000007, 0, 80, len(intel), 0)
        data += arm + intel
        self.assertEqual(macho_slice(data, "darwin-aarch64"), arm)
        executable(data, "darwin-x86_64")
        with self.assertRaises(ValueError):
            executable(arm, "darwin-x86_64")
        with self.assertRaises(ValueError):
            macho_slice(data[:-1], "darwin-x86_64")

    def test_download_pins_are_required_before_network(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                acquire({"url": "https://github.com/example/release", "sha256": "", "size": 1}, Path(directory), True)
            with self.assertRaisesRegex(ValueError, "HTTPS"):
                acquire({"url": "http://github.com/example/release", "sha256": "a" * 64, "size": 1}, Path(directory), True)

    def test_strip_failure_preserves_bounded_diagnostics_without_private_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            program = Path(directory) / "strip"
            program.touch()

            def run(command, **_options):
                if command[-1] == "--version":
                    return subprocess.CompletedProcess(command, 0, stdout=b"GNU strip 2.42\n")
                stderr = b"x" * 5000 + f"\n{command[0]}: {command[-1]}: format not recognized".encode()
                raise subprocess.CalledProcessError(1, command, stderr=stderr)

            with patch("transform.subprocess.run", side_effect=run), self.assertRaises(ValueError) as error:
                transform(b"upstream", {"transform": "gnu-strip-debug-2.42"}, "linux-x86_64", program)
            self.assertIn("<strip>: <input>: format not recognized", str(error.exception))
            self.assertNotIn(directory, str(error.exception))
            self.assertLessEqual(len(str(error.exception)), 4140)


if __name__ == "__main__":
    unittest.main()
