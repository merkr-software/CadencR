"""Closed official tag admission shared by preparation and protected reconstruction."""
import re

SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
LEGACY_TAG = re.compile(r"plugins/((?:provider|theme|tab)-[a-z][a-z0-9-]*)/v(" + SEMVER + r")")
LSP_TAG = re.compile(r"(lsp-typescript-language-server)-v(" + SEMVER + r")")
LSP_SOURCE = "plugins/lsp/typescript-language-server"


def release_tag(tag, policy):
    match = LEGACY_TAG.fullmatch(tag)
    if match:
        return match.groups()
    match = LSP_TAG.fullmatch(tag)
    if not match:
        raise ValueError("invalid official plugin tag")
    plugin, version = match.groups()
    entry = policy.get("plugins", {}).get(plugin)
    if (not isinstance(entry, dict) or entry.get("kind") != "lsp"
            or entry.get("id") != "typescript-language-server" or entry.get("version") != version
            or entry.get("source_path") != LSP_SOURCE
            or entry.get("package") != LSP_SOURCE + "/package-template.json"
            or entry.get("preparation") != "READY"):
        raise ValueError("flat LSP tag is not admitted by the trusted source policy")
    return plugin, version


def release_notes(entry, tag):
    if entry.get("kind") != "lsp" or "release_notes" not in entry:
        return "Official plugin release " + tag
    notes = entry["release_notes"]
    if not isinstance(notes, str) or not notes.strip() or "\0" in notes or len(notes.encode()) > 16384:
        raise ValueError("invalid reviewed LSP release notes")
    return notes
