"""Source facts and package identity checks; no network, authority, or legal attestation."""
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent.parent


class SourceReadinessTests(unittest.TestCase):
    def test_source_facts_and_package_identities(self):
        facts = json.loads((ROOT / 'readiness.json').read_text())
        self.assertEqual(facts['schema_version'], 1)
        self.assertEqual(facts['archive_contract'], ['theme.json'])
        license_facts = facts['source_license']
        self.assertEqual(license_facts['declared_spdx'], 'Apache-2.0')
        self.assertEqual(license_facts['sha256'], hashlib.sha256((ROOT / 'LICENSE').read_bytes()).hexdigest())
        self.assertEqual([theme['id'] for theme in facts['themes']], ['graphite', 'ember', 'fjord'])
        for theme in facts['themes']:
            with self.subTest(theme=theme['id']):
                source = ROOT / theme['source']
                self.assertEqual(source, ROOT / theme['id'] / 'theme.json')
                self.assertEqual(theme['sha256'], hashlib.sha256(source.read_bytes()).hexdigest())
                self.assertRegex(theme['archive_sha256'], r'^[a-f0-9]{64}$')
                document = json.loads(source.read_text())
                self.assertEqual(set(document), {'label', 'appearance', 'cssVars', 'xterm'})
                template = json.loads((ROOT / theme['package_template']).read_text())
                self.assertEqual(template['kind'], 'theme')
                package = template['package']
                identity = package['theme']
                self.assertEqual(identity['id'], theme['id'])
                self.assertEqual(identity['version'], theme['version'])
                self.assertEqual(identity['name'], document['label'])
                self.assertEqual(identity['license'], license_facts['declared_spdx'])
                self.assertEqual(identity['document_version'], 1)
                self.assertEqual(identity['repository'], 'https://github.com/merkr-software/CadencR')
                self.assertEqual(identity['distribution'], {'archive': 'PENDING', 'sha256': '0' * 64})
                self.assertEqual(package['host'], {'publisher': 'cadencr', 'compatibility': {'min_app_version': '0.15.0'}})


if __name__ == '__main__':
    unittest.main()
