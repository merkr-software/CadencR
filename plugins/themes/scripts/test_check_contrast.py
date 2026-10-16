"""Mutation tests proving the gate fails closed. Modified for monorepo paths."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from check_contrast import check_document, check_folder, luminance, ratio, THEMES

ROOT = Path(__file__).resolve().parent.parent


class ContrastTests(unittest.TestCase):
    def setUp(self):
        self.document = json.loads((ROOT / 'graphite/theme.json').read_text())

    def test_original_sources(self):
        for name in THEMES:
            with self.subTest(theme=name):
                self.assertEqual(len(check_folder(ROOT / name)), 40)

    def test_reference_colors(self):
        self.assertEqual(luminance('#000000'), 0)
        self.assertEqual(luminance('#ffffff'), 1)
        self.assertEqual(ratio('#000000', '#ffffff'), 21)

    def test_every_pair_rejects_invisible_text(self):
        from check_contrast import PAIRS, TERMINAL_PAIRS
        for state, foreground, background, minimum in PAIRS:
            document = copy.deepcopy(self.document)
            document['cssVars'][foreground] = document['cssVars'][background]
            with self.subTest(state=state, foreground=foreground, background=background):
                with self.assertRaises(ValueError):
                    check_document(document)
        for state, foreground, background in TERMINAL_PAIRS:
            document = copy.deepcopy(self.document)
            document['xterm'][foreground] = document['xterm'][background]
            with self.subTest(state=state):
                with self.assertRaises(ValueError):
                    check_document(document)

    def test_light_terminal_rejected_for_both_appearances(self):
        for appearance in ('dark', 'light'):
            document = copy.deepcopy(self.document)
            document['appearance'] = appearance
            document['xterm']['background'] = '#ffffff'
            with self.assertRaises(ValueError):
                check_document(document)

    def test_source_constraints(self):
        for key, value in [('chrome', {'asset': 'texture.png'}), ('script', 'evil'), ('number', float('inf'))]:
            document = copy.deepcopy(self.document)
            document[key] = value
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    check_document(document)
        for value in ('url(file:///private/image)', '#fff', 'rgba(0,0,0,.5)', float('nan')):
            document = copy.deepcopy(self.document)
            document['cssVars']['--foreground'] = value
            with self.assertRaises(ValueError):
                check_document(document)

    def test_missing_token(self):
        del self.document['cssVars']['--foreground']
        with self.assertRaises(KeyError):
            check_document(self.document)

    def test_folder_rejects_assets_executable_symlink_duplicate_and_nonfinite(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = folder / 'theme.json'
            source.write_text(json.dumps(self.document))
            source.chmod(0o644)
            self.assertEqual(len(check_folder(folder)), 40)
            asset = folder / 'texture.png'
            asset.write_bytes(b'image')
            with self.assertRaises(ValueError):
                check_folder(folder)
            asset.unlink()
            source.chmod(0o755)
            with self.assertRaises(ValueError):
                check_folder(folder)
            source.chmod(0o644)
            for content in ('{"label":"a","label":"b"}', '{"value":NaN}', '{"value":1e999}'):
                source.write_text(content)
                with self.assertRaises(ValueError):
                    check_folder(folder)
            source.unlink()
            source.symlink_to(ROOT / 'graphite/theme.json')
            with self.assertRaises(ValueError):
                check_folder(folder)


if __name__ == '__main__':
    unittest.main()
