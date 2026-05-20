# Changelog

## v0.2.0 - 2026-05-18

Previous release: v0.1.3 (df0a9d0038c7869d9b04199d2f78bb5f3dc3ac67)

### Added

- Added archive cleanup controls for safely removing feature worktrees and deleting feature branches, including dirty-worktree and unmerged-branch warnings.
- Added reusable patch diff rendering for inline edit diffs and the Git tab.
- Added Codex steering prompt receipt support and keyboard-layout-aware shortcut handling.

### Changed

- Refined the sidebar and unified agent UI with clearer shortcut badges, portal hover tooltips, persistent row heights, and improved session timing state.
- Persisted project worktree defaults for smoother feature setup.
- Trimmed tool-call paths and Bash commands relative to the working directory for more readable agent output.

### Fixed

- Kept new sessions idle until the first prompt is sent.
- Kept working-directory queries alive for unfocused unified-grid agents.
- Passed response instructions through the OpenCode ACP adapter.

## v0.1.3 - 2026-05-17

Previous release: v0.1.2 (42c9183a091f1e37e5fc40c4dc8d31a6e1977bf9)

### Added

- Added a dedicated download page that recommends the right macOS build when the browser exposes platform details.
- Added direct manual download targets for macOS DMG and ZIP artifacts.

### Changed

- Updated landing page download CTAs to point to the dedicated download page.
- Derived the landing site version and release asset URLs from package metadata.
- Replaced the desktop update notification toast with a sidebar update pill and post-update changelog dialog.

### Fixed

- Fixed GitHub release CTA icon sizing and visual alignment in the recommended download card.
- Kept download asset sizes on one line in the manual target list.
- Themed Sonner toast variants with desktop design tokens.

## v0.1.2 - 2026-05-17

Previous release: v0.1.1

### Added

- Added a release command workflow to prepare changelogs, validate versions, run release preflight checks, and create annotated release tags.
- Added support for changelog-only releases when no landing news article is needed.

### Changed

- Documented the Cloudflare deployment setup for the landing site.
- Published GitHub release notes from the changelog section used for each release.
- Cleaned desktop test output by replacing console error filtering with MSW-based handling.

### Fixed

- Included the session id in the OpenCode resume command.
- Started the agent turn timer correctly when bootstrapping from a paused state.
- Hardened updater installation behavior and CI release workflows.
- Enabled pnpm before setup-node caching in CI.
- Configured Git identity in the workflow harness.
- Avoided Codex runtime requirements in command kind coverage tests.
