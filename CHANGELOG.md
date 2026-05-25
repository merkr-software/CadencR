# Changelog

## v0.3.1 - 2026-05-25

Previous release: v0.3.0 - 2026-05-24

### ✨ Added

- Added editor previews for Markdown, HTML, SVG, and image files so generated docs and visual assets can be inspected without leaving Cadencr.
- Added broader `.env` file visibility in the file tree, file picker, editor, and language handling.
- Added sidebar grouping for features that share the same worktree, making related sessions easier to scan.

### 🔧 Changed

- Improved file-tree navigation by automatically revealing the active editor file.
- Improved live Git diff refresh behavior so changed files and viewed-state collapse stay in sync while work continues.
- Updated the new-session tips list to mention the new editor preview workflow.

### 🐛 Fixed

- Fixed SVG previews to run in a sandbox, while preserving preview zoom and `Cmd+W` / `Ctrl+W` close-buffer behavior.
- Fixed the file-tree agent shortcut so `Cmd+Shift+A` works when the file tree has focus.
- Fixed the Settings About row to use the Cadencr logo consistently.

## v0.3.0 - 2026-05-24

Previous release: v0.2.2 - 2026-05-20

### ✨ Added

- Added an LSP-powered editor workflow with Cmd-click go-to-definition, clickable symbol hints, diagnostics, server status, and an editor settings list for supported language servers.
- Added automatic language-server discovery, managed downloads, crash backoff, idle shutdown, and lifecycle controls so editor intelligence starts and stops with the active workspace.
- Added in-buffer search and replace, go-to-line, editor-scoped shortcuts, Markdown preview, and a free-buffer flow for starting a scratch file and saving it later.
- Added a fully reworked file tree with a new tree engine, better folder interactions, lazy ignored-directory loading, and configurable file icons.
- Added global agent verbosity modes so users can choose how much session detail Cadencr shows while agents work.
- Added One Dark and One Light themes, a global theme drawer, and theme-aware diff rendering.

### 🔧 Changed

- Improved agent session readability with clearer compact tool rows, expandable collapsed work, better stream hints, and more stable scrolling during long runs.
- Made large sessions open faster by deferring non-agent hydration, paginating persisted agent state, and adding database indexes for agent message history.
- Made large workspaces easier to browse by reducing file-tree jank and avoiding eager rendering of ignored directory contents.
- Improved editor polish around active tabs, selection highlights, status indicators, prompt-panel height, and sidebar resizing.
- Made LSP downloads and discovery more reliable by filtering proxy shims, streaming downloads with a User-Agent, and routing server messages to user-visible toasts.

### 🐛 Fixed

- Fixed prompt drafts leaking across conversation switches and cleared stale prompt text when switching away from an uninitialized conversation.
- Fixed inline diff expansion so one file's expanded state no longer affects another file.
- Fixed archive confirmation double-submit behavior so the modal cannot accidentally target the next feature.
- Fixed file-tree folder actions, manual feature rename visibility, active-agent card shadows, and collapsed edit/write rows.
- Fixed editor issues around Cmd+Z immediately after opening a file, stale dirty state when reopening files, active-line selection visibility, and blame refresh after editor mount.
- Fixed merge conflict handling so the merge dialog surfaces conflicts explicitly instead of failing silently.
- Fixed shortcuts-help opening across QWERTY and AZERTY keyboard layouts.

### 🔒 Security

- Added SHA-256 verification for managed LSP downloads before Cadencr runs the downloaded binary.

## v0.2.2 - 2026-05-20

Previous release: v0.2.1 - 2026-05-20

### 🔧 Changed

- Removed the `Cmd+D` editor split shortcuts to avoid conflicts with normal editor selection workflows.

### 🐛 Fixed

- Fixed image-only prompts so provider conversations can start with screenshots or visual context without requiring extra text.
- Fixed multi-file patch rendering so changed files display reliably in patch views.
- Fixed sidebar toggles so editor buffers stay open while resizing or hiding the sidebar.
- Fixed agent session state so working status appears before runtime startup work begins.
- Fixed app visibility restores so existing agents are not reconnected unnecessarily.
- Fixed GitHub Copilot model routing through OpenCode-backed sessions.

### 🔒 Security

- Updated OpenSSL dependencies to include the latest patched `0.10.x` release.

## v0.2.1 - 2026-05-20

Previous release: v0.2.0

### ✨ Added

- Added clearer task tracking in agent sessions, so Claude task updates can appear as structured todos instead of being buried in tool output.

### 🔧 Changed

- Made keyboard shortcuts more reliable across keyboard layouts and prevented native zoom shortcuts from fighting the app's saved zoom preference.
- Made reconnect behavior more aggressive and surfaced offline status more clearly when the local backend disconnects.
- Improved diff navigation by opening changed files at the first edited line and making edit actions less visually heavy.

### 🐛 Fixed

- Fixed prompt drafts leaking between conversations.
- Fixed prompt receipt timing for Codex steering messages and Claude Code steering prompts by using replayed user messages, reducing confusing pending/sent states.
- Fixed landing-page SEO indexing and mobile horizontal scrolling issues.

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
