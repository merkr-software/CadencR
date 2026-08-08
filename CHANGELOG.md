# Changelog

## v0.10.0 - 2026-08-02

Previous release: v0.9.1 - 2026-07-30

### ✨ Added

- [**Desktop**] Added durable Usage Stats with provider-native token totals that survive conversation archival or deletion, import the previous 30 days from local Claude, Codex, and OpenCode histories, break activity down by provider, model, and thinking effort, and warn visibly if shutdown or recording failures may have left totals incomplete.
- [**Desktop**] Replaced one-shot scheduled messages with recurring schedules that run once, at intervals, daily, weekly, or monthly in the user's timezone; schedules can post into an existing conversation or start a new conversation with its own worktree behavior, and use the full prompt composer with file and conversation references, commands, skills, model, thinking, mode, access, and profile controls. Existing undelivered scheduled messages carry over, including overdue messages that were still pending.
- [**provider:codex**] Added a persistent Fast mode control beside the session's model and thinking controls, using Codex priority service tier when supported and switching safely for new, resumed, compacted, and already-running conversations.
- [**Desktop**] Added a prompt-time action and keyboard shortcut to reuse the live worktree from an `@@`-referenced conversation, so follow-up work can continue on that conversation's branch without manually locating or recreating its checkout.
- [**Desktop**] Added explicit Plain, Force with lease, and Force push modes with the exact Git command shown before execution, keyboard submission, live output, and the ability to send a running push to the background and reopen it later.
- [**Desktop**] Added live port badges to sidebar conversations, attributing listening servers started by a conversation's terminal, active agent, or worktree so running previews can be found without searching transcripts or processes.
- [**Desktop**] Added a full-screen prompt-image viewer with zoom, pan, copy, save, and keyboard navigation, while keeping unsent image attachments when switching conversations and restoring them when returning to the draft.

### 🔧 Changed

- [**Desktop**] Made long, streaming conversations substantially lighter by parsing only the active Markdown block, bounding oversized message and tool payloads without breaking their structured data, and letting the browser skip off-screen diff painting while preserving measured row heights.
- [**Desktop**] Redesigned Task and Agent sub-agent activity as a compact timeline with scannable action rows, expandable reasoning and output, and full-history detail when opened.

### 🐛 Fixed

- [**Desktop**] Fixed prompt screenshots appearing as truncated walls of base64 instead of images, including live-send, reload, reconciliation, and retry paths; retries now fail visibly rather than silently dropping an attachment that is no longer available.
- [**Desktop**] Fixed stash selections showing no changes, stashes with untracked files appearing empty, merge and root commits reporting incorrect file lists, and untracked files lacking added-line counts in Changes and commit or stash dialogs.
- [**provider:opencode**] Fixed Task sub-agents disappearing after OpenCode changed their ACP tool kind, while handling the new task output envelope and tightening child-session pairing so parallel sub-agents remain attached to the correct action.
- [**Desktop**] Fixed running conversations on mobile repeatedly surfacing React nested-update errors during heavy agent streaming.
- [**Desktop**] Fixed archive-cleanup shortcuts conflicting with Git-tab bindings, and made branch deletion validate the feature's actual target before removing a branch.
- [**Desktop**] Fixed Git view-mode labels clipping their descenders and kept the file-list toggle visible but disabled, with an explanatory label and tooltip, in views where the toggle does not apply.
- [**Desktop**] Fixed the transcript-to-composer boundary showing a visible seam in translucent themes and short conversations losing auto-scroll behavior near the composer.

### 🔒 Security

- [**dependencies**] Updated Astro, Sharp, PostCSS, and affected transitive packages to patched releases, completed the Astro 7 compatibility migration, and tightened pnpm overrides so security pins stay confined to compatible package lines and the one affected consumer.

## v0.9.1 - 2026-07-30

Previous release: v0.9.0 - 2026-07-28

### 🐛 Fixed

- [**Desktop**] Fixed renderer crashes and repeated reconnect waves during long, tool-heavy conversations by deferring off-screen diff rendering, showing oversized inline diffs without expensive highlighting, preserving reconnect backoff, releasing abandoned session transports, and making overloaded WebSocket clients wait and retry cleanly instead of entering a reconnect storm.
- [**Desktop**] Fixed images in GitHub and GitLab pull-request descriptions and review comments failing to load, including images from private repositories, while bounding automatic and off-screen image work, keeping forge credentials on the exact connected origin, blocking local-network proxy targets, and aligning each review-thread selection control with its first comment’s author details.

## v0.9.0 - 2026-07-28

Previous release: v0.8.1 - 2026-07-24

### ✨ Added

- [**Desktop**] Added a provider-neutral pull-request and merge-request workflow for GitHub and GitLab: connect remotes from Git settings, see proposal and check health from the sidebar and rebuilt Git tab, inspect unresolved review threads and inline annotations, navigate them by file or keyboard, select individual or all comments, and send the resulting review context directly to an agent. The shipped workflow also handles missing forge setup, GitHub throttling, custom GitLab CLI authentication, unresolved-thread counts, branch-backed conversations whose worktree has been removed, host-bound HTTPS credential transport, and complete revocation of stored or CLI-derived access.
- [**Backend**] Added cross-project worker follow-ups so an orchestrator can send additional instructions to an existing spawned session instead of replacing it with a new worker, while preserving reactive gates and replies.

### 🐛 Fixed

- [**Desktop**] Fixed Cursor access-mode changes appearing in the UI without changing the running session; Default and Auto Review now take effect on the next permission request, while transitions that alter sandbox launch flags restart safely.
- [**Backend**] Fixed spawned sessions losing their requested thinking effort during initialization, and kept followed child-completion output owned by the child so parent conversations ask how to proceed instead of rewriting the result.
- [**Desktop**] Fixed model pickers showing a provider, model, and agent-mode combination that did not match the backend-confirmed session selection.
- [**provider:claude**] Fixed Claude context usage being scaled against a stale or incorrect window, especially for native one-million-token models such as Fable; the running model's reported window is now learned and applied earlier, and unknown windows hide the meter instead of displaying a misleading percentage.
- [**Desktop**] Fixed running conversations on iOS entering a scroll feedback loop or repeatedly re-pinning the bottom; remote sessions also have more request headroom, and unrelated fetch counters no longer re-render the entire app.
- [**Desktop**] Fixed Git history, graphs, and diffs falling back to `HEAD` after a feature branch had already been resolved, including conversations whose worktree was removed but whose branch remains available.
- [**Desktop**] Fixed newly created directories appearing as single untracked folder entries in Changes instead of expanding to the files users can inspect, stage, and review.
- [**Desktop**] Fixed grouped sidebar conversations blending into light and dark themes, unchecked controls losing their visible edge in dark themes, and restored pane focus opening tooltips without user intent.
- [**Desktop**] Fixed cramped Git connection settings, oversized project-tooling controls, shifting Git toolbar actions, low-contrast Session Info buttons, and Claude profile labels that could confuse the session override with the globally active profile.

### 🔒 Security

- [**Backend**] Hardened local and remote service boundaries by removing the service authentication token from spawned shells and Git processes, blocking final-component symlink and race-prone file mutations, enforcing project and feature ownership for editor, terminal, and file-watcher access, bounding and rate-limiting WebSocket transport, using constant-time token checks, restricting secret storage permissions, and preventing internal errors or migration paths from exposing sensitive details.
- [**dependencies**] Updated Rust networking, TLS, async-runtime and file-walking libraries plus GitHub Actions and frontend build tooling, with compatibility guards for the supported Electron Vite bundle.

## v0.8.1 - 2026-07-24

Previous release: v0.8.0 - 2026-07-23

### 🐛 Fixed

- [**Desktop**] Fixed Git change-tree stage and unstage controls flickering, disappearing, or resetting tree state during refreshes and long-list scrolling; per-file loaders now remain visible until backend Git state confirms each checkbox transition.
- [**Desktop**] Fixed root conversation provider icons being offset when some sessions had children, while keeping nested rows and their hover targets full width and expressing hierarchy through consistent internal indentation.
- [**provider:opencode**] Fixed OpenCode provider icons appearing as a solid block in the sidebar or a squashed pale rectangle in model selectors by replacing the broken assets with theme-readable versions of the official logomark.
- [**provider:codex**] Fixed high-resolution image results crashing Codex conversations when app-server frames exceeded the previous transport limit; image-sized payloads now remain bounded but supported, and genuine transport failures are reported accurately instead of being misidentified as process exits.

## v0.8.0 - 2026-07-23

Previous release: v0.7.2 - 2026-07-17

### ✨ Added

- [**Desktop**] Added a keyboard-first Git changes workflow with an easier file tree, flat and tree views, conflicts shown first, viewed progress, nearby unified/split controls, open-in-Editor actions, and per-file stage and unstage controls that protect unsaved and unresolved work.
- [**Desktop**] Added complete stash controls to create named stashes with optional untracked files and to apply, pop, or drop existing stashes, with destructive confirmation, visible progress and errors, and direct conflict handoff back to the working changes.
- [**Desktop**] Added branch Update controls that show the incoming branch and ahead/behind counts, offer merge or rebase, and keep conflicts recoverable; conflicted files can be opened in the Editor to accept the current side, incoming side, or both before continuing or aborting the update.
- [**Desktop**] Added provider, model, and thinking-effort badges to sidebar conversations plus popovers for answering pending permission and question gates without opening the conversation, including command previews and suppression of redundant prompts for the active conversation.
- [**Desktop**] Added project logo selection to onboarding and Project Settings by ranking tracked repository images into a thumbnail grid, with a native file picker for external images and automatic fallback to the project color when an icon is unavailable.
- [**Desktop**] Added provider-aware model favorites to every model picker, with starred models grouped above the catalog, shared workspace persistence, search compatibility, and a rebindable `Cmd`/`Ctrl+S` shortcut while a picker is open.
- [**Desktop**] Added token-usage details to the conversation context bar on hover or keyboard focus, including total, input, and output tokens plus whether the context has been compacted.
- [**Desktop**] Added initial support for the Cursor agent with model and effort selection, collaboration and access modes, attachments, resumable conversations, plans, permissions, and Auto Review. The current Cursor ACP integration does not report context usage, omits details from some tools such as the file path for Read, does not expose a question tool, and provides limited sub-agent information; CadencR will surface more as Cursor makes it available through ACP.

### 🔧 Changed

- [**Desktop**] Introduced the Emerald Reserve visual identity and new CadencR Dark and CadencR Light themes across the desktop app, splash screen, generated icons, tool accents, and marketing site, with softer surfaces, clearer sidebar and app chrome, refreshed product captures, and consistent brand assets generated from one source.

### 🐛 Fixed

- [**Backend**] Fixed new worktrees forgetting the branch they were created from and later comparing or merging against `main`; the selected source branch now stays attached to the worktree.
- [**Desktop**] Fixed mobile conversation layouts by keeping the composer and Send control visible above short or first-opened software keyboards, limiting desktop-only chassis styling to desktop widths, and adding reliable edge-swipe open and swipe-close gestures for the sidebar.
- [**Desktop**] Fixed the slash-command and skill picker being cropped by the prompt composer, preserving the editor width while clamping the menu to the available space above the prompt.
- [**Desktop**] Fixed unchecked checkboxes and switches having near-invisible borders in light themes, with clearer control edges and keyboard-focus rings while preserving dark-theme styling.
- [**Desktop**] Fixed split-pane close controls overlapping tab labels or disappearing until hover in the CadencR themes.
- [**Desktop**] Fixed intrusive browser-native hover text appearing over Bash and file-change tool rows.

## v0.7.2 - 2026-07-17

Previous release: v0.7.1 - 2026-07-15

### ✨ Added

- [**Desktop**] Added leading-`!` shell commands to the prompt composer for Claude, Codex, and OpenCode sessions, with a dedicated shell mode, streamed and persisted output, worktree-aware local execution where needed, provider-native execution when supported, cancellation and restart recovery, and command results carried into subsequent conversation context.
- [**Backend**] Added push-based agent orchestration so spawned or messaged sessions can deliver permission, plan, and question gates plus completed results directly into the parent’s active turn, with explicit queue and reject modes, interruption-safe follow-ups, and durable delivery claims and UUIDs that recover replies across interruptions and restarts without duplicating stored messages.

### 🐛 Fixed

- [**provider:claude**] Fixed custom Claude proxy models and MCP-spawned sessions being routed or validated against the wrong provider or profile when a model ID resembled another provider’s naming scheme; selected provider ownership, exact catalog ownership, and the chosen Claude profile now stay aligned through model selection, spawn, and runtime reconstruction.

## v0.7.1 - 2026-07-15

Previous release: v0.7.0 - 2026-07-14

### ✨ Added

- [**Desktop**] Added a searchable Branches view to the Git tab for local and remote branches, with current-branch and attached-worktree context, branch-scoped commit graphs, and commit diffs that can be inspected without checking out the branch.
- [**Desktop**] Added persistent editor language modes that can be selected for one file or every file with the same extension, keeping syntax highlighting and language tooling aligned when automatic detection is not enough.
- [**Desktop**] Added rich copy actions across conversations and rendered previews, including plain text, Markdown, Slack mrkdwn, and email-safe formatted HTML for either a selection or a complete message block.

### 🔧 Changed

- [**Desktop**] Made dense workspace navigation easier to scan with tighter nested-conversation spacing and a bounded, searchable, virtualized MCP server list in Session Info.

### 🐛 Fixed

- [**Backend**] Fixed stale or partially removed worktrees leaving conversations stuck on phantom setup state by distinguishing live registrations from residual folders, recovering safely when worktrees or branches are already gone, and reporting partial archive-cleanup failures without discarding successful cleanup steps.
- [**Backend**] Fixed Cadencr orchestration skills failing with some MCP clients by advertising a client-compatible spawn schema, requiring the actual spawn and link capabilities before reporting the project server ready, and making handoff linking explicit after a successful spawn.
- [**Desktop**] Fixed provider command syntax in the prompt composer so Claude slash commands can appear mid-prompt, Codex skill references use `$`, and OpenCode slash commands remain anchored to the prompt start.
- [**Desktop**] Fixed the Cadencr brand header overlapping macOS window controls in both expanded and collapsed sidebar layouts without adding unused space in browser or non-macOS sessions.

## v0.7.0 - 2026-07-14

Previous release: v0.6.7 - 2026-07-09

### ✨ Added

- [**Desktop**] Added cross-conversation prompt references: type `@@` in the composer to search conversations across registered projects, insert a clickable reference, and have the agent load the selected history as scoped context through the workspace MCP.
- [**Desktop**] Added provider-neutral `/cadencr:*` orchestration skills for review, rescue, status, parallel work, and handoff, surfaced in both `/` and `$` composer menus and expanded only when sent so repositories stay untouched.
- [**Desktop**] Added an agent-session hierarchy to the project sidebar, with linked parent/child gate and reply events, actionable child permission and question summaries, and source-conversation links on generated messages so delegated work stays traceable.
- [**Backend**] Added explicit cross-project spawning through `project_spawn_session`, including target-project provider/model defaults, target-aware thinking levels, provenance checks, and safe dispatch-error reporting that avoids duplicate retries.
- [**Desktop**] Added an opt-in Summary conversation mode that folds each completed turn into an expandable tool recap and final answer, with per-tool counts, attributed colors, Git numstat, and a footer collapse control for long expanded turns.
- [**Desktop**] Added richer first-run onboarding with preferences, runtime and auto-name model selection, a welcome step, and a dismissible per-project setup dialog for accent color and worktree defaults.
- [**Desktop**] Added sanitized inline and block HTML rendering to Markdown surfaces, plus repo-relative image resolution in editor Markdown previews with visible loading and error states.
- [**Desktop**] Added Catppuccin Mocha and Latte themes across the workspace, terminal, and Git diff viewer.
- [**Desktop**] Added background commit execution with live progress, workspace access while pre-commit hooks run, and preserved actionable output when a commit fails.

### 🔧 Changed

- [**provider:codex**] Improved Codex conversations with server-advertised reasoning levels such as Ultra, detailed multi-part thinking summaries, complete WebSearch and WebFetch details, and correct nesting for new and resumed sub-agent streams.
- [**provider:claude**] Let custom Claude proxy models declare their supported thinking levels so existing effort controls work without provider-specific hardcoding.
- [**Desktop**] Cleaned up tool-call presentation across providers by normalizing MCP calls, hiding internal runtime plumbing, presenting skill reads semantically, and enriching compact and Summary-mode tool chips.

### 🐛 Fixed

- [**Backend**] Fixed user prompts that could be lost, duplicated, reordered, or left pending across steering, reconnects, scheduled delivery, multi-viewer sessions, and transient dispatch failures by giving each message one canonical UUID and a durable, idempotent delivery lifecycle.
- [**Desktop**] Fixed prompts, permission responses, resume requests, and other controls being silently dropped during WebSocket reconnect windows by queueing outbound envelopes and flushing them in order after session initialization.
- [**Desktop**] Fixed PNG and other image files in Git diffs being treated as empty textless binaries by preserving their bytes and rendering added, deleted, and before/after previews with accurate metadata.
- [**Desktop**] Fixed live conversations jumping while the agent streams, first prompts rendering out of chronological order after pagination, older-history loading appearing stuck when Summary mode collapses a page, pending-message receipts snapping away, and Summary mode folding turns before a steered prompt is received or while a question is still active.
- [**Desktop**] Fixed mobile and remote conversation usability by keeping Send available while an agent runs, preserving iOS scroll position when older history loads, and preventing background push wakes from masquerading as active device connections.
- [**Desktop**] Fixed Git diff expansion and scroll state resetting during live updates, and ignored callbacks from replaced session sockets so stale connections cannot overwrite current state.
- [**Desktop**] Fixed absolute filesystem paths entered in the Browser so they open as correctly encoded local `file://` URLs, including names with reserved characters.

### 🔒 Security

- [**dependencies**] Updated Electron, Axios, CodeMirror, Lexical, Mermaid, Radix UI, the Agent Client Protocol, CodeQL, Rust concurrency/authentication/file-walking libraries, and build tooling, including upstream memory-safety fixes in Electron and `rand`.

## v0.6.7 - 2026-07-09

Previous release: v0.6.6 - 2026-07-05

### 🔧 Changed

- [**Desktop**] Improved sub-agent panels with sticky auto-scroll, collapsible thinking and shell output, streaming reasoning previews, and accurate running state for Claude background sub-agents so long delegated work stays readable without looking finished too early.
- [**Desktop**] Expanded context menus for feature rows and terminal panes, including clipboard-backed feature copy actions and terminal pane controls with shared icon and shortcut rendering.
- [**Desktop**] Made large workspaces significantly more responsive by coalescing streaming agent updates, throttling active markdown re-parses, windowing streaming sub-agent steps, narrowing sidebar subscriptions, deferring heavy feature mounts, deduplicating terminal/status/catalog requests, and reducing file-tree invalidation storms.
- [**Desktop**] Reworked Git diff loading for large changesets so the Git panel opens from a cheap changed-files list and fetches visible file patches lazily, preventing multi-megabyte unified diffs from freezing the renderer.
- [**Desktop**] Reduced packaged macOS app size by trimming renderer-only dependencies from the app archive, shipping a single renderer copy, and size-optimizing the Rust sidecar release profile.
- [**Backend**] Improved project and workspace MCP tool reliability with clearer schemas, provider discovery guidance, canonical provider/model handling, and adapter-owned model alias resolution.

### 🐛 Fixed

- [**Desktop**] Fixed file-tree freshness in large repositories by deciding lazy versus full-tree loading before starting full walks, refreshing open file/image reads through coalesced exact invalidations, and honoring nested `.gitignore` rules in the watcher.
- [**Desktop**] Fixed worktree Git status and diff inconsistencies for untracked files by sharing the same binary-file heuristic across stats and diffs, showing small non-UTF-8 text files lossily, and skipping large binaries instead of mislabeling them.
- [**Backend**] Fixed Sync from CLI for worktree-backed features so Claude transcript refreshes resolve the feature worktree cwd instead of the project root.
- [**Backend**] Fixed agent model alias validation when a live provider probe is unavailable by falling back to the static catalog during canonicalization.
- [**Backend**] Fixed the hot agent-state todo lookup to use the session/tool-use index instead of scanning the full agent message table.
- [**Backend**] Fixed malformed streaming deltas so an inline error block stays in transcript order within its coalesced batch instead of jumping ahead of earlier valid deltas.
- [**Desktop**] Fixed terminal paste security by removing the privileged Electron clipboard-read IPC and relying on browser clipboard permissions for user-initiated paste actions.
- [**Desktop**] Fixed `pnpm dev` shutdown so Ctrl-C reaps the full dev process group instead of leaving child processes behind.

## v0.6.6 - 2026-07-05

Previous release: v0.6.5 - 2026-07-05

### ✨ Added

- [**Desktop**] Added an embedded Excalidraw editor for `.excalidraw` files, with lazy-loaded canvas assets, dirty-state tracking, auto-save, and `Cmd`/`Ctrl+S` support so diagrams can be edited directly from the Cadencr editor instead of as raw JSON.
- [**Desktop**] Added a Stashes tab to the Git panel, showing stash descriptions, timestamps, and numstat summaries with one-click expansion into the exact stash diff.

### 🔧 Changed

- [**Desktop**] Improved agent selection by hiding unavailable local providers from selectable catalogs, throttling failed provider probes, and falling back from stale provider settings to an installed provider.
- [**Desktop**] Changed terminal behavior for new worktrees so idle shells relocate automatically while busy terminals keep the existing warning and are never killed unexpectedly.
- [**Backend**] Hardened live-session plumbing with typed WebSocket action contracts, centralized status lifecycle handling, smaller backend modules, and mutex-poison recovery so streaming/session state is easier to keep consistent.

### 🐛 Fixed

- [**provider:claude**] Fixed Claude Code sessions that could appear to stop mid-message by preserving unknown raw payloads, surfacing unmodeled events and stream diagnostics, adding sequence-gap detection and post-turn tail repair, and preventing permission dispatch from being stranded.
- [**provider:claude**] Fixed cancelled Claude control requests so stale permission responses are not written to closed stdin after the provider has already cancelled the request.
- [**provider:codex**] Fixed live Codex turns being cut short by availability-probe timeouts, while keeping catalog/status probes and cleanup paths bounded.
- [**Backend**] Fixed stacked permission prompts so accepting an older runtime permission no longer clears a newer queued permission request.
- [**Desktop**] Fixed prompt references so `$` skill mentions can be inserted anywhere in a prompt and `@` file mentions search the backend live, including files created after the feature first loaded.
- [**Desktop**] Fixed multiple UI freezes by virtualizing content-search results, progressively rendering large Git diffs, coalescing settings invalidations, and caching LSP probe results.
- [**Desktop**] Fixed project settings text fields, especially worktree setup commands, so late settings fetches do not roll back in-progress edits.
- [**Desktop**] Fixed worktree setup execution so configured setup commands run in a PTY-backed interactive login shell with terminal-like environment initialization, bounded output, and collapsed-by-default progress that expands on errors.
- [**Desktop**] Fixed sidebar and Frost-theme polish, including collapsed global sidebars re-expanding during unrelated resize drags, LSP symbol hover blur in Frost themes, inline-code contrast, and mobile-friendly project-row affordances.
- [**Desktop**] Fixed Apple Silicon download recommendations in Safari and Firefox so macOS users are not pointed at the Intel DMG when Chromium-only architecture APIs are unavailable.
- [**github_actions**] Fixed desktop release publication so GitHub Actions builds signed/notarized assets without letting electron-builder create duplicate same-tag releases, then creates one draft release, uploads the complete asset set, verifies updater/Homebrew assets, and only then publishes the release.

### 🔒 Security

- [**dependencies**] Updated desktop, landing, backend, and tooling dependencies, including Electron/electron-builder/electron-updater, Axios, React, Zustand, Rust TLS/certificate/randomness libraries, and a 40-package npm/yarn maintenance batch with focused compatibility fixes.

## v0.6.5 - 2026-07-05

Previous release: v0.6.4 - 2026-06-29

### 🐛 Fixed

- [**github_actions**] Deploy failure — no application changes were published. The GitHub release workflow created duplicate same-tag releases and published an incomplete immutable `v0.6.5` release, so the real changes were moved to `v0.6.6`. See https://github.com/merkr-software/CadencR/releases/tag/v0.6.5

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
