"""Security-boundary checks for upstream acquisition and deterministic overlays."""
import io
import hashlib
from pathlib import Path
import tarfile
import tempfile
import unittest

from node_acquire import unpack, relative
from node_overlay import archive_bytes, source_bindings


def archive(members):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as stream:
        for name, data, kind in members:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(data)
            stream.addfile(member, io.BytesIO(data))
    return output.getvalue()


class NodeAcquisitionTest(unittest.TestCase):
    def test_safe_historical_npm_top_directory_and_empty_file(self):
        data = archive([("estree/package.json", b'{"name":"@types/estree","version":"1.0.0"}', tarfile.REGTYPE),
                        ("estree/empty", b"", tarfile.REGTYPE)])
        with tempfile.TemporaryDirectory() as directory:
            files, expanded, metadata = unpack(data, Path(directory))
            self.assertEqual(metadata["name"], "@types/estree")
            self.assertEqual(next(file for file in files if file["path"] == "empty")["size"], 0)
            self.assertEqual(expanded, sum(file["size"] for file in files))

    def test_rejects_traversal_links_duplicate_members_and_mixed_roots(self):
        cases = [[("package/../escape", b"x", tarfile.REGTYPE)],
                 [("package/link", b"", tarfile.SYMTYPE)],
                 [("package/a", b"a", tarfile.REGTYPE), ("package/a", b"a", tarfile.REGTYPE)],
                 [("package/a", b"a", tarfile.REGTYPE), ("another/b", b"b", tarfile.REGTYPE)]]
        for members in cases:
            with self.subTest(members=members), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    unpack(archive(members), Path(directory))

    def test_runtime_dollar_and_dotfiles_are_safe_but_dot_segments_are_not(self):
        relative("lib/common/protocol.$.js")
        relative(".config/value.json")
        for value in ["a/../b", "a/./b", "/absolute", "a//b", "a\\b"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                relative(value)

    def test_reviewed_overlay_archive_bytes_are_deterministic(self):
        first = archive_bytes({"server.mjs": b"export {};\n", "LICENSE": b"License\n"})
        second = archive_bytes({"LICENSE": b"License\n", "server.mjs": b"export {};\n"})
        self.assertEqual(first, second)
        with tarfile.open(fileobj=io.BytesIO(first), mode="r:gz") as stream:
            self.assertEqual(stream.getnames(), ["package/LICENSE", "package/server.mjs"])
            self.assertTrue(all(member.mtime == 0 and member.mode == 0o644 for member in stream))

    def test_each_overlay_url_binds_exact_raw_file_bytes(self):
        contents = {"server.mjs": b"export {};\n", "LICENSE": b"License\n"}
        commit = "c" * 40
        sources = source_bindings(contents, {"id": "vue-language-server", "package_version": "0.1.0"},
                                  commit, "plugins/lsp/vue-language-server/bridge", "bridge")
        self.assertEqual(len(sources), len(contents))
        self.assertEqual(len({(source["name"], source["destination"]) for source in sources}), len(contents))
        for source in sources:
            file = source["files"][0]
            data = contents[file["path"]]
            self.assertEqual(source["url"], "https://raw.githubusercontent.com/merkr-software/CadencR/"
                             + commit + "/plugins/lsp/vue-language-server/bridge/" + file["path"])
            self.assertEqual(source["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(file["sha256"], source["sha256"])
            self.assertEqual(source["expanded_size"], len(data))
            self.assertEqual(source["destination"], "bridge")


if __name__ == "__main__":
    unittest.main()
