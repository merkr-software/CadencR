"""Supplemental visual gate; CLI is schema authority. Modified for monorepo paths."""
import json
import math
from pathlib import Path
import re
import stat
import sys

THEMES = ("graphite", "ember", "fjord")
# Contract-tier snapshot reviewed against CadencR v0.13.0; not a schema validator.
PAIRS = [('text', '--foreground', '--background', 4.5),
 ('text', '--card-foreground', '--card', 4.5),
 ('text', '--popover-foreground', '--popover', 4.5),
 ('text', '--sidebar-foreground', '--sidebar', 4.5),
 ('text', '--secondary-foreground', '--secondary', 4.5),
 ('text', '--code-fg', '--code-bg', 4.5),
 ('text', '--editor-fg', '--editor-bg', 4.5),
 ('text', '--block-bash-fg', '--block-bash-body-bg', 4.5),
 ('ui', '--primary-foreground', '--primary', 3),
 ('ui', '--sidebar-primary-foreground', '--sidebar-primary', 3),
 ('ui', '--accent-foreground', '--accent', 3),
 ('ui', '--sidebar-accent-foreground', '--sidebar-accent', 3),
 ('ui', '--muted-foreground', '--background', 3),
 ('ui', '--muted-foreground', '--muted', 3),
 ('ui', '--block-tool-accent', '--block-tool-bg', 3),
 ('ui', '--block-thinking-accent', '--block-thinking-bg', 3),
 ('ui', '--block-plan-accent', '--block-plan-bg', 3),
 ('distinct', '--destructive-foreground', '--destructive', 1.5),
 ('mobile-key-idle', '--terminal-panel-icon-hover', '--terminal-panel-icon-bg-hover', 4.5),
 ('mobile-key-active', '--terminal-panel-icon-hover', '--terminal-panel-handle-bg-hover', 4.5),
 ('mobile-ctrl-armed', '--terminal-bg', '--terminal-panel-icon-hover', 4.5),
 ('toolbar-idle', '--terminal-panel-icon', '--terminal-bg', 4.5),
 ('warning-dismiss-idle', '--terminal-panel-icon', '--terminal-warning-bg', 4.5),
 ('warning-body', '--terminal-warning-fg', '--terminal-warning-bg', 4.5),
 ('warning-secondary', '--terminal-warning-fg-secondary', '--terminal-warning-bg', 4.5),
 ('warning-title', '--terminal-warning-accent', '--terminal-warning-bg', 4.5),
 ('warning-link', '--terminal-warning-link', '--terminal-warning-bg', 4.5),
 ('warning-button-idle', '--terminal-warning-fg', '--terminal-warning-button-bg', 4.5),
 ('warning-button-hover', '--terminal-warning-fg', '--terminal-warning-button-bg-hover', 4.5),
 ('bash-placeholder', '--block-bash-muted-fg', '--block-bash-body-bg', 4.5),
 ('editor-gutter', '--editor-gutter-fg', '--editor-gutter-bg', 4.5),
 ('editor-comment', '--editor-comment', '--editor-bg', 4.5),
 ('editor-selection', '--editor-fg', '--editor-selection-bg', 4.5),
 ('editor-selection-inactive', '--editor-fg', '--editor-selection-bg-soft', 4.5),
 ('editor-current-line', '--editor-fg', '--editor-line-highlight', 4.5),
 ('editor-search', '--editor-fg', '--editor-search-match-bg', 4.5)]
TERMINAL_PAIRS = (
    ("terminal-text", "foreground", "background"),
    ("terminal-selected-text", "selectionForeground", "selectionBackground"),
    ("terminal-inactive-selected-text", "selectionForeground", "selectionInactiveBackground"),
    ("terminal-cursor", "cursorAccent", "cursor"),
)


def luminance(color):
    if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise ValueError(f"expected opaque six-digit hex color, got {color!r}")
    channels = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in channels]
    return sum(v * w for v, w in zip(linear, (.2126, .7152, .0722)))


def ratio(foreground, background):
    low, high = sorted((luminance(foreground), luminance(background)))
    return (high + .05) / (low + .05)


def reject_constant(value):
    raise ValueError(f"nonfinite JSON number: {value}")


def unique_object(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def finite_tree(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("nonfinite JSON number")
    if isinstance(value, dict):
        for item in value.values():
            finite_tree(item)
    elif isinstance(value, list):
        for item in value:
            finite_tree(item)


def check_document(document):
    finite_tree(document)
    if not isinstance(document, dict) or set(document) != {"label", "appearance", "cssVars", "xterm"}:
        raise ValueError("original sources must contain only label, appearance, cssVars, xterm; no assets or executable data")
    if not isinstance(document["label"], str) or not document["label"].strip():
        raise ValueError("missing theme label")
    if document["appearance"] not in ("dark", "light"):
        raise ValueError("invalid appearance")
    for section in ("cssVars", "xterm"):
        if not isinstance(document[section], dict):
            raise ValueError(f"{section} must be an object")
        for color in document[section].values():
            luminance(color)
    rows = []
    for state, foreground, background, minimum in PAIRS:
        actual = ratio(document["cssVars"][foreground], document["cssVars"][background])
        if actual < minimum:
            raise ValueError(f"{state}: {foreground} / {background}: {actual:.6f} < {minimum}")
        rows.append(actual)
    terminal = document["xterm"]
    if luminance(terminal["background"]) >= .03:
        raise ValueError("terminal background must stay dark in every appearance (luminance < 0.03)")
    if luminance(document["cssVars"]["--terminal-bg"]) >= .03:
        raise ValueError("CSS terminal background must stay dark")
    for state, foreground, background in TERMINAL_PAIRS:
        actual = ratio(terminal[foreground], terminal[background])
        if actual < 4.5:
            raise ValueError(f"{state}: {actual:.6f} < 4.5")
        rows.append(actual)
    if len(rows) != 40:
        raise ValueError("contrast inventory drift: expected 40 checks")
    return rows


def check_folder(folder):
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError("theme folder must be a real directory")
    entries = list(folder.iterdir())
    if len(entries) != 1 or entries[0].name != "theme.json":
        raise ValueError("source folder must contain only theme.json")
    source = entries[0]
    mode = source.lstat().st_mode
    if not stat.S_ISREG(mode) or mode & 0o111:
        raise ValueError("theme.json must be a regular non-executable file")
    document = json.loads(source.read_text(), parse_constant=reject_constant, object_pairs_hook=unique_object)
    return check_document(document)


def main():
    root = Path(__file__).resolve().parent.parent
    failures = []
    for name in THEMES:
        try:
            rows = check_folder(root / name)
            print(f"{name}: PASS — {len(rows)} contrast checks; dark terminal")
        except (ValueError, KeyError, TypeError, OSError) as error:
            failures.append(f"{name}: FAIL — {error}")
    for failure in failures:
        print(failure, file=sys.stderr)
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
