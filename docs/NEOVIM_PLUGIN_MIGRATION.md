# Migrating full Neovim to the Neovim plugin

Status: coexistence (plan
[`plans/2026-11-04-generic-plugin-backends-neovim.md`](./plans/2026-11-04-generic-plugin-backends-neovim.md),
commit 6). The built-in full Neovim editor keeps working; the standalone
`cadencr-plugin-tab-neovim` plugin can replace it progressively.

## For users

If your editor is **Full Neovim**, Settings → Editor shows a
"Move full Neovim to the Neovim plugin" panel.

- Install the `neovim` plugin from the Marketplace, then review its consent
  and enable it in Settings → Custom tabs. The plugin runs the `nvim` already
  installed on your machine, with your own configuration — CadencR never
  installs or downloads Neovim for you.
- Choose **Switch to the Neovim plugin**. The switch is refused while a
  built-in Neovim session is still open: save your buffers and quit those
  sessions (`:qa`), then retry.
- The switch writes the `editor_backend` setting to `plugin:neovim`. It takes
  effect immediately — the file tree, search, palette, `file:line` links and
  diffs all open in the plugin. You can switch back to the built-in editor at
  any time from the same setting; the legacy `editor_vim_mode_level` value is
  left untouched.
- On remote (web/mobile) access the plugin editor is unavailable and files
  keep opening in CodeMirror, with an explanation.

Nothing is migrated automatically: unsaved buffers, window layouts and
session state of the built-in editor are not transferred. Save and quit
built-in sessions before switching.

## For developers

The migration is a narrowly scoped, temporary host API (main token only):

- `GET /api/neovim/migration` — gate status: plugin state (`not_installed`,
  `blocked`, `not_an_editor`, `not_built`, `backend_unavailable`,
  `consent_required`, `disabled`, `ready`), the feature ids with a built-in
  Neovim process alive, the current `editor_backend`, and the target value.
- `POST /api/neovim/migration` — writes `editor_backend = "plugin:neovim"`
  only when the plugin is ready and no built-in session runs. Refusals carry
  stable codes: `NEOVIM_PLUGIN_NOT_INSTALLED` (404), `NEOVIM_PLUGIN_BLOCKED`,
  `NEOVIM_PLUGIN_NOT_AN_EDITOR`, `NEOVIM_PLUGIN_NOT_BUILT`,
  `NEOVIM_PLUGIN_BACKEND_UNAVAILABLE`, `NEOVIM_PLUGIN_CONSENT_REQUIRED`,
  `NEOVIM_PLUGIN_NOT_ENABLED`, `NEOVIM_SESSIONS_RUNNING` (409). The endpoint
  is idempotent: a second call reports `migrated: false`. Successful
  migrations are logged as an audit event (`tracing`, plugin/key/value).

The built-in editor, its routes and its WebSocket stay in place for the whole
coexistence period; removal is a later, separately gated step (plan commit 7)
that requires a published coexistence release, an available plugin and
validated migration paths.
