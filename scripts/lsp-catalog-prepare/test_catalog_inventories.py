"""Every held Node recipe must produce a valid closed inventory after its overlay."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from official_plugin_lsp_archive import inventory
from node_overlay import source_bindings


class CatalogInventoryTest(unittest.TestCase):
    def test_every_node_candidate_has_a_valid_final_launch_inventory(self):
        recipes = sorted((ROOT / "plugins/lsp").glob("*/recipe.json"))
        self.assertEqual(len(recipes), 13)
        for path in recipes:
            with self.subTest(recipe=path.parent.name):
                recipe = json.loads(path.read_text())
                lock_path = path.parent / "payload/source-lock.json"
                lock = json.loads(lock_path.read_text())
                provenance = json.loads((path.parent / "payload/provenance.json").read_text())
                self.assertEqual(provenance["source_lock_sha256"],
                                 hashlib.sha256(lock_path.read_bytes()).hexdigest())
                lock = copy.deepcopy(lock)
                overlay = recipe.get("local_overlay")
                if overlay:
                    contents = {name: (ROOT / overlay["path"] / name).read_bytes()
                                for name in overlay["files"]}
                    destination = overlay["path"].rsplit("/", 1)[1]
                    # Synthetic commit is confined to this in-memory validation fixture.
                    lock["sources"].extend(source_bindings(contents, recipe, "0" * 40,
                                                          overlay["path"], destination))
                    lock["entry"] = recipe["entry"]
                expected = inventory(lock)
                self.assertIn(recipe["entry"], expected)
                self.assertTrue(recipe["entry"].endswith((".js", ".mjs", ".cjs")))
                self.assertGreater(expected[recipe["entry"]]["size"], 0)
                if "upstream_entry" in recipe and "config.json" in overlay["files"]:
                    config = json.loads((ROOT / overlay["path"] / "config.json").read_text())
                    self.assertEqual(config["entry"], recipe["upstream_entry"])
                    self.assertIn(recipe["upstream_entry"], expected)


if __name__ == "__main__":
    unittest.main()
