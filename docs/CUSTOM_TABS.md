# Custom tabs

Status: implemented locally (decision 2026-10-16, amends
[PLUGIN_STRATEGY.md §4/§5](./PLUGIN_STRATEGY.md)). Custom tabs are **local
plugins**: a user builds a web UI that Cadencr shows as a feature-page tab, next
to Agent, Terminal, Git, Editor and Browser. They are flagged as plugin projects
(`authoring_target = 'tab'`) so a later marketplace can publish them; no
marketplace UI ships with them.

This document is the contract shared by the service, the Electron host, the
renderer broker, `@cadencr/tab-sdk` and `@cadencr/tab-kit`. Change it first,
then the code.

A tab is one of three **levels** (§6.2), from least to most reach: a page
that only reads Cadencr data (**read-only**), a page that also asks Cadencr to
run the programs it lists (**runs commands**, §4.6), and a page with its own
native process that runs with the user's rights (**native code**, §4.7).
Cadencr does not sandbox native code (decision 2026-10-18); what it always
enforces is the tab's access to Cadencr itself.

## 1. Model

| Term             | Meaning                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Custom tab**   | A local plugin of kind `tab`: a folder holding `tab.json` and a static `dist/` bundle.                                                                              |
| **Tab instance** | One live rendering of a custom tab inside one feature page. Identified by an opaque `instanceId`.                                                                   |
| **Grant**        | An ephemeral, in-memory, opaque token the service mints for one instance. It names the plugin, project, feature and the consented scopes. Never shown to the guest. |
| **Guest**        | The plugin's web page, running in an isolated `WebContentsView`.                                                                                                    |
| **Broker**       | First-party renderer code that owns the guest's `MessagePort`, holds the grant, and relays requests.                                                                |

Invariants:

1. No third-party JavaScript ever runs in the Cadencr renderer. Guests run in
   their own process, partition and origin.
2. The guest has no network (`connect-src 'none'`). Every byte it gets comes
   through its `MessagePort`.
3. Authorization is enforced by the **service** from the grant. Context the host
   hands the guest is information, not authority.
4. Deny by default: an API route is reachable by a plugin only when the policy
   table lists it.
5. Desktop only in v1. The remote/mobile SPA shows a placeholder.

## 2. Package layout on disk

```
~/.cadencr/plugins/tabs/<id>/      # a Git repository (authoring project)
  tab.json                         # manifest (§3)
  icon.svg                         # optional, ≤ 32 KiB
  package.json, src/, vite.config.ts, …
  dist/                            # build output Cadencr loads (gitignored)
    index.html                     # `entry`
```

The root is `settings_store::dir::sibling_dir("plugins").join("tabs")`, the
sibling of `plugins/themes`. Cadencr rescans it on startup and watches it
(`tab.json`, `icon.svg`, `dist/**`).

## 3. Manifest — `tab.json`

```json
{
  "schema_version": 1,
  "kind": "tab",
  "id": "changed-files-graph",
  "name": "Changed files graph",
  "version": "0.1.0",
  "description": "Graph of the files this feature changed.",
  "icon": "icon.svg",
  "api_version": 1,
  "entry": "dist/index.html",
  "tab": { "label": "Graph" },
  "permissions": ["features:read", "git:read"],
  "network": {
    "allowed_origins": ["https://gitlab.example.com"],
    "reasoning": "Reads merge-request pipelines from the team GitLab."
  },
  "configuration": [
    { "key": "gitlab_url", "type": "string", "label": "GitLab URL", "scope": "global" },
    { "key": "gitlab_token", "type": "secret", "label": "Access token", "scope": "global" },
    {
      "key": "group",
      "type": "select",
      "label": "Grouping",
      "scope": "project",
      "options": ["directory", "extension"],
      "default": "directory"
    }
  ],
  "commands": [{ "program": "git", "reasoning": "Reads who changed these files." }],
  "backend": {
    "protocol": 1,
    "binary": {
      "darwin-aarch64": "bin/darwin-aarch64/ports",
      "darwin-x86_64": "bin/darwin-x86_64/ports",
      "linux-x86_64": "bin/linux-x86_64/ports"
    },
    "reasoning": "Lists the processes listening on local ports."
  },
  "shortcuts": [
    { "id": "refresh", "keys": ["mod", "shift", "r"], "description": "Refresh the graph" }
  ]
}
```

`commands`, `backend` and `shortcuts` are optional; most tabs declare none.

Rules (validated by `cadencr-plugin-core::tab`, the service and
`cadencr plugin validate --kind tab`):

- `id`: `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` and equal to the folder name.
  It is a URL host label (`cadencr-tab://<id>/`).
- `name` 1–64 chars, `version` semver, `description` ≤ 280 chars, `tab.label`
  1–24 chars (defaults to `name`).
- `api_version`: integer; v1 hosts accept `1`.
- `schema_version`: `1` or `2`. New scaffolds use `2`; existing v1 manifests
  keep working. `contributes.editor` requires v2 and a native `backend`.
- `entry`, `icon`: relative, normalized, no `..`, no absolute paths, no
  backslashes; `icon` must end in `.svg`.
- `permissions`: unique values from the scope list in §6. Unknown scopes are
  errors.
- `network.allowed_origins`: `https://host[:port]` origins (`http://` allowed
  only for `localhost`/`127.0.0.1`), no paths, no wildcards, ≤ 16 entries.
  `reasoning` is required when the list is non-empty.
- `configuration`: ≤ 32 fields; `key` `^[a-z][a-z0-9_]{0,47}$`, unique; `type`
  ∈ `string | number | boolean | select | secret`; `scope` ∈ `global | project`;
  `select` requires non-empty `options`, none blank or repeated; `secret`
  cannot have a `default`.
- `commands`: ≤ 16 entries; `program` is a bare file name
  (`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`, no path, no arguments), unique
  case-insensitively, resolved on the user's `PATH` at run time; `reasoning`
  1–280 chars, required. General-purpose launchers are refused
  (`COMMAND_NOT_ALLOWED`): shells and script hosts (`sh`, `bash`, `zsh`,
  `pwsh`, `cmd`, `wscript`, `mshta`…),
  interpreters and runtimes (`node`, `python`, `ruby`, `perl`, `deno`, `bun`,
  `java`, `dotnet`…), package runners (`npx`, `npm`, `pnpm`, `yarn`, `uvx`,
  `pipx`…) and launchers/privilege tools (`env`, `sudo`, `xargs`, `nohup`,
  `open`, `start`…), with or without a Windows suffix or a version suffix
  (`python3.12`, `node18`, `php-8.2`; `cadencr_plugin_core::tab::DENIED_PROGRAMS`). Listing a program names
  _which_ program runs, not what it does with its arguments.
- `backend.protocol`: the stdio protocol version, `1` or `2`
  (`BACKEND_PROTOCOL_UNSUPPORTED` otherwise). `backend.binary`: at least one
  entry (`BACKEND_BINARY_REQUIRED`) mapping a platform — `darwin-aarch64`,
  `darwin-x86_64` or `linux-x86_64`; anything else, Windows included, is
  `BACKEND_PLATFORM_UNKNOWN` — to a clean relative path inside the tab folder
  (`PATH_INVALID`). `reasoning` 1–280 chars, required. Only the map's shape is
  validated: this platform's binary missing or not a native executable is a
  warning (`BACKEND_UNAVAILABLE`), like an unbuilt entry, and other platforms'
  binaries are only reported by `cadencr plugin validate`, which also runs
  this platform's built binary through the protocol conformance checks
  (§4.7). A platform with no
  entry cannot run the backend (the summary's `backend_availability` is
  `unavailable_on_platform`). The former `command`/`args` launch line is
  refused with `BACKEND_COMMAND_REMOVED` and how to migrate.
- `shortcuts`: ≤ 16 entries (`SHORTCUTS_TOO_MANY`), each fired only while the
  tab has focus (§5.1). `id` `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`, unique
  (`SHORTCUT_ID_INVALID`, `SHORTCUT_ID_DUPLICATE`); `description` 1–80 chars
  (`SHORTCUT_DESCRIPTION_INVALID`); `keys` in the desktop's shortcut tokens:
  modifiers `mod` (⌘ on macOS, Ctrl elsewhere), `ctrl`, `alt`, `shift`, each
  at most once, plus exactly one key — a lowercase letter, a digit, `f1`–`f12`,
  `enter`, `escape`, `space`, `up`, `down`, `left`, `right`, `plus`, `minus`,
  `comma`, `slash`, `backtick`, `backspace`, `lbracket` or `rbracket` — with
  `mod`, `ctrl` or `alt` held, since a bare or Shift-only key is typing
  (`SHORTCUT_KEYS_INVALID`); no two on the same keys
  (`SHORTCUT_KEYS_DUPLICATE`). Colliding with a Cadencr shortcut is not a
  validation error, as Cadencr's are rebindable: the host disables that one
  (§5.1). Shortcuts are not permissions, so they leave the hash unchanged.
- Unknown top-level keys are errors (the format is closed until it is published).

**Permissions hash**: SHA-256 (hex) over the canonical JSON
`{"permissions":[sorted],"allowed_origins":[sorted]}`, extended with
`"commands":[sorted programs]` when `commands` is non-empty and
`"backend":{"protocol":1,"binary":{<platform>:<path>, sorted by platform}}`
when a backend is declared (each key omitted otherwise, so a tab declaring
neither keeps its hash). Consent is recorded against this hash; a widened
manifest — a new scope, origin, program, backend, or a platform's binary
added or moved — requires a new consent. Reasons, labels and
versions do not. An editor contribution adds
`"editor":{"label":<label>,"open_method":<method>}` after `backend` in the
canonical JSON. Adding or changing that contribution requires fresh consent.
When no editor is declared, even with an empty `contributes` object or a v2
manifest, the old hash is unchanged.

### 3.1 Editor contribution

```json
{
  "schema_version": 2,
  "contributes": {
    "editor": { "label": "Example editor", "open_method": "editor.open" }
  }
}
```

This fragment extends the ordinary tab manifest. `label` is 1–24 characters;
`open_method` is a plugin-defined method of 1–128 ASCII letters, digits or
`._:-`. The host passes `EditorOpenFileParams { path, line?, column? }` with
1-based positions. The native backend must acknowledge the navigation before
the editor controller focuses the surface. An editor contribution appears as
`editor` in the installed tab's API summary and staged update.

Tabs and editors share the Electron surface host, isolation, theme, shortcut
relay, port bootstrap, overlay suppression and hidden-guest recycling. Their
instance identities are distinct: `<feature>:plugin:<id>` for a tab and
`<feature>:editor:<id>` for an editor. A surface cannot change kind in place.
Backend presence follows the logical surface, independent of guest visibility
and recycling. Tab and editor leases can coexist for the same backend; closing
one does not stop a backend still leased by the other.

The host primitive is `PluginEditorSurface`, mounted once per conversation
outside CodeMirror's split tree. Web/mobile clients show CodeMirror with a
visible explanation instead of creating native surfaces.

#### Editor selection and navigation

Settings → Editor stores `editor_backend` in the existing workspace settings:

| Value         | Editor                                         |
| ------------- | ---------------------------------------------- |
| `codemirror`  | Built-in CodeMirror                            |
| `neovim`      | Built-in Neovim during the coexistence release |
| `plugin:<id>` | The installed plugin's `contributes.editor`    |

An absent key preserves `editor_vim_mode_level`: `2` selects built-in Neovim;
other levels select CodeMirror. Vim motions are a separate control. Changing
them first records the legacy editor identity if necessary, and neither
setting's new value enters the cache before the service confirms its write.

File tree actions, file/content search, the command palette, conversation and
diff links, LSP navigation and theme editing use `useOpenEditorFile` or
`useEditorFileNavigator`. Preview remains a separate document action. Common
line and column values are 1-based, including the CodeMirror fallback.

The controller reveals the Editor, waits up to 15 seconds for the connected
surface, calls its declared method through the broker's existing scoped grant,
then focuses after acknowledgement. Ordering is per conversation and begins
before asynchronous settings resolution. A response from an older opening,
an obsolete editor choice or a recycled surface cannot regain focus.

Missing, disabled, blocked, unsupported or unbuilt editors produce an
explanation above CodeMirror. A transport/backend failure is also reported and
opens that file in CodeMirror. Requests with effects are never automatically
replayed; the user can retry the editor explicitly.

Editor presence persists after leaving its conversation page and releases
when the contribution becomes unavailable, the selected editor changes or
the conversation is deleted. Only conversations that mounted the editor
acquire presence; choosing a plugin does not start it for every conversation.

The shortcut relay reserves the host's fuzzy file search and Explorer toggle
only on editor surfaces, including user remapping and non-QWERTY layouts.
Buffer commands such as save remain the editor plugin's responsibility.

## 4. Service

### 4.1 Tables (one migration)

- `projects.authoring_target` CHECK widens to `('theme','provider','tab')`
  (table rebuild — see the `migration-safety` skill).
- `plugin_tab_enablements(plugin_id TEXT, project_id INTEGER NULL REFERENCES
  projects(id) ON DELETE CASCADE, enabled INTEGER NOT NULL, updated_at TEXT)`.
  `project_id IS NULL` is the global row. Unique per `(plugin_id)` for global and
  per `(plugin_id, project_id)` for project rows.
- `plugin_tab_consents(plugin_id TEXT PRIMARY KEY, permissions_hash TEXT NOT
  NULL, consented_at TEXT NOT NULL, setup_pending INTEGER NOT NULL)`.
  `setup_pending` is set by the creation's consent (§8) and cleared by the
  first stored enablement choice.
- `plugin_tab_config(plugin_id, project_id NULL, key, value TEXT, is_secret,
  updated_at)` — global and project values; secrets live here too and are
  never returned. `is_secret` is kept with the value, so a manifest that
  re-declares a secret field as a plain one cannot read the saved secret.
- `plugin_tab_storage(plugin_id, project_id INTEGER NOT NULL, key, value TEXT,
  updated_at)` — the plugin's own key/value store, per project.

Effective enablement for a project = project row ?? global row ?? off, **and**
a consent row whose hash equals the current permissions hash, **and** a valid
manifest.

### 4.2 Host API (main token, `x-cadencr-token`)

| Method & path                                             | Purpose                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/plugin-tabs?project_id=`                        | List local tabs with manifest, validation, enablement.                                                                               |
| `GET /api/plugin-tabs/{id}?project_id=`                   | One tab.                                                                                                                             |
| `PUT /api/plugin-tabs/{id}/enablement`                    | `{project_id: number\|null, enabled: boolean\|null}`; `null` clears a project override. Enabling needs consent.                      |
| `PUT /api/plugin-tabs/{id}/consent`                       | `{permissions_hash}`; must equal the current hash (409 `PLUGIN_TAB_CONSENT_STALE`).                                                  |
| `GET/PUT /api/plugin-tabs/{id}/configuration?project_id=` | Settings form values; secrets come back as `{ "is_set": true }`.                                                                     |
| `GET /api/plugin-tabs/{id}/assets/{*path}`                | Static bytes from the plugin folder with CSP headers (§5.2). Empty path = `entry`.                                                   |
| `POST /api/plugin-tabs/{id}/grants`                       | `{feature_id}` → `{token, expires_at, scopes, api_version}`. 403 `PLUGIN_TAB_DISABLED` if not effective for the feature's project.   |
| `POST /api/plugin-tabs/authoring`                         | `{name, description?}` → `{plugin_id, project_id, feature_id, dir}`. Creates the authoring project (§8).                             |
| `GET /api/plugin-tabs/{id}/activity?feature_id=`          | What the tab ran in that conversation since launch: `{commands: PluginTabExecRecord[] (newest first, ≤ 50), backend: status\|null}`. |
| `DELETE /api/plugin-tabs/{id}/backends/{feature_id}`      | Stop the tab's backend there and clear its crash history; the tab's next request starts it again.                                    |

Summary shape (`PluginTabSummary`): `id, name, version, description, label,
icon_svg (string|null), api_version, entry, entry_present, permissions,
network {allowed_origins, reasoning}, configuration, permissions_hash, status
("valid"|"invalid"), errors[], warnings[], dir, authoring_project_id|null,
enablement {global: bool|null, project: bool|null, effective: bool,
consent_required: bool}, commands[], backend|null, backend_availability
("available"|"unavailable_on_platform"|null), access_level
("ui"|"commands"|"backend"; "ui" when the manifest is unreadable)`.

### 4.3 Plugin API (grant token, `x-cadencr-plugin-token`)

`auth_middleware` accepts **either** the main token **or** a plugin token,
never both. With a plugin token it:

1. resolves the grant (unknown/expired → 401 `PLUGIN_TOKEN_INVALID`);
2. looks up `(method, MatchedPath)` in the policy table (missing → 403
   `PLUGIN_SCOPE_DENIED`);
3. checks the entry's scope is granted (403 `PLUGIN_SCOPE_DENIED`);
4. checks the binding: `FeaturePath(param)` / `FeatureQuery(param)` must equal
   the grant's feature, `ProjectPath`/`ProjectQuery` its project, `Unbound`
   requires nothing more (403 `PLUGIN_BINDING_DENIED`);
5. inserts a `PluginPrincipal` request extension.

Bindings read parameters with axum's own decoders (`RawPathParams`, `Query`) —
exactly what the handler will see. Every occurrence of a repeated `feature_id`
/ `project_id` must match, and an undecodable path or query binds nothing.
Plugin-token traffic is rate-limited per plugin (1200 requests/min, its own
bucket). The `self/configuration` and `self/net/fetch` routes re-check the
tab's current permissions hash against the one the grant was consented under;
a mismatch (e.g. a widened `allowed_origins` the watcher has not acted on yet)
revokes the grant on the spot (401 `PLUGIN_TOKEN_INVALID`). Tab ids that equal
a static `/api/plugin-tabs/<segment>` (`authoring`, `grants`, `self`, `ws`) are
reserved.

Plugin-only routes (`binding = SelfPlugin`, no scope required):

| Method & path                                        | Purpose                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/plugin-tabs/self/configuration`            | Non-secret config, project values over global over defaults.         |
| `GET /api/plugin-tabs/self/storage`                  | List keys.                                                           |
| `GET/PUT/DELETE /api/plugin-tabs/self/storage/{key}` | Own key/value store (value ≤ 256 KiB, ≤ 500 keys).                   |
| `POST /api/plugin-tabs/self/net/fetch`               | Egress relay (§4.5).                                                 |
| `POST /api/plugin-tabs/self/exec`                    | Run one of the tab's `commands` (§4.6).                              |
| `POST /api/plugin-tabs/self/backend`                 | One request to the tab's native backend (§4.7).                      |
| `GET /api/plugin-tabs/ws`                            | Plugin socket (§4.4); token in subprotocol `cadencr-plugin.<token>`. |

The policy table (`domain/plugin_tabs/policy.rs`) is one ordered list of
`{method, path, scope, binding, tier}`. It drives enforcement, the filtered
OpenAPI document (`dump-openapi --plugin-surface`, operations tagged with
`x-cadencr-scope` and `x-cadencr-tier`) and the SDK's generated client.
`tier` is `stable` or `proposed`; local plugins may use both, a future
marketplace accepts only `stable`.

Never reachable with a plugin token: auth/remote pairing, installers and
provider lifecycle, MCP control, database maintenance, settings other than the
plugin's own, plugin enablement/consent/grants/authoring themselves.

### 4.4 Plugin socket

`GET /api/plugin-tabs/ws`, same `WsEnvelope` as `/ws`. Client actions, domain
`plugin`:

- `subscribe {topic, params?}` → reply `subscribed {subscription_id}` or an
  `error {code, message}` reply.
- `unsubscribe {subscription_id}`.
- `backend.request {method, params?, timeout_ms?}` → `backend.response
  {result?}` or `{error?: {code, message}}`; relay failures are correlated
  `error {code, message}` replies. The authenticated grant selects the
  backend; extra plugin/project/conversation parameters never change it.

Server events: `{domain:"plugin", action:"event", payload:{subscription_id,
topic, seq, envelope:{domain, action, payload}}}` — `seq` is per subscription,
starting at 1; `envelope` is the internal event, forwarded unchanged.

| Topic            | Scope            | Source                                              | Binding                       |
| ---------------- | ---------------- | --------------------------------------------------- | ----------------------------- |
| `git.status`     | `git:read`       | `git_watcher` (`git/status`)                        | grant feature                 |
| `session.stream` | `agent:observe`  | feature sender registry (session domain, read-only) | grant feature                 |
| `files.changes`  | `files:read`     | file watcher                                        | grant feature                 |
| `forge.status`   | `forge:read`     | forge status                                        | grant feature / project       |
| `feature.events` | `features:read`  | feature events                                      | filtered to the grant project |
| `session.status` | `workspace:read` | app session status                                  | none                          |
| `backend.events` | native consent   | native protocol-v2 events, `params: {topic}`        | grant plugin and feature      |

A plugin socket never accepts session-control actions (prompt, permission,
interrupt…). Outbound envelopes not matching a live subscription are dropped.

- The `subscribed` reply always precedes the subscription's first event.
- One source per topic per socket (per native topic for `backend.events`): a repeated `subscribe` to a topic gets its
  own `subscription_id` and `seq` but shares the source, and receives a
  `resync` before its first event (it missed the snapshot). The source stops
  when its last subscription leaves (≤ 32 subscriptions per socket).
- `{domain:"plugin", action:"resync", payload:{subscription_id, topic}}` means
  events were lost: refetch. Outbound frames queue on a bounded queue (256);
  when it is full, events are dropped and their subscription is owed a
  `resync`, delivered before its next event or as soon as the queue drains. A
  client that leaves even replies unread is closed with 1008.
- `session.stream` is filtered at the source (only the read-only session
  actions, never replies) and buffered per subscription up to 256 frames; a
  subscription that falls behind drops its backlog and gets a `resync`. The
  agent stream never waits on a plugin.
- Inbound frames are ≤ 1 MiB + 4 KiB, with native params separately limited
  to 1 MiB. Subscription actions are ≤ 20/s; native requests have a separate
  ≤ 200/s budget and ≤ 64 pending calls. Past a budget, frames are dropped
  with one `RATE_LIMITED` error per second, and 5 seconds over budget in a row
  close the socket with 1008.

### 4.5 Egress relay

Bytes travel raw both ways; nobody base64-encodes or JSON-parses a payload.

Request: `POST /api/plugin-tabs/self/net/fetch?url=<urlencoded absolute
URL>&method=<GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS>` (method defaults to
`GET`), plugin token as usual, optional header `x-cadencr-net-headers: <JSON
object of string values>` (≤ 16 KiB, ASCII — escape anything else as
`\uXXXX`; the SDK does; a non-ASCII value goes upstream as UTF-8), body = the raw upstream request body
(`application/octet-stream`, ≤ 10 MiB; empty = none).

Response when the upstream answered, whatever its status: **200** with
`x-cadencr-net-status: <upstream status>`, `x-cadencr-net-headers: <JSON
object of the filtered upstream headers>` (lowercase names, repeated headers
joined with `, `), body = the raw upstream body. Relay failures keep the
normal `{error, code}` JSON with a non-200 status and **no**
`x-cadencr-net-status`: 403 `PLUGIN_NETWORK_DENIED`, 400
`PLUGIN_TAB_SECRET_UNKNOWN` / `BAD_REQUEST`, 429 `PLUGIN_NETWORK_BUSY`, 504
`PLUGIN_NETWORK_TIMEOUT`, 502 `PLUGIN_NETWORK_FAILED` /
`PLUGIN_NETWORK_TOO_MANY_REDIRECTS` / `PLUGIN_NETWORK_RESPONSE_TOO_LARGE`. CORS
allows the request header and exposes both response headers.

- The URL's origin must be in `network.allowed_origins` (403
  `PLUGIN_NETWORK_DENIED`); URLs carrying credentials are refused.
- Every hop's host is resolved once and the answers pinned for that hop's
  connection; a loopback, private, link-local or otherwise non-public address
  is refused (403 `PLUGIN_NETWORK_DENIED`) unless the origin's host is
  literally `localhost` or `127.0.0.1`. This closes DNS rebinding; an IP
  literal origin is held to the same rule. No proxy is used.
- Redirects are followed by hand, only within allowed origins (max 5), each
  hop re-checked; 303 (and 301/302 after a POST) become a body-less GET, and
  `Authorization` and secret-bearing headers never cross to another origin.
- Timeout 30 s, response ≤ 10 MiB, at most 4 requests in flight per plugin.
- `{{secret:<key>}}` placeholders in header values are replaced server-side
  with the plugin's secret config values; unknown secrets are a 400.
  Hop-by-hop and `cookie` headers are stripped from both directions.

### 4.6 Commands (`exec.run`)

`POST /api/plugin-tabs/self/exec` `{program, args?: string[], timeout_ms?}`
(plugin token) runs `program` for the tab:

- `program` must equal one of the granted manifest's `commands[].program`
  (403 `PLUGIN_EXEC_DENIED`), and is resolved on the service's `PATH` — the
  user's login-shell `PATH` (422 `PLUGIN_EXEC_NOT_FOUND`).
- No shell: `args` are passed as is (≤ 256, ≤ 128 KiB in total, no NUL). The
  working directory is the grant's conversation folder (its worktree, or the
  project folder without one).
- The same direct-exec policy as managed providers: `CADENCR_*` and `VITE_*`
  variables removed, CPU/memory limits, the whole process tree killed when the
  command times out (`timeout_ms` 1–120 000, default 30 000; 504
  `PLUGIN_EXEC_TIMEOUT`) or writes more than 1 MiB to a stream (502
  `PLUGIN_EXEC_OUTPUT_TOO_LARGE`). ≤ 4 commands at a time per tab (429
  `PLUGIN_EXEC_BUSY`); any other failure to run is 502 `PLUGIN_EXEC_FAILED`.
- 200 `{exit_code: number|null, success, stdout, stderr, duration_ms}` for any
  exit status; output is UTF-8, lossily decoded.

Every request — run, refused or failed — is recorded in memory for the tab
and conversation (program, arguments cut to 1 024 characters, outcome, exit
code, duration; the last 50) and shown to the user in the tab's **Activity**
dialog (`GET /api/plugin-tabs/{id}/activity`). A tab cannot read that log. The
renderer checks only a request's shape; every bound is the service's, so a
refused request is recorded too.

### 4.7 Native backend (`backend.request`)

`POST /api/plugin-tabs/self/backend` `{method, params?, timeout_ms?}` (plugin
token) relays one request to the tab's backend, starting it first if it is
not running. One backend runs per tab and conversation, shared by that
conversation's open instances. The stdio contract between Cadencr and the
backend is specified, normatively, in
[`TAB_BACKEND_PROTOCOL.md`](TAB_BACKEND_PROTOCOL.md); this section covers how
the service resolves, starts, relays to and stops it.

Protocol `1` keeps the HTTP broker path. Protocol `2` uses the authenticated
plugin socket for guest requests and subscriptions; the HTTP endpoint stays
available for backend compatibility. `backend.subscribe(topic, handler)`
resolves after registration, starting the process if necessary. Topics and
payloads belong to the plugin. Native events carry a host-owned `run_id` and
process-wide `seq`; the outer subscription sequence detects losses even when
only one native topic is selected.

The slot's native queue holds 64 events. A lagged receiver, process start or
stop owes a resync; process exit and invalid native events also yield visible
subscription errors. A subscription follows subsequent explicitly started
processes in the same slot. Neither the service nor broker replays a method
after disconnect, timeout or restart.

The broker also limits each guest subscription to 32 unacknowledged native
events on its `MessagePort`. The SDK acknowledges consumption automatically,
including duplicates and callbacks that throw. A stalled guest drops further
events and receives a resync when capacity returns. Repeated error and resync
notifications are coalesced until an event is acknowledged.
The guest's `streams.*` methods are for built-in topics; native subscriptions
use `backend.*`, including their consumption acknowledgements.

- 403 `PLUGIN_BACKEND_UNDECLARED` without a `backend` in the granted manifest.
- **Marketplace tabs.** A signed tab package ships its backend as one
  single-executable archive per platform (`tab.distribution.binary`); the
  installer downloads only this platform's, verifies it against the signed
  size and digests, and stores the executable (`0500`, read-only) at its
  `cmd` in the immutable revision, beside `backend.tar.gz`. A package without
  a binary for this platform is not installed (409
  `MANAGED_TAB_PLATFORM_UNSUPPORTED`), nor is one whose backend speaks a
  protocol, or ships for a platform, this Cadencr does not know (409
  `MANAGED_TAB_NEEDS_NEWER_APP`: a newer Cadencr may install it).
  Before each start the executable is hashed against its signed
  `executable_sha256` (409 `PLUGIN_BACKEND_TAMPERED` when it differs); a
  revision without this platform's binary is 422
  `PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM`, like a local tab's. A running
  backend holds its revision,
  so an update never removes the folder under it.
- **Revocation.** Marketplace tabs have their own signed blocklist feed
  (`CADENCR_MANAGED_TAB_BLOCKLIST_URL`, `kind: "tab-blocklist"`, see
  `MARKETPLACE_RELEASE_CONFIG.md`), refreshed at startup, every 10 minutes and
  on each tab catalog refresh; `GET /api/marketplace/tabs/policy` reports its
  state (`not_configured`, `fresh`, `stale`, `missing`). An entry matches by
  id, version range, archive or executable digest. A listed tab's summary is
  `status: "blocked"` with `blocked_reason` (effective off); its running
  backends are stopped first ("it was blocked" in Activity), then its grants
  are revoked, and its assets, grant mint, enablement, configuration and
  consent answer 403 `PLUGIN_TAB_BLOCKED`. Install and update of a listed
  revision are 409 `MANAGED_TAB_BLOCKED`; removing it stays allowed. Any
  authenticated cached policy blocks, even an expired one. When a feed is
  configured but no fresh policy is cached, install, update and backend start
  are 409 `MANAGED_TAB_POLICY_UNAVAILABLE` — the tab's page keeps working,
  and a backend already running keeps serving.
- **Binaries only.** A backend is a native executable shipped in the tab
  folder, one per platform — never a script, an interpreter or a program on
  `PATH`, so what the user consents to is that file. The former
  `command`/`args` launch line is refused (`BACKEND_COMMAND_REMOVED`, §3).
  Rust is the recommended language: the
  [`cadencr-tab-backend`](../packages/tab-backend-sdk-rs/) crate implements
  the protocol, so a backend is one handler function. Any toolchain that
  produces a native binary and implements the protocol works.
- **Manifest.** `"backend": {"reasoning", "protocol": 1, "binary": {…}}`,
  `binary` mapping a platform key — `darwin-aarch64`, `darwin-x86_64`,
  `linux-x86_64` — to a path relative to the tab folder (rules in §3).
- **Platform resolution.** The service runs the `binary` entry of the platform
  it was built for (`TabPlatform::current()`). A tab that declares none for
  it — or a Cadencr running where tab backends are not supported (Windows,
  Linux on ARM) — gets 422 `PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM` and
  nothing is spawned. The summary says so ahead of time:
  `backend_availability` is `available` (a binary is declared here, which may
  still be unbuilt or refused) or `unavailable_on_platform`.
- **Checks before every start** (`cadencr_plugin_core::tab::check_backend_binary`,
  shared with the folder inspection and `cadencr plugin validate`): the path
  must resolve — symlinks followed — to a regular, executable file inside
  the tab folder, native for the OS by its magic bytes: Mach-O, thin or
  universal, for Darwin; ELF for Linux. For `darwin-aarch64` its arm64 code
  must also carry a code signature (ad hoc is enough; the Apple linker, so
  `cargo build`, signs arm64 output by default), since macOS kills unsigned
  arm64 code on launch. Refusals: 422 `PLUGIN_BACKEND_NOT_NATIVE` (a `#!`
  script, a foreign format, a malformed Mach-O), 422
  `PLUGIN_BACKEND_UNSIGNED`, 422 `PLUGIN_BACKEND_UNAVAILABLE` (not built
  yet, not executable, outside the folder, its state folder cannot be
  created, or it cannot start; 503 while Cadencr is quitting). Each refusal
  is also written to the backend's log in Activity. A refused start spawns
  nothing, but checks (and, for a marketplace tab, hashes) the binary again:
  after 3 refusals within 60 s the next starts are answered 503
  `PLUGIN_BACKEND_START_FAILING` without checking, until the oldest refusal
  ages out of the window or the user allows a restart from the Activity
  dialog. The Activity status (`GET …/activity`, `backend`) names the last
  refusal (`start_error`) and says when starts are held (`restart_held`: this,
  a crash loop or a protocol mismatch), which is when the dialog offers
  **Allow restart**. These checks run off the supervisor's
  lock: a slow one holds up only that tab in that conversation.
- **Process.** No shell, no arguments; working directory = the tab folder
  (canonical). The backend must treat that folder as read-only: a
  marketplace tab's is an immutable revision, published read-only even for
  its owner (folders and executables `0500`, other files `0400`; retention
  restores the owner's write bit on the folders it has proven are its own
  before reclaiming them). Its writable place is
  `state_dir`, sent in `hello`: `~/.cadencr/plugins/tab-state/<plugin_id>`,
  outside the tab folder, created with mode `0700` before the backend starts
  and kept across runs and updates. It is per tab, not per conversation: the
  tab's backends in other conversations see the same folder and must
  coordinate. The same direct-exec policy as §4.6 applies (no
  `CADENCR_*`/`VITE_*` variables, the memory limit, its own process tree,
  owned and terminated with it) except the CPU-time limit: a backend lives
  as long as its tab stays open, for days if need be, and `exec.run`'s
  one-hour CPU ceiling would kill a busy one.
- **Handshake.** The host writes `hello` (the conversation, its folder,
  `state_dir`, the scopes and the backend's own API token) and requires
  `{"type":"ready","protocol":<backend.protocol>}` as the first stdout line
  within 5 s; no request is written before it. (Host leniency: the first
  start of a given binary file in a Cadencr process — a new install, a
  rebuild — gets 20 s, since macOS assesses a freshly written executable on
  its first launch; authors must still meet 5 s.) No `ready` in time is 504
  `PLUGIN_BACKEND_NOT_READY`; the process is stopped and the run counts as a
  crash. Any other first line or protocol is 502
  `PLUGIN_BACKEND_PROTOCOL_MISMATCH`: the process is stopped, and since the
  same binary would fail the same way, no further start is attempted until
  the user allows a restart from the Activity dialog
  (`DELETE …/backends/{feature_id}`).
- **Requests.** `{"type":"request","id":"<n>","method","params"}` lines;
  `{"type":"response","id","result"|"error"}` lines back, in any order. Any
  other stdout line is ignored and noted in the log; a line over 4 MiB is
  dropped. stderr is the log: the last 200 lines are kept and shown in
  Activity.
- **Its own Cadencr access.** `api.token` is a grant minted for the backend:
  the tab's consented scopes, bound to the conversation and its project,
  checked by the same policy table (§4.3, §6.1). It is never the main token,
  is passed on stdin (never in arguments or the environment), lives as long
  as the process — however long that is — and is revoked when it stops.
- **Answers.** 200 `{result}` or `{error: {code, message}}` — the backend's
  own error, passed through. Relay failures: 429 `PLUGIN_BACKEND_BUSY` (≤ 16
  in flight), 504 `PLUGIN_BACKEND_TIMEOUT` (`timeout_ms` 1–120 000, default
  30 000, counted from the request, the whole start of a backend not yet
  running included), 502 `PLUGIN_BACKEND_EXITED` (it exited before answering). 400
  for a `method` outside 1–128 chars or `params` over 1 MiB of JSON.
- **Lifecycle.** An open instance of a tab with a backend holds a presence
  lease (`PUT /api/plugin-tabs/{id}/presence/{lease_id}` `{feature_id}`, main
  token). The desktop window holds one per open tab instance (conversation
  and tab) — owned by the tab strip, not by the tab's on-screen view: taken
  when the tab is placed, renewed every minute while it stays in its
  conversation's tab strip — shown or hidden, its conversation on screen or
  not (another conversation, Settings), idle or not — and released (`DELETE`)
  when the tab is closed, or once it may not run (turned off, blocked,
  removed, invalid, no build for this platform). Deleting a conversation
  (or its project) or archiving it releases every lease held in it, from
  every client. A window that still shows it gets no error: once it is
  deleted, a renewal answers 404 `PLUGIN_TAB_CONVERSATION_NOT_FOUND` and the
  desktop stops renewing; while it is archived, renewals answer 409
  `PLUGIN_TAB_CONVERSATION_ARCHIVED` and go on, so unarchiving it takes the
  lease back within a minute. After a restart, a
  conversation's tabs take theirs when its saved layout is first loaded (its
  first visit, which precedes any backend use); unrenewed, a lease lapses
  after 3 minutes, so a window that quits leaves none behind. The
  backend is stopped (stdin closed, then its process tree terminated after
  2 s) when no instance of the tab has held a lease in its conversation for
  30 s (checked every 10 s: 30–50 s after the tab closes in practice), when
  its grant is revoked (permissions changed, tab turned off or removed), when
  an accepted update replaces its revision, or from the Activity dialog; the
  Activity says which (`exit_reason`: "its tab was closed", "its permissions
  changed", "its tab was updated", "stopped from the tab's Activity", "its
  tab was removed", "exited with status N",
  …). Removing a marketplace tab stops its backends and waits for them to
  exit, so its revision is reclaimed; one still running then releases it
  when it exits. Exiting with status 0 after `ready` is a normal stop; a
  non-zero status, a signal Cadencr did not send, or exiting before `ready`
  (whatever the status) is a crash. After 3 crashes within a minute it is not restarted (503
  `PLUGIN_BACKEND_CRASHING`) until the user clears it from the Activity
  dialog (`DELETE …/backends/{feature_id}`).
- **Consent.** The permissions hash (§3) covers the backend as
  `{"protocol", "binary": {<platform>: <path>}}`: declaring a backend,
  changing its protocol, or adding or moving a platform's binary asks for
  consent again; its `reasoning` does not. A local tab's binaries are
  identified by path only — the user consents to whatever its author builds
  there, so a rebuild at the same path does not ask again. A marketplace
  tab's hash also covers its signed binary for the platform Cadencr runs on,
  as `"digests": {<platform>: <executable_sha256>}` beside `binary` (omitted
  for local tabs, which keep their hash; a manifest cannot declare it, the
  `backend` object is closed): a new binary asks again, a rebuild of another
  platform's does not. An update that changes the hash of a tab the user
  accepted is **staged** beside the installed revision, which keeps running:
  the summary's `pending_update` lists what it would run (its
  `backend_binary` — `platform`, `protocol`, `executable_sha256` — beside the
  summary's own `backend_binary`, the installed one, so a binary-only update
  shows what changed), consenting to its
  `permissions_hash` (`PUT …/consent`) promotes it and restarts the backend
  on it, and `DELETE /api/marketplace/tabs/{id}/pending` discards it.
- **Validation.** `cadencr plugin validate <folder> --kind tab` reports every
  platform's binary that is missing or not native, then runs this platform's
  built binary through `cadencr_tab_backend::conformance` (the tab folder as
  working directory, a temporary `state_dir`): `ready`, an error response
  for an unknown method, survival of malformed lines, two concurrent
  requests, exit with status 0 within 2 s of stdin closing, and a clean
  stdout. A failed check fails the command with
  `TAB_BACKEND_CONFORMANCE_FAILED` (the failed checks, the full report and
  the backend's last stderr lines); an unbuilt binary stays a
  `BACKEND_UNAVAILABLE` warning. `--no-run` skips the run, for machines that
  cannot execute the binary.

| Code                                     | Status | When                                                            |
| ---------------------------------------- | ------ | --------------------------------------------------------------- |
| `PLUGIN_BACKEND_UNDECLARED`              | 403    | The granted manifest has no `backend`.                          |
| `PLUGIN_BACKEND_TAMPERED`                | 409    | A marketplace binary that differs from its signed digest.       |
| `PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM` | 422    | No binary for this platform (declared or installed).            |
| `PLUGIN_BACKEND_NOT_NATIVE`              | 422    | A script, a foreign format or a malformed Mach-O.               |
| `PLUGIN_BACKEND_UNSIGNED`                | 422    | Unsigned arm64 code on Apple silicon.                           |
| `PLUGIN_BACKEND_UNAVAILABLE`             | 422    | Missing, not executable, outside the folder, cannot start.      |
| `PLUGIN_BACKEND_NOT_READY`               | 504    | No `ready` within 5 s (20 s on a first start); a crash.         |
| `PLUGIN_BACKEND_PROTOCOL_MISMATCH`       | 502    | Wrong first line or protocol; no start until reset in Activity. |
| `PLUGIN_BACKEND_EXITED`                  | 502    | It exited before answering.                                     |
| `PLUGIN_BACKEND_CRASHING`                | 503    | 3 crashes within 60 s; no start until reset in Activity.        |
| `PLUGIN_BACKEND_START_FAILING`           | 503    | 3 refused starts within 60 s; none checked until one ages out.  |
| `PLUGIN_BACKEND_BUSY`                    | 429    | 16 requests already in flight.                                  |
| `PLUGIN_BACKEND_TIMEOUT`                 | 504    | No answer within `timeout_ms`.                                  |
| `PLUGIN_TAB_BLOCKED`                     | 403    | The tab is on the signed tab blocklist.                         |
| `MANAGED_TAB_POLICY_UNAVAILABLE`         | 409    | A blocklist feed is configured but no fresh policy is cached.   |

The backend is **not sandboxed**: it can do anything the user can. The policy
table bounds only what it can reach _through Cadencr_.

## 5. Electron host

### 5.1 Guest views

- Scheme `cadencr-tab` registered privileged (`standard`, `secure`,
  `supportFetchAPI`, `stream`) before `app.ready`.
- One `WebContentsView` per instance, partition `persist:cadencr-tab:<id>`,
  `sandbox`, `contextIsolation`, no Node, `webSecurity`, no `webviewTag`, a
  minimal preload (`electron/preload/plugin-tab.ts`) that only forwards the
  port.
- The partition's `protocol.handle('cadencr-tab')` serves only
  `cadencr-tab://<own id>/…` by relaying to `GET /api/plugin-tabs/{id}/assets/…`.
- Denied: permission requests and checks, `window.open`, navigation away from
  `cadencr-tab://<id>/`, any non-`cadencr-tab:`/`devtools:` request
  (`webRequest`), downloads, WebRTC non-proxied UDP.
- `setBackgroundColor(theme background)`; theme CSS injected with `insertCSS`
  before first paint and replaced on change.
- Bounds come from a renderer placeholder element (same math as the browser
  tab: zoomed CSS px → DIP). Views are hidden while a React overlay suppresses
  native views (`useSuppressBrowserView`).
- At most 6 live guests; the least recently shown hidden guest is destroyed and
  recreated on demand. `state` (§7) survives recreation.
- A crashed guest shows a placeholder with **Reload**; only `reload` recreates
  it. An entry document answering HTTP ≥ 400 is reported as `load-failed` and
  never receives a port.
- Instance ids match `^[A-Za-z0-9_.:-]{1,200}$`. The renderer bridge is
  `desktopBridge.pluginTabs` (`open`, `setBounds`, `setVisible`, `reload`,
  `close`, `openDevTools`, `focus`, `setTheme`, `setAppShortcuts`,
  `setTabShortcuts`, `onEvent`, `onAppShortcut`); shared types live in
  `packages/desktop/src/shared/plugin-tab-host.ts`.
- **Keyboard.** A focused guest receives its keys before the renderer, so
  the main process matches each key down first (`before-input-event`,
  `plugin-tab-shortcuts.ts`), with the renderer's layout-aware matcher:
  1. Cadencr's shortcuts win. Every shortcut of the `global`, `feature` and
     `feature-panes` scopes holding `mod`, `ctrl` or `alt`, as currently
     bound (`setAppShortcuts`, `lib/plugin-tabs/tab-shortcuts.ts`), is taken
     from the page: focus returns to the renderer, which dispatches the same
     key from its body, so it runs exactly as if pressed there. `⌘Q` stays
     with the application menu.
  2. The tab's own `shortcuts` (`setTabShortcuts`, per instance) are taken
     from the page too and delivered to it as a `shortcut {id}` event (§7).
     One on the same keys as a Cadencr shortcut never fires: it is left out
     of `hello.shortcuts`, and Settings → Custom tabs lists it as not
     available, naming the Cadencr shortcut. The cheatsheet (`⌘⇧?`) lists
     the active ones of the current project's tabs.
  3. Every other key reaches the page.

### 5.2 Asset responses

The entry is requested as `GET /api/plugin-tabs/{id}/assets/` (empty path).
The Electron relay re-applies the CSP and `nosniff` if a response lacks them;
a CSP header on a `protocol.handle` response is enforced by Electron 42 (verified
2026-10-17). The service sets `Content-Type`, `X-Content-Type-Options: nosniff`, and

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none';
  form-action 'none'
```

Paths resolve under the **web root** — the directory holding `entry` (usually
`dist/`) — with realpath containment, so a bundle's relative URLs work and
sources or `tab.json` are never reachable; dot-files and `node_modules` are
never served.

### 5.3 Port bootstrap

On every guest load the main process creates a `MessageChannelMain`, sends one
end to the guest (`cadencr-tab:port`) and the other to the main window
(`plugin-tab:port`, `{instanceId}`), after the guest's `load` event. Both
preloads forward their end to their page with `window.postMessage` — the guest
receives `{type: "cadencr-tab:port"}`, the renderer `{type:
"cadencr-plugin-tab:port", instanceId}` (check `event.source === window`). The
SDK listens from module evaluation so an early port is never missed. Theme CSS
is inserted by the guest preload (`webFrame.insertCSS`) before the first
script runs. The broker replaces any previous port for that
instance and waits for `hello`.

## 6. Scopes

| Scope            | Grants                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| `features:read`  | The bound project and feature, their features list, feature events.    |
| `git:read`       | Status, diff, log, branches of the bound feature; `git.status` stream. |
| `forge:read`     | PR/MR status of the bound feature; `forge.status` stream.              |
| `files:read`     | File tree and file contents in the bound worktree; `files.changes`.    |
| `agent:observe`  | Agent session history of the bound feature; `session.stream`.          |
| `workspace:read` | Projects and features across the workspace; `session.status`.          |

Always available, no scope: context, theme, `state`, `storage`, `config`,
`ui.*`. `net.fetch` requires `network.allowed_origins`, `exec.run` a listed
program in `commands`, `backend.request` a `backend`.

### 6.1 Policy table (v1)

The entries of `domain/plugin_tabs/policy.rs`, in order; every one is tier
`proposed`. A route listed twice passes when either entry holds. On any bound
entry, every `feature_id` / `project_id` query parameter present must also
name the grant's.

| Method | Path                                         | Scope            | Binding                  |
| ------ | -------------------------------------------- | ---------------- | ------------------------ |
| GET    | `/api/features/{id}`                         | `features:read`  | FeaturePath(id)          |
| GET    | `/api/features/{id}/working-dir`             | `features:read`  | FeaturePath(id)          |
| GET    | `/api/features`                              | `features:read`  | ProjectQuery(project_id) |
| GET    | `/api/features/activity`                     | `features:read`  | ProjectQuery(project_id) |
| GET    | `/api/git/status`                            | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/diff`                              | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/file-diff`                         | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/changed-files`                     | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/uncommitted-files`                 | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/stats`                             | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/commit-log`                        | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/commit-graph`                      | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/file-content`                      | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/blame`                             | `git:read`       | FeatureQuery(feature_id) |
| GET    | `/api/git/branches`                          | `git:read`       | ProjectQuery(project_id) |
| GET    | `/api/git/branch`                            | `git:read`       | ProjectQuery(project_id) |
| GET    | `/api/git/pr`                                | `forge:read`     | FeatureQuery(feature_id) |
| GET    | `/api/git/pr/comments`                       | `forge:read`     | FeatureQuery(feature_id) |
| GET    | `/api/editor/root`                           | `files:read`     | FeatureQuery(feature_id) |
| GET    | `/api/editor/tree`                           | `files:read`     | FeatureQuery(feature_id) |
| GET    | `/api/editor/tree-all`                       | `files:read`     | FeatureQuery(feature_id) |
| GET    | `/api/editor/tree-count`                     | `files:read`     | FeatureQuery(feature_id) |
| GET    | `/api/editor/read`                           | `files:read`     | FeatureQuery(feature_id) |
| GET    | `/api/editor/search`                         | `files:read`     | FeatureQuery(feature_id) |
| GET    | `/api/editor/content-search`                 | `files:read`     | FeatureQuery(feature_id) |
| GET    | `/api/features/{feature_id}/sessions`        | `agent:observe`  | FeaturePath(feature_id)  |
| GET    | `/api/features/{feature_id}/agent-state`     | `agent:observe`  | FeaturePath(feature_id)  |
| GET    | `/api/features/{feature_id}/message-preview` | `agent:observe`  | FeaturePath(feature_id)  |
| GET    | `/api/features/{feature_id}/row-summary`     | `agent:observe`  | FeaturePath(feature_id)  |
| GET    | `/api/features/{id}/pending-gate`            | `agent:observe`  | FeaturePath(id)          |
| GET    | `/api/projects`                              | `workspace:read` | Unbound                  |
| GET    | `/api/features`                              | `workspace:read` | Unbound                  |
| GET    | `/api/features/activity`                     | `workspace:read` | Unbound                  |
| GET    | `/api/features/recent`                       | `workspace:read` | Unbound                  |
| GET    | `/api/features/active`                       | `workspace:read` | Unbound                  |
| GET    | `/api/features/pinned`                       | `workspace:read` | Unbound                  |
| GET    | `/api/plugin-tabs/self/configuration`        | —                | SelfPlugin               |
| GET    | `/api/plugin-tabs/self/storage`              | —                | SelfPlugin               |
| GET    | `/api/plugin-tabs/self/storage/{key}`        | —                | SelfPlugin               |
| PUT    | `/api/plugin-tabs/self/storage/{key}`        | —                | SelfPlugin               |
| DELETE | `/api/plugin-tabs/self/storage/{key}`        | —                | SelfPlugin               |
| POST   | `/api/plugin-tabs/self/net/fetch`            | —                | SelfPlugin               |
| POST   | `/api/plugin-tabs/self/exec`                 | —                | SelfPlugin               |
| POST   | `/api/plugin-tabs/self/backend`              | —                | SelfPlugin               |
| DELETE | `/api/plugin-tabs/grants/current`            | —                | SelfPlugin               |

### 6.2 Levels

What a tab may do is the union of its manifest's declarations, summarized as
one level (`TabAccessLevel`, `access_level` in the summary) that every surface
names the same way:

| Level         | `access_level` | Declares                         | What Cadencr enforces                                                                                   | What it does not                                                    |
| ------------- | -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Read-only     | `ui`           | neither `commands` nor `backend` | Everything: the guest has no network or process of its own; every byte goes through the policy table.   | —                                                                   |
| Runs commands | `commands`     | `commands`                       | Only the listed programs run, without a shell, in the conversation's folder, bounded and logged (§4.6). | What a listed program does with the arguments the tab chooses.      |
| Native code   | `backend`      | `backend`                        | Its Cadencr access (own grant, scopes, binding); its lifecycle (§4.7).                                  | Anything else: it runs with the user's rights, outside any sandbox. |

The user is told at every step:

- **Consent** (Settings): the dialog leads with the level, lists the programs
  with their reasons and what running them means, and for native code shows
  the backend's binaries, says it is not sandboxed, and requires ticking "I trust
  this code to run on my computer with my rights" before **Allow**.
- **Settings card**: a level badge (Read-only / Runs commands / Native code)
  beside the status badge; the permissions block repeats the consent lists.
- **Tab strip**: a terminal glyph (commands) or a chip glyph (native code) on
  the tab trigger and in the **+** menu.
- **Activity** (**+** menu → **Activity…** on a focused commands or native
  tab): every command run or refused in this conversation, and the backend's
  state, pid, exit reason and stderr tail, with **Stop**.
- `cadencr plugin validate --kind tab` prints the level, and fails when this
  platform's built backend does not pass the protocol conformance checks
  (§4.7).

A marketplace tab may declare `commands` and a native `backend`. Its install
screen says it runs native code with the user's rights, with the backend's
`reasoning` and the platforms it ships for; the Enable consent dialog keeps
the native-code checkbox. An update that would run something new waits for
review (§4.7) instead of replacing the accepted revision.

## 7. Wire protocol (guest ⇄ broker)

The broker mints a grant when a guest says `hello`, replaces it lazily when it
is within two minutes of expiry (grants live 15 minutes), re-mints once after a
401, and releases it when the guest is recycled, crashes or closes. It caps
`api.request` and `net.fetch` bodies at 2 MiB and never parses plugin payloads:
response bodies travel as transferred `ArrayBuffer`s.

Structured-clone objects over the `MessagePort`, `v: 1`.

```ts
type GuestToHost = { v: 1; kind: "request"; id: string; method: string; params?: unknown };
type HostToGuest =
  | { v: 1; kind: "response"; id: string; result: unknown }
  | {
      v: 1;
      kind: "response";
      id: string;
      error: { code: string; message: string; details?: unknown };
    }
  | { v: 1; kind: "event"; event: string; payload: unknown };
```

| Method                                                            | Params → result                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`                                                           | `{sdkVersion, apiVersions:[min,max]}` → `{apiVersion, instanceId, plugin:{id,version}, context, theme, capabilities: string[], visible}` |
| `api.request`                                                     | `{method, path, query?: Record<string,string>, body?: string (JSON text)}` → `{status, headers, body: ArrayBuffer\|null}`                |
| `streams.subscribe`                                               | `{topic, params?}` → `{subscriptionId}`                                                                                                  |
| `streams.unsubscribe`                                             | `{subscriptionId}` → `null`                                                                                                              |
| `storage.get` / `storage.set` / `storage.delete` / `storage.list` | `{key}` / `{key, value}` / `{key}` / `{}`                                                                                                |
| `state.get` / `state.set`                                         | `{}` → `unknown` / `{value}` (per instance, host memory, ≤ 1 MiB)                                                                        |
| `config.get`                                                      | `{}` → `Record<string, unknown>`                                                                                                         |
| `net.fetch`                                                       | `{url, method?, headers?, body?: ArrayBuffer}` → `{status, headers, body: ArrayBuffer}`                                                  |
| `exec.run`                                                        | `{program, args?, timeoutMs?}` → `{exitCode: number\|null, success, stdout, stderr, durationMs}` (§4.6)                                  |
| `backend.request`                                                 | `{method, params?, timeoutMs?}` → `{result?}` or `{error?: {code, message}}` — the backend's own answer (§4.7)                           |
| `backend.subscribe`                                               | `{topic}` → `{subscriptionId}`; requires native protocol 2                                                                               |
| `backend.unsubscribe`                                             | `{subscriptionId}` → `null`                                                                                                              |
| `backend.ack`                                                     | `{subscriptionId, seq}` → `null`; internal SDK consumption acknowledgement                                                               |
| `ui.toast`                                                        | `{title, description?, variant?: "default"\|"success"\|"error"}`                                                                         |
| `ui.openExternal`                                                 | `{url}` — `https:` only, after a host confirmation                                                                                       |
| `ui.setBadge`                                                     | `{text: string\|null}` — ≤ 4 chars, shown on the tab trigger                                                                             |

`storage.get`/`state.get` return `null` when empty, `storage.list` returns
`string[]`; `ui.*`, `storage.set/delete`, `state.set` and
`streams.unsubscribe` return `null`. The broker must accept a repeated `hello`
on the same port (React StrictMode re-mounts). The SDK sets
`data-cadencr-theme`, `data-appearance` and `color-scheme` on `<html>`.

Events: `context.changed {context}`, `theme.changed {theme}`,
`visibility.changed {visible}`, `stream.event {subscriptionId, seq, data:
{domain, action, payload}}`, `stream.resync {subscriptionId}` (the plugin
should refetch), `stream.error {subscriptionId, error}`, `shortcut {id}` (one
of the manifest's `shortcuts`, pressed while the tab had focus; §5.1). Events
are additive: a guest ignores one it does not know (`@cadencr/tab-sdk` from
0.2; 0.1 reports it as a `HOST_ERROR`). `hello` also answers `shortcuts`: the
ids of the manifest's shortcuts that can fire.

The shared surface host adds optional handshake fields:

```ts
surface: { kind: "tab" | "editor"; instanceId: string };
focused: boolean;
editorAppearance?: { fontFamily: string; fontSize: number }; // CSS pixels
```

Capabilities `surface.identity`, `surface.focus` and `editor.appearance` announce
these fields. The SDK exposes `client.surface`, `client.focused`,
`client.editorAppearance`, `onFocusChange` and `onEditorAppearanceChange`.
The latter field is limited to the monospace font family and code font size;
it provides no access to arbitrary host settings. Changes arrive as
`focus.changed {focused}` and `editor.appearance.changed {appearance}`.
Hiding, suppressing or destroying a surface clears its focus. Each handshake
returns current values, including for hidden/recycled guests. On older hosts,
the SDK falls back to a tab identity, `focused=false` and no editor appearance.

Native guest events are `backend.event {subscriptionId, topic, runId, seq,
processSeq, payload}`, `backend.resync {subscriptionId}` and `backend.error
{subscriptionId, error}`. `seq` increases per subscription across socket
reconnects, while `processSeq` is the backend process's sequence. The SDK
calls `onResync` on a gap, reconnect or changed `runId`. `hello.capabilities`
announces `backend.subscribe`, `backend.unsubscribe` and `backend.ack` only for protocol 2.
An SDK on an older host rejects subscription with `CAPABILITY_DENIED`.

Error codes: `PLUGIN_API_UNSUPPORTED`, `CAPABILITY_DENIED`,
`PLUGIN_SCOPE_DENIED`, `PLUGIN_BINDING_DENIED`, `PLUGIN_NETWORK_DENIED`,
`PLUGIN_EXEC_DENIED`, `PLUGIN_BACKEND_UNDECLARED`, `NOT_FOUND`, `BAD_REQUEST`,
`TIMEOUT`, `DISCONNECTED`, `HOST_ERROR` — plus the service codes of §4.6/§4.7
passed through. `hello.capabilities` lists `net.fetch`, `exec.run` and
`backend.request` only when the manifest declares origins, commands or a
backend.

```ts
interface TabContext {
  project: { id: number; name: string; path: string };
  feature: {
    id: number;
    name: string;
    branch: string | null;
    baseBranch: string | null;
    worktreePath: string | null;
  };
  pullRequest: { number: number; url: string; state: string; title: string | null } | null;
  session: { id: number | null; provider: string | null; status: string | null } | null;
}
interface ThemeSnapshot {
  id: string;
  appearance: "light" | "dark";
  tokens: Record<string, string>; // "background" → "#0f1115" (no leading "--")
}
```

## 8. Authoring

**Settings → Custom tabs → Create** asks for a name, then the service:

1. derives the id (`slugify`, unique), creates `~/.cadencr/plugins/tabs/<id>/`,
   `git init`, writes the scaffold, commits;
2. records consent for the scaffold's permissions and marks the setup pending;
3. creates a project (`authoring_target='tab'`, `plugin_id=<id>`), a feature
   with `worktree_mode=skip`, and a conversation;
4. enables the tab for that project, which settles the pending setup.

If steps 2–4 fail, the folder stays and `POST /api/plugin-tabs/{id}/workspace`
("Retry setup") finishes them: it opens the project and, for a tab whose setup
is still pending at its current permissions, enables it there. Any on, off or
Inherit choice settles the setup, so opening the project later never overrides
it. A folder copied in by hand never had a pending setup and stays off.

The scaffold is a Vite + React + Tailwind v4 app depending on
`@cadencr/tab-sdk` and `@cadencr/tab-kit` (vendored tarballs under `vendor/`
until the packages are on npm), with `INSTRUCTION.md`, `AGENTS.md` and
`CLAUDE.md` telling the author's agent the contract, and `npm run build` /
`npm run dev` (`vite build --watch`). Every change to `tab.json` or to the
folder holding `entry` (`dist/` in the scaffold) reloads live instances.

## 9. SDK and kit

- `@cadencr/tab-sdk` (`packages/tab-sdk`): `connect()`, context, theme,
  `api` (+ a generated, typed client of the plugin surface), `streams`,
  `storage`, `state`, `config`, `net.fetch`, `ui`, `capabilities`,
  `onShortcut`/`shortcuts` (React: `useShortcut(id, handler)`); React
  bindings in `@cadencr/tab-sdk/react`; a fake host in
  `@cadencr/tab-sdk/testing`; the wire types in `@cadencr/tab-sdk/protocol`
  (imported by the renderer broker). No runtime dependencies.
- `@cadencr/tab-kit` (`packages/tab-kit`): `tokens.css` (default values),
  `preset.css` (Tailwind v4 `@theme inline` mapping onto `--cadencr-*`), Inter
  (the desktop UI face), React components built from
  `packages/desktop/src/components/ui` (no fork), and a few kit-native layout
  primitives desktop has no equivalent for (`Card*`, `Label`, `EmptyState`). Peer dependencies: `react`, `react-dom`.

Both are versioned independently of the app (0.x) and target public npm with
trusted publishing; nothing is published without the maintainer's approval.
