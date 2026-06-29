# Changelog

## v0.6.4 - 2026-06-29

Previous release: v0.6.3 - 2026-06-25

### ✨ Added

- [**Desktop**] Added Rewind and Fork actions for persisted user messages, letting users roll a conversation and tracked code back to an earlier turn or branch it into a new feature with provider-backed transcript truncation, pre-turn tracked-code checkpoints, dirty-worktree confirmation, untracked local-file preservation, and a hard abort if code restore cannot be completed before conversation history is changed.
- [**Desktop**] Added Mermaid diagram rendering for markdown across agent surfaces, with strict parsing, streaming-safe source fallback, source/diagram toggles, and a zoom/pan viewer so generated diagrams are readable without destabilizing the conversation.
- [**Desktop**] Added a Session Info action to sync events that were added by continuing the same provider conversation in the CLI, appending only the missing messages to the existing Cadencr conversation.

### 🔧 Changed

- [**provider:claude**] Moved Claude Code profile storage into the JSON settings file so profiles can be inspected and edited programmatically while preserving existing profile APIs, redaction, denied-key validation, and one-time migration from the legacy SQLite table.
- [**Desktop**] Improved the Unified Agents view with an auto-pruned `/exclude` filter, a new `/pin:true` filter, a collapsible filter input, and tighter toolbar sizing.
- [**Desktop**] Changed terminal and agent-chat link handling so `Cmd`/`Ctrl` click routes internal domains such as localhost into the scoped Cadencr browser tab, external links open in the system browser, and right-click menus offer both open targets plus copy.
- [**Desktop**] Changed feature sidebar menus with a control to close a feature's live terminals and browser tabs without opening it, including bulk browser-tab cleanup and terminal teardown that avoids re-adopting killed shells.
- [**Desktop**] Changed Git diff layout selection into a persistent preference so Unified/Split mode stays in sync between the Git tab and Settings across sessions and projects.

### 🐛 Fixed

- [**provider:claude**] Fixed session profile persistence so changing the global Claude profile only affects new sessions instead of mutating the profile used by existing conversations.
- [**Desktop**] Fixed remote/mobile reconnect storms by backing off WebSocket retries after rate limits, honoring `Retry-After`, and batching editor settings reads that previously amplified reconnect traffic.
- [**Desktop**] Fixed the Git graph crash reported in #88 by always passing Virtuoso a valid components object after the last commit page loads.
- [**Desktop**] Fixed stale sidebar agent counts by sourcing the working-agent indicator from live WebSocket session state and showing an active dot while agents are running.
- [**Desktop**] Fixed Frost theme popovers that could be clipped or displaced by backdrop-filter containers, including context-menu submenus and Git graph commit hover cards.
- [**Desktop**] Fixed fullscreen mobile sidebar gaps by moving safe-area padding onto the sidebar surface so it reaches the screen edges while keeping controls clear of the notch and home indicator.

## v0.6.3 - 2026-06-25

Previous release: v0.6.2 - 2026-06-23

### 🐛 Fixed

- [**provider:claude**] Fixed Claude Code sessions that could stop silently after resuming a completed background session, after CLI schema drift, or after a mid-turn stream close by preserving known text/tool blocks, surfacing CLI stderr, provider errors, and unknown messages inline, refreshing stale resume IDs before spawn, and recognizing Claude rate-limit telemetry without showing it as an unknown message.
- [**provider:claude**] Fixed prompt-area Claude profile selection so new conversations keep the selected/default profile, model lists refresh when switching between Anthropic and Bedrock profiles, and the selector stays synchronized across conversations.
- [**provider:codex**] Fixed Codex compaction recovery when the app server reports a different active turn ID, retrying steering with the active turn instead of leaving the conversation idle while the original stream continues.
- [**Backend**] Fixed worktree Git setup for GUI-launched sessions by preserving the login-shell `PATH`, tolerating shell startup noise, and waiting longer for shell initialization so Git LFS and other user-installed helpers remain available.
- [**Desktop**] Fixed deleting or archiving a fresh conversation so stale chat routes close immediately, archived conversations are not reopened from the home route, and failed deletion of a running session does not drop live backend handles.
- [**Desktop**] Fixed Settings navigation highlighting after clicks and scrolls, including short sections and off-the-fold targets that previously selected the wrong section.
- [**Desktop**] Fixed global sidebar resizing by enforcing a usable minimum width and clamping saved sidebar widths that were already too narrow.

## v0.6.2 - 2026-06-23

Previous release: v0.6.1 - 2026-06-22

### 🔧 Changed

- [**Desktop**] Improved large-conversation opening performance by loading a smaller initial agent stream window, backfilling older history only as needed, staggering non-agent tab hydration, parsing large diffs off the main thread, and auto-collapsing very large changed files in the Git tab.

### 🐛 Fixed

- [**Desktop**] Fixed startup dead-ends by detecting databases that were already opened by a newer Cadencr version before applying migrations, showing clear splash-screen recovery actions, supporting pre-migration backup restore, and smoke-testing the packaged service sidecar in the release workflow.
- [**Desktop**] Fixed production white screens by capturing renderer crashes and unhandled React errors in local diagnostics, showing copyable error details, and offering a UI reload path while background agents can keep running.
- [**Desktop**] Fixed Git diff readability by using the same file header for collapsed and expanded rows, matching status icons and count colors consistently, and keeping Edit/Write inline diffs in the green file-change style after they load.
- [**github_actions**] Fixed Homebrew cask publishing by testing the release cask update script before building assets and hardening its tap update flow so Homebrew installs can be updated reliably after a release.

### 🔒 Security

- [**dependencies**] Updated release, desktop, landing, and backend dependencies, including Vite/Astro hardening for development tooling and landing builds, SQLx, sha2, serde_json, CodeQL Action, and actions/checkout.

## v0.6.1 - 2026-06-22

Previous release: v0.6.0 - 2026-06-22

### 🐛 Fixed

- [**Desktop**] Fixed the macOS packaged app failing to start the bundled service on machines without Homebrew OpenSSL installed by building the service sidecar with vendored OpenSSL and adding a release guard that rejects Homebrew-linked sidecars before assets are published.
- [**Backend**] Fixed MCP-spawned sessions so an explicitly requested provider is preserved during model validation instead of being overridden by model-based auto-routing.
- [**Backend**] Fixed formatter execution when a formatter exits before reading stdin, returning a user-visible formatting error instead of surfacing an internal broken-pipe failure.

## v0.6.0 - 2026-06-22

Previous release: v0.5.1 - 2026-06-16

### ✨ Added

- [**Desktop**] Added Cadencr-owned project and workspace MCP orchestration, surfaced in Settings and available to agent sessions, so agents can inspect workspace activity, list and search projects, tail and compare conversation context, and safely **message or spawn scoped sessions** without leaving the active Cadencr workspace.
- [**Backend**] Added **JSON-backed global and project settings** for **programmatic configuration changes**, while preserving the existing settings APIs, validation, migration path, and user-visible errors for malformed or unsupported settings.
- [**Desktop**] Added a much more capable editor workspace with **large-file read-only mode**, **hybrid lazy file-tree loading**, git gutter markers, **LSP diagnostics and status**, symbol navigation, references, rename, workspace symbols, formatting, and multi-server language tooling for TypeScript, linters, and formatters.
- [**Desktop**] Added **scheduled conversation prompts** with a prompt-bar split button, date/time picker, scheduled-message cards, and backend scheduling, so follow-up work can be queued for a conversation instead of kept in a separate reminder.
- [**Desktop**] Added **in-conversation search** with `Cmd+F` / `Ctrl+F`, highlighted matches, match navigation, `Enter` / `Shift+Enter`, and `Escape`, making long agent runs easier to search like an IDE or browser page.
- [**Desktop**] Added a global **Pinned conversations** section above the project list, with persisted pin state, so important or long-running conversations stay reachable without scrolling through chronological history.
- [**Desktop**] Added remote Web Push notifications for paired browser/PWA clients, so remote Cadencr sessions can notify the user when agent work finishes.
- [**provider:claude**] Added per-session Claude profile selection before the first prompt and during a conversation, with profile overrides applied when prompts are dispatched.
- [**Desktop**] Added Carbon Owl and Paper Owl square themes, plus a distinct file-patch tool-call color in the agent stream.

### 🔧 Changed

- [**Desktop**] Refreshed first-turn session tips and the landing documentation around recent workspace, browser, editor, settings, shortcut, and prompting workflows.

### 🐛 Fixed

- [**provider:claude**] Fixed Claude worktree sessions for subfolder projects by preserving root-level Claude configuration, skills, commands, rules, and MCP settings inside generated worktrees, so skills available before entering a worktree remain available afterward.
- [**Backend**] Fixed worktree session reliability by preventing new worktree sessions from reusing the project's main working tree, replaying persisted setup output, and making MCP-spawned worktree sessions start consistently.
- [**provider:claude**] Fixed conversation status while Claude background agents are still running, so the session stays visibly active instead of showing completed work too early.
- [**Desktop**] Fixed compaction feedback by showing in-progress compacting status and cursor state across providers while compaction is running.
- [**Desktop**] Fixed branch-switch truthfulness for worktree-backed projects by surfacing that the switch is deferred until the first message instead of implying the underlying worktree branch changed immediately.
- [**provider:codex**] Fixed Codex permission-mode propagation and live permission-mode handling so spawned sessions and running conversations keep the requested access behavior.
- [**provider:opencode**] Fixed OpenCode thinking-effort handling by clearing unsupported effort values when the selected model cannot use them.
- [**Backend**] Fixed incompatible-model session startup by clearing unsupported thinking-effort settings and recognizing dynamic per-model effort keys plus remote-access settings.
- [**provider:claude**] Fixed Claude API errors and pending steering prompts so provider error messages are surfaced and turn-boundary prompts no longer leave conversations stuck pending.
- [**Desktop**] Fixed editor and shell polish around fresh-file `Cmd+Click`, hover sizing, Frost theme worktree visibility, worktree setup badges, and route/highlight build warnings.

## v0.5.1 - 2026-06-16

Previous release: v0.5.0 - 2026-06-14

### ✨ Added

- [**Desktop**] Added an explicit branch/worktree mode selector before the first prompt, so users can choose whether an agent runs on the selected branch or a new branch, and whether it uses the project folder or a dedicated worktree.
- [**Desktop**] Added Browser reload and page-zoom shortcuts, with per-tab page zoom that does not resize the rest of the desktop app.
- [**Desktop**] Added an editor Copy Path action, available from the file tree and active editor with `Cmd+Shift+C` / `Ctrl+Shift+C`, for copying the project-relative file path.
- [**Desktop**] Added a Kill terminals cleanup option to archive and delete dialogs, including a `T` shortcut and live terminal count, so feature cleanup can stop lingering shells.
- [**Desktop**] Added sidebar unread dots when an agent finishes while its conversation is not open, and clears them as soon as the conversation is viewed.

### 🔧 Changed

- [**Backend**] New “from branch” sessions now create their branch after the first prompt names the feature, so generated branch names match the feature title instead of a placeholder.

### 🐛 Fixed

- [**Desktop**] Fixed Browser feature-pane shortcuts so they work while the embedded web page has keyboard focus, including focus handoff that prevents macOS error beeps after leaving the Browser pane.
- [**Desktop**] Fixed “Agent finished” notifications so they are suppressed for the conversation currently open in the hash-routed desktop app.
- [**Backend**] Fixed branch setup failures so the prompt is aborted with a visible branch setup error instead of silently running on the wrong branch.

## v0.5.0 - 2026-06-14

Previous release: v0.4.1 - 2026-06-10

### ✨ Added

- [**Desktop**] Added an embedded Browser workspace tab with per-feature tabs, an address bar, normal/private browsing modes, comments, keyboard shortcuts, permission-gated local-file and external-URL opens, and the `cadencr-browser` MCP tools agents need to test web work in-place: outline snapshots with element refs, scoped HTML snapshots, partial page screenshots, console and network inspection, waits, clicks, fills, hovers, keypresses, JavaScript evaluation, and user-selected element context.
- [**Desktop**] Added a Git graph view with commit rows, changed-file diffs, and online commit links to make branch history easier to inspect from the Git tab.
- [**Desktop**] Added Frost Dark and Frost Light glass themes with matching editor, diff, terminal, modal, and popover styling.
- [**Desktop**] Added sidebar activity indicators for busy feature surfaces so active work is easier to spot.

### 🔧 Changed

- [**Desktop**] Replaced the file-tree worktree header with a file-search trigger so opening files from the editor area takes fewer clicks.
- [**Desktop**] Switched the Cadencr wordmark to Figtree 800 across the splash screen, sidebar, and onboarding for more consistent branding.
- [**Desktop**] Tuned Frost vibrancy, split-tab glass, modal scrims, overlays, popovers, and ambient halo animation, including throttling the halo while idle to reduce GPU use.

### 🐛 Fixed

- [**provider:claude**] Fixed queued Claude Code prompts and interrupted turns so prompts are acknowledged on the next response and interrupted turns wait for completion instead of leaving stale state behind.
- [**Desktop**] Fixed pending steering prompts so they no longer keep turns active after the pending state has cleared.
- [**Desktop**] Fixed sent prompt drafts so submitted text does not reappear in the input.
- [**Desktop**] Fixed AskUserQuestion free-text handling so number keys no longer select options while typing in the “Other” field and focus resets correctly between questions.
- [**Desktop**] Fixed dropdown submenus that were clipped by parent overflow by rendering them through a portal.
- [**Desktop**] Fixed Git diff navigation so selecting a changed file reliably scrolls to that file.
- [**Desktop**] Fixed Frost theme readability and blur behavior in packaged builds, including modal readability when `backdrop-filter` is unavailable and blurred Git graph hover cards.

## v0.4.1 - 2026-06-10

Previous release: v0.4.0 - 2026-06-07

### 🔧 Changed

- [**Desktop**] Improved prompt attachments so uploaded files are prepared per provider, making mixed text, image, and file prompts more consistent across agents.
- [**Backend**] Let custom actions run in a terminal split, so command output remains visible and recoverable instead of being limited to the action detail panel.
- [**Desktop**] Improved mobile workspace ergonomics with per-device zoom, a unified code font, touch-friendly diff controls, and safer prompt focus behavior when opening conversations.
- [**Backend**] Split websocket session protocol payloads into focused modules to keep live-session handling easier to maintain without changing the user workflow.

### 🐛 Fixed

- [**provider:codex**] Fixed PDF prompt attachments so Codex receives them as file references instead of unsupported inline content.
- [**provider:claude**] Fixed Claude Code context-usage bars so they scale against the session's real context window instead of the default 200k-token window.
- [**Desktop**] Fixed reused worktree branch selection so a manually chosen branch is preserved while project settings finish loading.
- [**Desktop**] Fixed custom-action recovery so runs that were active before restart no longer remain stuck.

## v0.4.0 - 2026-06-07

Previous release: v0.3.6 - 2026-06-03

### ✨ Added

- [**Desktop**] Added remote env: pair a phone, tablet, or second computer by QR code or link, then control the same local Cadencr workspace from the browser. Remote env includes host sidebar controls, pairing gate, trusted-device flow, installable PWA metadata/icons, mobile shell, mobile editor and terminal layouts, terminal key bar, live connected-device feedback, sleep-prevention controls, and connection fixes for multi-device, sleep/wake, re-pairing, stream model labels, and bidirectional session controls. On the backend it adds the remote listener, device-token authentication, pairing codes, TLS support, LAN/tunnel connection details, persisted remote devices, remote session mirroring, authenticated shared access to sessions, terminals, and LSP routes, plus loopback-only host controls, bearer-token checks, rate limiting, security headers, cache controls, and safer remote file handling.
- [**Desktop**] Added Monokai and Monokai Light themes.
- [**Desktop**] Added a feature unarchive action so archived work can be restored from the app.

### 🔧 Changed

- [**Desktop**] Reworked sidebar ordering so conversations float to the top after user messages while project order remains stable within a session.
- [**Backend**] Removed the 300-second custom-action timeout so long-running commands can continue until they finish or are cancelled.

### 🐛 Fixed

- [**Desktop**] Fixed terminal clear shortcuts so the terminal can be cleared reliably from the keyboard.

## v0.3.6 - 2026-06-03

Previous release: v0.3.5 - 2026-06-03

### ✨ Added

- [**Desktop**] Added a unified-agents "New session" button with project selection and `Cmd+Shift+N` / `Ctrl+Shift+N`, so new conversations can start directly from the agents view.
- [**Desktop**] Added `/exclude` filtering and per-agent hide controls to the unified agents view, making it easier to focus on the sessions that matter.
- [**Desktop**] Added command-palette and sidebar search shortcuts, plus a faster keyboard path for hiding and pinning agents.
- [**Backend**] Added session MCP server status support for OpenCode, Claude Code, and Codex so connected MCP servers can be surfaced while conversations run.

### 🔧 Changed

- [**Desktop**] Refined unified-agent filtering, filter help, card state, and sidebar links around hidden and excluded sessions.

### 🐛 Fixed

- [**Desktop**] Fixed session and query refresh behavior around shortcut-driven agent actions so UI state stays current after keyboard commands.
- [**provider:opencode**] Flattened OpenCode ACP tool results before display so tool output renders consistently in session streams.

### 🔒 Security

- [**provider:opencode**] Stopped logging raw OpenCode MCP discovery output so local MCP configuration details are not exposed in debug logs.

## v0.3.5 - 2026-06-03

Previous release: v0.3.4 - 2026-06-02

### ✨ Added

- [**Desktop**] Added a redesigned Settings page with grouped cards, clearer section headings, and more consistent controls for providers, themes, notifications, file icons, LSP servers, and permission modes.

### 🔧 Changed

- [**Desktop**] Kept gitignored files and folders visible in the editor file tree as dimmed entries, so ignored project files can still be opened without losing their status context.

### 🐛 Fixed

- [**Desktop**] Fixed empty-session cleanup so conversations without useful session content are deleted instead of being archived as clutter.
- [**provider:claude**] Fixed Claude Code model discovery so changing the active profile refreshes the model list immediately.
- [**provider:claude**] Fixed Claude sessions stuck in `bypassPermissions` so they can recover when the stored permission mode no longer matches the available launch capability.
- [**provider:codex**] Fixed Codex and ACP steering prompts after stop/resume so pending prompts are replayed and receipt state stays accurate.
- [**provider:codex**] Fixed Codex permission-mode persistence across session re-seeding so conversations keep the requested access mode.

### 🔒 Security

- [**dependencies**] Updated reviewed npm dependency overrides and lockfile entries for vulnerable transitive packages.

## v0.3.4 - 2026-06-02

Previous release: v0.3.3 - 2026-06-01

### 🔧 Changed

- [**Backend**] Ran provider CLI launches, worktree setup commands, and custom actions through a non-interactive login shell so user-installed tools are found without triggering zsh prompt/plugin startup errors.

### 🐛 Fixed

- [**Desktop**] Fixed websocket-backed sessions on feature pages so live agent status follows backend updates and prompt drafts stay cleared after sending.

### 🔒 Security

- [**Backend**] Restricted agent-requested ACP terminal commands to a small safe environment so provider-selected commands do not inherit user secrets unless they are explicitly passed through ACP environment variables.

## v0.3.3 - 2026-06-01

Previous release: v0.3.2 - 2026-05-27

### ✨ Added

- [**Desktop**] Added conversation imports for existing Claude Code, Codex CLI, and OpenCode sessions so prior agent work can be brought into a project as Cadencr features with provider and model context preserved.

### 🔧 Changed

- [**Desktop**] Reworked custom actions so the header shows up to four actions inline, inline and overflow actions share the same live output/details surface, and long-running manual runs remain visible and cancellable after menus close.
- [**Desktop**] Made archive cleanup safer by disabling destructive cleanup choices that would target the default branch or the main worktree.
- [**provider:claude**] Kept Claude bypass available as an explicit permission mode in the selector and Shift+Tab cycle while separating it from the underlying launch capability.

### 🐛 Fixed

- [**provider:claude**] Fixed Claude Code model handling on Anthropic, Bedrock, and Vertex by applying profile env to model discovery, preserving Claude Code's default system prompt, and resolving stored aliases to the active catalog model at launch.
- [**provider:claude**] Fixed Claude bypass reliability so sessions spawned without the capability can rearm before the next prompt and resume in the requested bypass mode.
- [**Desktop**] Fixed prompt drafts so they stay scoped to the feature instead of leaking or restoring across conversation switches.
- [**Desktop**] Fixed the sidebar label editor so rename opens reliably after the context menu closes.
- [**Desktop**] Fixed the Terminal tab so closing the last pane immediately starts a fresh focused terminal instead of leaving a blank panel.

### 🔒 Security

- [**Backend**] Hardened managed npm language-server installs by keeping lifecycle scripts disabled, requiring packages to be at least 14 days old, and enabling stricter pnpm trust controls.
- [**provider:claude**] Constrained Claude Code import session IDs to safe file names before loading local transcript files.

## v0.3.2 - 2026-05-27

Previous release: v0.3.1 - 2026-05-25

### ✨ Added

- [**provider:codex**] Added Codex access modes for new Codex conversations: Default, Full Access, and Auto Review, with the active access mode visible from the session meta bar and configurable in Settings.
- [**provider:codex**] Added per-session Codex access-mode persistence so existing conversations keep the mode they started with while new conversations use the current default.
- [**Desktop**] Added clipboard image paste support in the agent prompt so screenshots can be attached without drag-and-drop.

### 🔧 Changed

- [**Desktop**] Improved image prompt attachments by routing dropped images to the correct prompt and highlighting prompt cards while dragging.
- [**Backend**] Improved compact and resume handling so agent sessions recover pending compact state more reliably across backend and frontend lifecycle transitions.
- [**Backend**] Improved macOS SSH agent handling so terminals and Codex sessions preserve or recover `SSH_AUTH_SOCK` when Cadencr is launched from the GUI.

### 🐛 Fixed

- [**provider:codex**] Fixed Codex permission response timeouts so approvals and denials do not leave prompts stuck waiting.
- [**provider:claude**] Fixed a Claude Code bypass-permission issue where a rejected `bypassPermissions` switch could be handled like an `auto` compatibility fallback, leaving future prompts aligned to a rejected mode.
- [**Desktop**] Fixed a first-prompt permission-mode race so the mode selected before sending the first prompt is applied when the agent starts.
- [**Backend**] Fixed Git workflow operations so status, checkout, commit, and push actions avoid background lock conflicts.
- [**provider:claude**] Fixed Claude sub-agent close detection so closed sub-agent windows are classified correctly.

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
