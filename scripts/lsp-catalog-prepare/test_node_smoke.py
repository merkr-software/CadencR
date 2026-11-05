"""The runtime probe must launch with the same declared options as the app."""
from pathlib import Path
import unittest

from node_smoke import initialization_options


class InitializationContractTest(unittest.TestCase):
    def test_empty_host_keeps_published_baseline_typing_acquisition_policy(self):
        recipe = {"initialization_options": {"disableAutomaticTypingAcquisition": True}}
        self.assertEqual(initialization_options(recipe, Path("/bundle"), True),
                         {"disableAutomaticTypingAcquisition": True})
        self.assertEqual(recipe["initialization_options"], {"disableAutomaticTypingAcquisition": True})

    def test_empty_host_does_not_inject_an_unpublished_sdk_assumption(self):
        self.assertEqual(initialization_options({"initialization_options": {}}, Path("/bundle"), True), {})


if __name__ == "__main__":
    unittest.main()
