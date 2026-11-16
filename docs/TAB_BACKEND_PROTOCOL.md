# Custom tab backend protocol — version 1

> **Status:** normative. This document is the contract between Cadencr (the
> _host_) and the native backend of a custom tab (the _backend_). Anything
> that implements it works, in any language. The Rust crate
> [`cadencr-tab-backend`](../packages/tab-backend-sdk-rs/) is a helper that
> implements it, not part of the contract.
>
> Context: [`CUSTOM_TABS.md`](CUSTOM_TABS.md) §4.7 (how the tab's web UI calls
> its backend, lifecycle, permissions).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Overview

A custom tab may ship one native executable per platform. Cadencr starts it
— once per tab and conversation, on the first `backend.request` — and talks
to it over its standard streams:

```
host  ──stdin──▶  backend     hello, then requests
host  ◀─stdout──  backend     ready, then responses
host  ◀─stderr──  backend     free-form log
```

```
host → {"type":"hello","protocol":1, …}
host ← {"type":"ready","protocol":1}                          (≤ 5 s after hello)
host → {"type":"request","id":"1","method":"slow","params":{}}
host → {"type":"request","id":"2","method":"fast","params":null}
host ← {"type":"response","id":"2","result":42}               (any order)
host ← {"type":"response","id":"1","error":{"code":"NOPE","message":"…"}}
host closes stdin                                              → backend exits (≤ 2 s)
```

## 2. The executable

### 2.1 Manifest

The tab's `tab.json` declares the backend:

```json
"backend": {
  "reasoning": "Why this tab needs native code, shown to the user at consent",
  "protocol": 1,
  "binary": {
    "darwin-aarch64": "bin/darwin-aarch64/my-backend",
    "darwin-x86_64": "bin/darwin-x86_64/my-backend",
    "linux-x86_64": "bin/linux-x86_64/my-backend"
  }
}
```

- `protocol` (integer, required) is the protocol version the backend speaks.
  The host sends this version in `hello` and requires the same in `ready`. A
  host refuses a manifest naming a version it does not implement.
- `binary` (object, required) maps a platform key to a path. v1 platform keys:
  `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`. A tab MAY omit
  platforms; its backend is then unavailable there. Paths are relative to the
  tab folder, use `/`, and MUST stay inside it.

### 2.2 Native binaries only

- The file for a platform MUST be a native executable for that platform:
  **Mach-O** (thin or universal) on macOS, **ELF** on Linux, with its
  executable bit set.
- It MUST hold code for the platform's CPU: a 64-bit little-endian x86_64
  ELF (`e_machine` 62) for `linux-x86_64`, an x86_64 image for
  `darwin-x86_64`, an arm64 image for `darwin-aarch64`. A universal file
  MUST contain the platform's slice; an Intel-only file is refused for
  `darwin-aarch64` (the host does not rely on Rosetta).
- Scripts are refused, including any file starting with `#!`. Programs looked
  up on `PATH` are refused. There is no interpreter, shell or argument list:
  the host executes the file directly with no arguments.
- A **`darwin-aarch64` binary MUST carry a code signature.** An ad-hoc
  signature is enough (`codesign -s - <file>`); the Apple linker, and so
  `cargo build`, signs arm64 binaries ad hoc by default, but tools that
  rewrite the file afterwards (some `strip` invocations, patchers) may
  invalidate it — re-sign after them. The host refuses an unsigned arm64
  binary, and checks **every** arm64 slice of a universal file (e.g. both
  `arm64` and `arm64e`).
- Rust is the recommended language (the helper crate exists for it), but any
  toolchain producing a native binary is allowed (Go, Zig, C, C++, …).

### 2.3 Environment

| Aspect | Value |
|---|---|
| Working directory | The tab folder (canonical path). **Never write to it**: for marketplace tabs it is an immutable revision, published read-only (folders and executables `0500`, files `0400`), so writes fail. |
| Writable state | `hello.state_dir` only (§4.1). |
| Arguments | None. |
| Environment variables | Inherited from the Cadencr service, minus every variable whose name starts with `CADENCR_` or `VITE_` (case-insensitive). Nothing is added: the API token is never in the environment or the arguments. |
| stdin / stdout / stderr | Pipes to the host. |
| Process tree | The backend runs in its own process group, owned by the host and terminated with it (children included). |
| Resource limits | Address space 16 GiB (Linux only). No CPU-time limit: a backend may run for as long as its tab stays open. |
| Sandbox | **None.** The backend can do anything the user can. The scopes bound only what it can do _through the Cadencr API_. |

A backend MUST NOT depend on any other inherited variable being present.

## 3. Framing

- Each stream direction carries **UTF-8 JSON**, **one JSON object per line**,
  each line terminated by `\n` (U+000A). A `\r` before the `\n` is tolerated and dropped, on stdout and in
  stderr log lines alike.
  JSON never contains a raw newline (strings escape it as `\n`), so a line is
  exactly one message.
- Lines are not pretty-printed. Empty lines MUST NOT be sent.
- **Maximum line size: 4 MiB** (4 194 304 bytes, excluding the `\n`) on
  stdout. The host drops a longer line (noting it in the log); its request is
  then never answered and times out. A first line over the limit fails the
  handshake (§4.2).
- Host lines: `hello` is small; a `request` line carries `params` of at most
  1 MiB of JSON and a `method` of 1–128 characters. A backend SHOULD accept
  input lines of up to 4 MiB.
- Every message has a string member `type`. Receivers MUST ignore members they
  do not know.
- Writes of one message MUST be atomic with respect to other messages: a
  backend writing from several threads MUST NOT interleave two lines.

## 4. Messages

### 4.1 `hello` (host → backend, first stdin line)

Exactly once, before anything else.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | `"hello"` | yes | |
| `protocol` | integer | yes | The protocol version (the manifest's `backend.protocol`). |
| `plugin.id` | string | yes | The tab's id. |
| `plugin.version` | string | yes | The tab's version. |
| `project_id` | integer | yes | The Cadencr project of the conversation served. |
| `feature_id` | integer | yes | The conversation served (a Cadencr "feature"). |
| `worktree` | string | yes | Absolute path of the conversation's folder (its git worktree, or the project folder). |
| `state_dir` | string | yes | Absolute path of the tab's writable state directory. Created by the host (mode `0700`) before the backend starts and kept across runs and updates; the host never deletes it, not even when the tab is removed. It is **per tab, not per conversation**: the tab's backends for other conversations may run at the same time and see the same directory, so a backend MUST coordinate (for example, a sub-folder per `feature_id`, or file locks). |
| `scopes` | array of strings | yes | The scopes the user granted the tab, e.g. `"features:read"`. |
| `api.base_url` | string | yes | `http://127.0.0.1:<port>`, no trailing slash. |
| `api.token_header` | string | yes | The header to send the token in: `x-cadencr-plugin-token`. |
| `api.token` | string | yes | The backend's own grant (§7). A secret: never log it. |

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["type", "protocol", "plugin", "project_id", "feature_id", "worktree", "state_dir", "scopes", "api"],
  "properties": {
    "type": { "const": "hello" },
    "protocol": { "type": "integer", "minimum": 1 },
    "plugin": {
      "type": "object",
      "required": ["id", "version"],
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "version": { "type": "string", "minLength": 1 }
      }
    },
    "project_id": { "type": "integer" },
    "feature_id": { "type": "integer" },
    "worktree": { "type": "string", "minLength": 1 },
    "state_dir": { "type": "string", "minLength": 1 },
    "scopes": { "type": "array", "items": { "type": "string" } },
    "api": {
      "type": "object",
      "required": ["base_url", "token_header", "token"],
      "properties": {
        "base_url": { "type": "string", "pattern": "^http://" },
        "token_header": { "type": "string", "minLength": 1 },
        "token": { "type": "string", "minLength": 1 }
      }
    }
  }
}
```

A backend that receives a first line that is not a `hello`, or a `hello`
whose `protocol` it does not speak, MUST write a message to stderr and exit
with a non-zero status without writing to stdout.

### 4.2 `ready` (backend → host, first stdout line)

The backend's answer to `hello`: it is initialised and accepts requests.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | `"ready"` | yes | |
| `protocol` | integer | yes | MUST equal `hello.protocol`. |
| `sdk` | string | no | Free-form `name/version` of the library or program, for diagnostics (e.g. `cadencr-tab-backend/0.1.0`). |

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["type", "protocol"],
  "properties": {
    "type": { "const": "ready" },
    "protocol": { "type": "integer", "minimum": 1 },
    "sdk": { "type": "string" }
  }
}
```

- `ready` MUST be the **first line on stdout**, written **within 5 seconds**
  of the host writing `hello`. Slow initialisation belongs after `ready` (or
  in the first request), not before it.
- Host leniency (not part of the contract): the first start of a given
  binary file in a Cadencr process — a new install or a rebuild — gets 20 s,
  because macOS assesses a freshly written executable on its first launch.
  Do not rely on it.
- The host writes no request before `ready`.
- No `ready` within 5 s: the host stops the backend and fails waiting requests
  with `PLUGIN_BACKEND_NOT_READY`. The wait counts against each request's own
  timeout (§5), so a request whose `timeout_ms` is under 5 s may fail with
  `PLUGIN_BACKEND_TIMEOUT` first.
- A first line that is not `ready`, or a `ready` with another `protocol`: the
  host stops the backend and fails with `PLUGIN_BACKEND_PROTOCOL_MISMATCH`.
  This is deterministic, so the host does not keep retrying the same binary.
- `ready` is sent once. After it, every stdout line is a `response`.

### 4.3 `request` (host → backend)

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | `"request"` | yes | |
| `id` | string or number | yes | Opaque. The Cadencr host sends decimal strings (`"1"`, `"2"`, …), unique within one run of the process. |
| `method` | string | yes | The backend's own method name, 1–128 characters, chosen by the tab. |
| `params` | any JSON | no | `null` when absent. At most 1 MiB of JSON. |

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["type", "id", "method"],
  "properties": {
    "type": { "const": "request" },
    "id": { "type": ["string", "number"] },
    "method": { "type": "string", "minLength": 1, "maxLength": 128 },
    "params": true
  }
}
```

### 4.4 `response` (backend → host)

Exactly one per request.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | `"response"` | yes | |
| `id` | string or number | yes | The request's `id`, **verbatim**: same JSON type, same value. (The host also accepts a number equal to the decimal string it sent, but a backend MUST NOT rely on it.) |
| `result` | any JSON | one of `result` / `error` | The method's result. |
| `error` | object | one of `result` / `error` | `{code, message}`, see below. |
| `error.code` | string | yes | Stable, machine-readable, `SCREAMING_SNAKE_CASE`. |
| `error.message` | string | yes | One sentence for a person. |

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["type", "id"],
  "properties": {
    "type": { "const": "response" },
    "id": { "type": ["string", "number"] },
    "result": true,
    "error": {
      "type": "object",
      "required": ["code", "message"],
      "properties": {
        "code": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]*$" },
        "message": { "type": "string" }
      }
    }
  },
  "oneOf": [
    { "required": ["result"], "not": { "required": ["error"] } },
    { "required": ["error"], "not": { "required": ["result"] } }
  ]
}
```

How the host reads a response (for robustness, a backend MUST still send
exactly one of `result` and `error`):

- a non-null `error` wins; a missing `error.code` reads as `BACKEND_ERROR`, a
  missing `error.message` as a generic message;
- otherwise the result is `result`, `null` when absent;
- a response whose `id` matches no waiting request (unknown, or already timed
  out) is discarded;
- any other stdout line after `ready` is ignored and noted in the log.

The tab's UI receives `{result}` or `{error: {code, message}}` as is.

## 5. Concurrency and timeouts

- The host MAY have up to **16 requests in flight** to one backend. It does
  not wait for a response before writing the next request.
- A backend SHOULD run requests concurrently, so that a slow one does not
  hold up the others, and MAY write responses **in any order**.
- A backend MUST keep reading stdin while requests run: the host's write
  queue is bounded, and a backend that stops reading makes later requests
  time out.
- **Per-request timeout:** the caller's `timeout_ms`, 1 ms – 120 000 ms,
  default **30 000 ms**, counted from the request: starting the backend
  (another start in progress, the binary check, the handshake) counts
  against it. On timeout the caller gets `PLUGIN_BACKEND_TIMEOUT`; a start
  under way carries on for the next request, and the backend is not told
  (there is no cancel message in v1) and a late response is discarded.

## 6. Lifecycle

- **Start:** on demand, when the tab's UI makes a request and no backend runs
  for that tab and conversation. One process per tab and conversation, shared
  by that conversation's open instances of the tab.
- **Stop:** the host **closes the backend's stdin**. This means "exit now":
  the backend MUST exit promptly, SHOULD exit with status 0, and MAY abandon
  requests still running (the host has already failed them).
- **Grace:** if the process has not exited **2 seconds** after stdin closed,
  the host sends `SIGTERM` to its process group, then `SIGKILL` 3 seconds
  later.
- The host stops a backend when no instance of its tab has been open (in
  the conversation's tab strip, on screen or not) for 30 s — about 30–50 s
  after the tab closes in practice: the host notices the closed tab on its
  next 10 s check, then stops the backend on the first check at least 30 s
  later — when its grant is revoked (permissions changed, tab turned off,
  updated or removed), or from the tab's Activity dialog.
- **Exiting on its own:** with status 0 after `ready` is a normal stop (the
  next request starts it again). A non-zero status, a signal the host did not
  send, or exiting before `ready` (with any status) is a **crash**. A missed `ready` and a protocol mismatch (§4.2) also count as
  crashes. After 3 crashes within 60 s the host no longer restarts it
  (`PLUGIN_BACKEND_CRASHING`) until the user clears it from the Activity
  dialog.

## 7. Cadencr API access

`hello.api` gives the backend its own access to the Cadencr HTTP API: send
`api.token` in the `api.token_header` header to `api.base_url` + path (for
example `GET {base_url}/api/plugin-tabs/self/...`). The token is a grant
minted for this process: the tab's consented scopes, bound to the
conversation (`feature_id`) and its project, checked by the same policy table
as the tab's UI (`CUSTOM_TABS.md` §4.3, §6.1). It is valid while the process
runs, however long that is, and revoked when it stops. API errors use
Cadencr's shape `{"error": "<message>", "code": "<CODE>"}`.

`api.base_url` is always plain `http://` to a loopback address. A client
MUST send the token there directly: never through a proxy (ignore
`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`), never to another host. The helper
crate's client does both, and refuses (`API_INVALID_CONFIG`) a `base_url`
that is not loopback `http://`.

## 8. stdin, stdout and stderr

- **stdin is the host's request stream.** A child process that inherits it
  (the default for most process APIs) can read, and swallow, request lines.
  A backend SHOULD give its children another stdin (the helper crate reads
  the protocol from a private close-on-exec descriptor and points
  descriptor 0 at `/dev/null` before `hello` is read).
- **stdout is reserved for the protocol.** Anything else written there is at
  best ignored and at worst — before `ready` — fails the handshake. A backend
  SHOULD make sure libraries and child processes cannot write to it (the
  helper crate re-points descriptor 1 at stderr and keeps a private
  close-on-exec descriptor for the protocol, swapping it under the stdout
  lock before anything buffered is flushed, so no print reaches the
  protocol stream).
- **stderr is the log,** free-form UTF-8 text, one entry per line. Cadencr
  keeps the last **200 lines** in memory (each cut to 2 000 characters; a
  line over 64 KiB is dropped) and shows them in the tab's Activity dialog.
  Never write `api.token` or other secrets there.

## 9. Error codes

Backends choose their own codes. These have a fixed meaning:

| Code | Sent by | Meaning |
|---|---|---|
| `UNKNOWN_METHOD` | backend | No method of that name. A backend MUST answer an unknown method with an error response (this code is recommended) and keep running. |
| `INVALID_PARAMS` | backend | The params do not fit the method. |
| `INVALID_REQUEST` | backend | A line with a usable `id` that is not a well-formed request (e.g. no `method`). |
| `INTERNAL_ERROR` | backend | The backend failed unexpectedly (e.g. a crash caught in a handler). |
| `RESPONSE_TOO_LARGE` | backend | The result does not fit in one 4 MiB line. |
| `BUSY` | backend | No room to queue the request; retry later. The Rust SDK answers it once 64 requests wait for a worker, rather than stop reading stdin. |
| `BACKEND_ERROR` | host | Substituted when a backend error has no `code`. |

Codes starting with `PLUGIN_` (and `MANAGED_TAB_`) are reserved for the
host. They are relay failures the tab's UI may see — HTTP errors of
`backend.request`, never backend responses. "Reported" codes keep the backend
from running at all and no retry by the page fixes them, so Cadencr tells the
user itself (a toast naming the tab, linking to its Activity); the page should
not repeat them. `@cadencr/tab-sdk` exports this set as
`HOST_REPORTED_BACKEND_CODES`, with `isReportedByHost(error)`.

| Code | Reported | Meaning |
|---|---|---|
| `PLUGIN_BACKEND_UNAVAILABLE` | yes | The backend cannot start (its binary is not built, unreadable, outside the tab folder…). |
| `PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM` | yes | The tab ships no binary for the platform Cadencr runs on, or Cadencr does not run backends on it. |
| `PLUGIN_BACKEND_NOT_NATIVE` | yes | The binary is a script, another OS's format or another CPU's code (§2.2). |
| `PLUGIN_BACKEND_UNSIGNED` | yes | arm64 code without a code signature, which Apple silicon kills (§2.2). |
| `PLUGIN_BACKEND_TAMPERED` | yes | A marketplace binary that differs from its signed digest. |
| `MANAGED_TAB_POLICY_UNAVAILABLE` | yes | A revocation feed is configured but no fresh policy is cached: the backend does not start. |
| `PLUGIN_TAB_BLOCKED` | yes | The tab (or this version, archive or executable) is revoked. |
| `PLUGIN_BACKEND_NOT_READY` | yes | No `ready` line in time (§4.2). |
| `PLUGIN_BACKEND_PROTOCOL_MISMATCH` | yes | The first stdout line is not `ready`, or names another protocol (§4.2). |
| `PLUGIN_BACKEND_CRASHING` | yes | 3 crashes within 60 s: no restart until the user clears it from the Activity dialog (§6). |
| `PLUGIN_BACKEND_START_FAILING` | yes | Starting it was refused 3 times in a minute. |
| `PLUGIN_BACKEND_UNDECLARED` | no | The tab declares no `backend`. |
| `PLUGIN_BACKEND_BUSY` | no | 16 requests already in flight (§5). |
| `PLUGIN_BACKEND_TIMEOUT` | no | No response within the request timeout (§5). |
| `PLUGIN_BACKEND_EXITED` | no | The backend exited before answering. |

See `CUSTOM_TABS.md` §4.7.

## 10. Robustness

A backend MUST NOT exit because of one bad line. After `ready`:

- a line that is not JSON, not an object, or has no usable `id`: log it and
  skip it;
- a `request` with a usable `id` but no usable `method`: answer
  `INVALID_REQUEST` (recommended) or skip it;
- a line with an unknown `type`: skip it (a later minor revision of the host
  may add message types that older backends ignore);
- a second `hello`: skip it.

## 11. Versioning

- The version is a single integer. It changes **only for breaking changes**:
  a message or field removed or retyped, a new required behaviour, a changed
  meaning. Adding optional fields or ignorable message types is not breaking
  and keeps the version.
- The host sends the manifest's `backend.protocol` and refuses versions it
  does not implement; a backend refuses (§4.1) versions it does not speak.
  There is no negotiation in v1.

## 12. Conformance

`cadencr-tab-backend`'s `conformance` feature checks any backend binary,
whatever its language, against this document: it spawns it as the host would
(the tab folder as working directory, no `CADENCR_*`/`VITE_*` variables, its
own process group — killed at the end, children included — and a temporary
`state_dir`), sends the manifest's `backend.protocol` in `hello`, and checks
that the **first** stdout line is `ready` with that version within 5 s (the
host's rule, §4.2), an error response with the same id for an unknown
method, survival of malformed lines, two concurrent requests both answered,
a clean exit with status 0 within 2 s of stdin closing, and that stdout
carried only protocol messages. stderr is read to its end, however long its
lines. `cadencr plugin validate --kind tab` runs it on this platform's
binary, and fails outright (`TAB_BACKEND_BINARY_REFUSED`) when that binary is
there but the host would refuse it (script, wrong format or CPU, unsigned
arm64, not executable); a binary not built yet is only a note.
