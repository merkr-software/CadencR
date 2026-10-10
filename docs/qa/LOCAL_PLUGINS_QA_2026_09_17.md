# Local plugins QA — 2026-09-17

## Scope and verdict

MacOS arm64 packaged-theme QA from `0f13ac748`, with production stopped by the
user. **The packaged-theme lifecycle now passes on macOS arm64**, following the
Terminal-launched Electron run documented at the end of this report. Earlier
failed attempts below are retained as historical evidence. The broader L4/L5
release gates remain open; packaged providers and other release targets are not
certified by these theme checks.

No application source changed. No commit, merge, publication or installation in
`/Applications` was performed. Package metadata still reads `0.11.5`; this is a
local branch build for the planned v0.12.0 milestone, not a release artifact.

## Production-data protection

- Backup root: `/tmp/cadencr-packaged-qa-de8e.NZBgpl/production-backup/`.
- Copied the production database, WAL and SHM without opening production SQLite.
  Source sizes, modification times and SHA-256 hashes were unchanged across the
  copy; copied bytes matched the source hashes.
- Used SQLite's backup API on the **copy**, retaining a standalone
  `cadencr.snapshot.db`. `PRAGMA integrity_check` returned `ok`.
- Snapshot size: `3758821376` bytes. SHA-256:
  `99f01eb1ab10edc523061b26836805c3e004c42e93f247f6907e73804451f3f6`.
- Runtime tests used a fresh database, settings and HOME beneath the QA directory,
  with explicit service CLI paths and login-shell hydration disabled. The
  production snapshot was not used as the test database, avoiding real project
  paths and user automation state.
- All databases and backup files are retained. No restoration or replacement of
  production was performed or needed. The backup lives in temporary storage;
  it is not a durable off-machine backup.
- Final comparison of production database/WAL/SHM sizes, modification times and
  SHA-256 hashes passed for all three files (`post-qa-verification.json`).

## Build and packaging

| Check                                                      | Result                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service `release` build through the worktree Cargo wrapper | Passed; optimized build completed in 4m 50s                                                                                                                                                                                               |
| Electron main/preload and production renderer compilation  | Passed                                                                                                                                                                                                                                    |
| Service macOS runtime dependencies                         | Passed; no Homebrew dylib dependencies                                                                                                                                                                                                    |
| Initial direct builder invocation                          | Reported success, but incorrectly selected npm; inspection found `electron-updater` absent from `app.asar`. This artifact is rejected and was not launched.                                                                               |
| Builder invoked through pnpm                               | Blocked during dependency collection. `pnpm list --prod --json --depth Infinity` independently reproduces `ERR_SQLITE_ERROR: unable to open database file`. This concerns pnpm's dependency tooling, not the Cadencr production database. |
| Native Electron preflight                                  | Aborted with `SIGABRT` during macOS `_RegisterApplication` / `NSApplication` initialization, before the probe's JavaScript executed. No Cadencr sidecar was launched by this probe.                                                       |

Packaging used the local configuration, a separate temporary output directory,
local Electron distribution, ad-hoc signing and no publication/update feed.
The rejected first artifact is **not suitable for manual QA**. No valid new
packaged application is being handed off as tested.

## Release-service checks

The real optimized service was started on loopback port `5004` with a random
test token, isolated HOME and explicit database/settings paths. No AI prompt
was sent. Theme colors came from the existing Dracula test fixture.

| Case                                                                   | Result                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create valid theme, Git repository, authoring project and conversation | Passed; new project is `kind=user`, `authoring_target=theme`, with matching `plugin_id`                                                           |
| Reopen existing theme workspace                                        | Passed; same project/conversation IDs, no duplicate workspace                                                                                     |
| External edit automatically renames project within 10 seconds          | **Not observed**; project name remained stale. No watcher error appeared in the service log. Environment versus product cause remains unresolved. |
| Read external edit and reopen after restart                            | Passed; edited label/token persisted, and reopening synchronized the project name                                                                 |
| Invalid color                                                          | Passed; API returns issues and no applicable theme; release `check-theme` exits `1` with a diagnostic                                             |
| Repair invalid theme                                                   | Passed; API returns a valid theme and `check-theme` exits `0`                                                                                     |
| Restart release service and reopen                                     | Passed; repaired theme, project marker and workspace IDs persisted                                                                                |

The failed watcher assertion remains a failure in
`service-smoke-results.json`; subsequent checks continued against the same
isolated database without resetting it. Reopen synchronization does not prove
live watcher delivery or renderer restyling.

## Cleanup and remaining work

- QA-owned service processes stopped; temporary databases/themes/backups retained.
- Final production file verification passed; no production restoration needed.
- Resolve pnpm dependency collection and inspect packaged runtime dependencies
  before launching any new artifact.
- Resolve the native Electron launch environment, then exercise actual packaged
  UI creation, edit/live-apply, invalid-theme recovery, rename, restart and Trash
  cleanup. Native cleanup and Windows/Linux targets were not exercised here.
- Investigate watcher delivery in that runnable environment. Do not treat the
  API-only repair/reopen checks as closing this issue or gates L4/L5.

Logs and scripts are retained under `/tmp/cadencr-packaged-qa-de8e.NZBgpl/`,
including `build-service.log`, `build-desktop.log`, `package.log`,
`package-pnpm.log`, `service-smoke-1.log`, `service-smoke-3.log`,
`service-smoke-4.log`, `service-smoke.out`, and `service-followup.out`.

## Follow-up — pnpm packaging unblocked

The initial pnpm error was traced to its `StoreIndex` constructor: dependency
inspection reads `node_modules/.modules.yaml`, opens the referenced global
`/Users/rle/Library/pnpm/store/v11/index.db`, and attempts to enable WAL. That
write cannot complete in the restricted tool environment. Changing only the
configured store directory would not fix inspection: it takes this path from
the installation metadata.

A separate QA metadata directory now points to a copied store index and links to
the existing installed package files. The original installation metadata and
global store were not patched, dependencies were not reinstalled, and no
application source change was needed. This invocation succeeds:

```bash
corepack pnpm \
  --config.modules-dir=/tmp/cadencr-packaged-qa-de8e.NZBgpl/pnpm-modules \
  --filter @cadencr/desktop list --prod --json --depth Infinity
```

The QA pnpm shim passes the same option to electron-builder's dependency
collector. Packaging then completed successfully into
`package-fixed/mac-arm64/Cadencr.app`. Inspection confirmed `electron-updater`,
`dotenv`, `builder-util-runtime`, `fs-extra`, and `semver` inside `app.asar`;
`codesign --verify --deep --strict` passed. No update-feed configuration is
embedded. This supersedes the initial dependency-collection blocker, but does
not validate running behavior.

Launching this corrected package from the tool environment still exits `134`
(`SIGABRT`) during macOS `_RegisterApplication` / `NSApplication` initialization,
before Cadencr code or its sidecar runs. Crash evidence:
`~/Library/Logs/DiagnosticReports/Cadencr-2026-09-17-085051.ips`.

The next step is to launch `launch-isolated-qa.zsh` from the user's Terminal,
then continue the actual Electron UI tests through its loopback debugging port.
The launcher checks port `5004`, uses separate `app-home` and `app-profile`
directories and disables login-shell environment hydration. **Do not open the
bundle directly:** the normal packaged launch defaults to production paths.
The native UI, live watcher delivery and cleanup gates remain open.

Build evidence: `package-fixed.log`; launcher output: `packaged-app.log`.

## Final packaged Electron UI QA — passed on macOS arm64

The user launched the isolated script from Terminal. Automation attached through
CDP on loopback port `9227` to the actual `file://` renderer inside
`package-fixed/mac-arm64/Cadencr.app`, not a browser tab or development server.
`window.cadencr.isElectron` was true. `lsof` confirmed that its packaged service
opened only the QA database beneath `app-home/.cadencr/database/`.

### Lifecycle results

| Case                               | Result and evidence                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create and apply                   | **Passed.** Settings → Create theme → Dracula → `Electron QA 0917` creates the theme, opens `theme.json` in the editor and applies its colors. Project `1` carries `authoring_target=theme`, `plugin_id=electron-qa-0917`; conversation is `1`.                                                                                                                                                         |
| In-app edit and rename             | **Passed.** Real editor input and Cmd+S save a changed label/color. Root computed `--acc-purple` becomes `#22ccaa`; the project name updates without reopening.                                                                                                                                                                                                                                         |
| External edit and live application | **Passed.** A filesystem edit changes the label to `Electron QA External 0917` and the color to `#ff88aa`. The mounted renderer and sidebar update without navigation/reload. The previous restricted-service watcher failure does not reproduce in this packaged run.                                                                                                                                  |
| Invalid theme and correction       | **Passed.** Saving `--foreground: not-a-color` shows a specific toast/library diagnostic, makes the theme non-applicable and falls back to CadencR Dark. Edit remains available. Correcting in the editor removes the failure and automatically reapplies the theme, with `--acc-purple: #33bbdd`. The generated `check-theme` script also passes using the bundled service.                            |
| Reopen without duplicates          | **Passed.** Opening through the library keeps project/conversation IDs `1`/`1` and preserves the edited file.                                                                                                                                                                                                                                                                                           |
| Full application restart           | **Passed.** User quits and relaunches via the isolated script. CDP target changes from `20B1D71B2DAAAC272773FB3FAD892590` to `FB3A4E3BA635235421C823E5DDA32351`; sidecar PID changes from `46567` to `48499`. Theme `Electron QA Repaired 0917`, applied color `#33bbdd` and project marker survive. Workspace endpoint returns the same IDs with `created=false`; library Edit reopens the saved file. |
| Native cleanup                     | **Passed.** Cancelling Delete leaves both entries intact. Confirming Delete removes the theme/project from the API and UI and returns to the default theme. `/Users/rle/.Trash/electron-qa-0917` contains all **34 files**, including Git history, with identical relative paths and SHA-256 hashes to the pre-delete manifest.                                                                         |

### Diagnostics and test-environment corrections

- The first launch script omitted Node from PATH. Opening JSON therefore produced
  an LSP `500` and an `Internal server error` toast; the service log identified
  `env: node: No such file or directory`. The QA launcher now includes the existing
  Node installation. After full restart and reopening the file, the UI reports
  **Language server ready**. No application-code patch was needed.
- This intentionally feed-less local package reports missing `app-update.yml`;
  updates were neither downloaded nor installed.
- Console records the ignored meta-delivered CSP `frame-ancestors` directive.
  No uncaught renderer exception was observed. Cleanup emitted one `404` for
  `/api/projects/1/settings` after that project was deleted; the UI nevertheless
  settled on an empty project/theme list and the default theme. This residual
  request is recorded for cleanup review, not hidden by the successful lifecycle
  assertions. This is not a claim that every app subsystem was tested.
- No AI prompt was sent. No provider/package publication, real project change,
  database restoration or database deletion occurred.

### Evidence and final state

Evidence beneath `/tmp/cadencr-packaged-qa-de8e.NZBgpl/`:

- Screenshots: `ui-theme-created.png`, `ui-theme-live-edit.png`,
  `ui-theme-invalid.png`, `ui-theme-repaired.png`, `ui-theme-after-restart.png`,
  `ui-theme-deleted.png`.
- Structured checks: `ui-before-restart.json`, `ui-after-restart.json`,
  `ui-reopened-editor.json`, `ui-theme-deleted.json`,
  `theme-before-trash.json`, `theme-trash-verification.json`.
- Console captures: `ui-console-initial.json`, `ui-console-before-restart.json`,
  `ui-console-after-restart.json`, `ui-console-final.json`.

All production database/WAL/SHM hashes, sizes and modification times remain equal
to the initial backup manifest; the final result is recorded in
`production-backup/final-ui-qa-verification.json`. No restore is needed.
The production backup and QA databases are retained. The user-launched QA app
is left open; quit it before restarting the installed production app on `5004`.

Remaining scope is packaged-provider lifecycle coverage, the release target
matrix beyond this macOS arm64 run, and integration/readiness review. This report
does not authorize a commit, merge, push or release.

## Follow-up: deletion request regression — 2026-09-18

Validated in the development renderer (`1424`) and backend (`5103`), with a
fresh database, settings directory and backend home under
`/tmp/cadencr-theme-dev-qa.UqFXLL`. Production remained running on `5004`.

- Fixed theme deletion to invalidate project/conversation **list URLs only**,
  rather than refetching still-mounted details for the deleted workspace.
- Created `Dev Delete QA 0918` from Dracula through the UI and opened its editor.
  Project settings requests returned `200` before deletion.
- Cancelled the confirmation: theme and project remained available.
- Confirmed deletion: `DELETE /api/themes/dev-delete-qa-0918` returned `200`;
  theme/project/conversation lists refreshed successfully, with no subsequent
  `/api/projects/1/settings` request and no `404`.
- Reloaded the page: empty theme/project lists and CadencR Dark remained selected.
- No deletion-time console errors. Reload produced the existing meta-CSP warning,
  browser-only desktop-runtime fallback warning, and a WebSocket close-before-open
  warning; these are not claimed fixed by this change.
- Focused hook/cache tests: **15 passed**. Regression coverage keeps detail-query
  observers mounted during deletion, checks failed deletion preserves caches, and
  verifies a refresh failure surfaces an error toast. Refetch error propagation is
  explicitly enabled for this deletion path only.

Network evidence and server logs are retained in the isolated directory above.
This closes the theme-deletion request regression, not packaged-provider QA or
the cross-platform release matrix.
