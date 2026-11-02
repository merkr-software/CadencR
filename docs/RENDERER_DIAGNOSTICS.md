# Renderer diagnostics

Diagnostics capture the context needed to investigate failures such as React #185.
They do not identify the update loop's origin automatically: a component stack can
name the throw site rather than the component responsible for repeated updates.

## Collect a report

1. On the crash screen, click **Export diagnostic report**. **Copy error details**
   also copies the JavaScript stack, React component stack and crash context.
2. After restarting, use **Settings → About Cadencr → Diagnostics → Export
   diagnostic report** to retrieve retained errors.
3. Share the JSON report with the issue, the approximate incident time and the
   actions immediately preceding it. Inspect it before sharing: error messages,
   stacks and error URLs can contain paths or application data.

Electron opens a native save dialog; browser clients download a JSON file. Export
errors remain visible beside the button. Native exports require an unused `.json`
filename and never overwrite an existing file. Reports stay local until the user
shares them. Separate [opt-in diagnostics](./TELEMETRY.md), off by default, can
send a strict failure category and packaged app frame positions to Sentry; it
never uploads these report files, error messages or activity history.

## Captured context and retention

| Data                 | Behavior                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correlation          | Unique report/session/build IDs, app and React versions, capture time, uptime                                                                                                         |
| Runtime              | User agent and viewport; Electron adds OS, architecture, Electron and Chrome versions                                                                                                 |
| Failure              | Source, message, JavaScript stack, URL/line/column and React component stack when available                                                                                           |
| Recent activity      | Up to 100 events from the preceding 60 seconds, frozen when the error occurs                                                                                                          |
| Events               | Redacted navigation, generic button/tab clicks, visibility/viewport, editor counts, agent status counts, connection state, WebSocket event types and conversation scroll-follow state |
| Streaming            | Repeated events aggregated into one-second buckets; no per-token persistence                                                                                                          |
| Retained reports     | Up to 10 errors across restarts; known ResizeObserver loop notifications are evicted first, then React recoverable errors, then the oldest remaining error                            |
| Duplicate protection | Identical failures suppressed for 10 seconds, with a bounded fingerprint cache; no lifetime report cap                                                                                |

Breadcrumbs do not collect prompts, completions, typed values, file contents or
filenames. Route identifiers and query strings are removed. The error payload
itself preserves diagnostic text and is not guaranteed to be free of sensitive
information. The recorder uses bounded plain memory; it does not write React or
Zustand state. Editor summaries are coalesced over 100 ms and flushed before
capturing a crash, keeping scans off the per-keystroke path.

Only `error` reports with the exact messages `ResizeObserver loop completed with
undelivered notifications` or `ResizeObserver loop limit exceeded` (with or
without a final period) receive the lowest retention priority. The incoming
report is also eligible for eviction, so these notifications cannot displace
important evidence from a full buffer. Other errors and unhandled rejections
keep their priority; capture and console/text logging are unchanged. This policy
does not establish any causal link with React #185 or demonstrate its resolution.

React root hooks report `react-boundary`, `react-uncaught` and `react-recoverable`.
Root and boundary notifications for the same error object in one commit are
consolidated before persistence, retaining the fuller component stack. Suppressed
repeats reuse the original crash context so copied and exported report IDs match. Global
`error` and `unhandledrejection` handlers also report failures; errors thrown by
timers or store callbacks may have no React component stack.

| Environment          | Storage                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Installed macOS      | `~/.cadencr/cache/logs/renderer-diagnostics.json`                                                                         |
| Installed Linux      | `$XDG_CACHE_HOME/cadencr/logs/renderer-diagnostics.json`, defaulting to `~/.cache/cadencr/logs/renderer-diagnostics.json` |
| Electron development | `renderer-diagnostics.json` in the isolated Electron `userData` profile                                                   |
| Browser              | Origin-local `localStorage`, key `cadencr:renderer-diagnostics:v1`                                                        |

Electron validates payloads and atomically replaces the bounded history file.
A malformed existing history is preserved and surfaces an error instead of being
silently discarded. The independent text log is still attempted if JSON history
cannot be saved; save failures are visible even on the global crash screen. The existing Electron `renderer-errors.log` is also written
and rotates at 2 MiB with one previous file. Console logging is preserved.
A renderer process termination or a fully blocked event loop can still prevent
JavaScript capture; this is not a native crash dump or session replay.

## Release source maps outside the executable

Both release workflows enable hidden maps during the **same renderer build** that
is packaged. They publish a separate GitHub release asset:

```text
Cadencr-<version>-darwin-renderer-diagnostics.tar.gz
Cadencr-<version>-linux-renderer-diagnostics.tar.gz
```

Each archive contains the exact JavaScript/CSS bundles and their maps, including
source content, plus `manifest.json` with build ID, commit, version, build platform,
Node version, lockfile SHA-256 and individual file sizes/SHA-256 hashes. The macOS
archive corresponds to the shared renderer packaged for arm64 and x64; Linux uses
its own build and build ID. Runtime architecture is included in Electron reports.

Both production and local electron-builder configurations exclude `.map` files
from the application archive and the copied renderer resources. The production
`afterPack` hook additionally fails packaging if renderer resources contain maps.
Hidden maps have no `sourceMappingURL` comment. The separate release asset is
publicly downloadable; exclusion from the app is not an access-control mechanism.

For a local diagnostic build:

```sh
CADENCR_RENDERER_SOURCEMAPS=1 pnpm --filter @cadencr/desktop exec electron-vite build
node packages/desktop/scripts/archive-renderer-diagnostics.mjs
```

The archive is written under `packages/desktop/diagnostics/`. Ordinary local builds
omit maps unless the environment variable is set. Do not rebuild between archival
and packaging: even the same commit can produce a different build ID and bundle.

## Investigate an exported failure

1. Select the relevant entry in `reports`; use its `error.diagnostics`, not the
   export-time `current` context. Match its `reportId` to copied crash details.
2. Retrieve the release archive for that app version and platform. Verify that
   `manifest.json.buildId` equals the failed renderer's `buildId`.
3. Locate the bundle named in the JavaScript stack and verify its SHA-256 against
   the manifest. Use the adjacent `.map` to symbolicate that exact bundle. Browser
   stack positions use one-based columns; source-map APIs usually expect a
   zero-based generated column.
4. Read breadcrumbs in chronological order alongside the React component stack.
   Compare editor transitions, concurrent agent activity, stream bursts and scroll
   state near the failure; these are leads, not proof of the loop's origin.

An older published bundle with no retained matching maps cannot reliably be
symbolicated using a fresh rebuild. This instrumentation helps subsequent
releases; it cannot recover missing source maps for previously shipped binaries.
