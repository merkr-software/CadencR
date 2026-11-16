# Port monitor

A **native code** custom tab: the local servers listening on TCP
ports, the process behind each, and which ones run in this conversation's
folder — with a **Stop** button for those. A page cannot list processes or send a
signal, so the tab ships its own backend: a small Rust program in
[`backend/`](./backend), built on the
[`cadencr-tab-backend`](../../../packages/tab-backend-sdk-rs) crate.

## The backend

`tab.json` declares it, why it is needed, and one native executable per
platform:

```json
"permissions": ["features:read"],
"backend": {
  "reasoning": "Lists the TCP ports listening on this computer and the process behind each (lsof on macOS, /proc on Linux), and stops a process started in this conversation's folder when you ask.",
  "protocol": 1,
  "binary": {
    "darwin-aarch64": "bin/darwin-aarch64/port-monitor",
    "darwin-x86_64": "bin/darwin-x86_64/port-monitor",
    "linux-x86_64": "bin/linux-x86_64/port-monitor"
  }
}
```

Cadencr runs the binary of the platform it runs on — directly, no shell, no
interpreter, no arguments, with this folder as the working directory — on the
tab's first `client.backend.request()`, and stops it 30–50 s after the tab
is closed, when the tab is turned off, or when its permissions change. It speaks
JSON lines on stdio ([TAB_BACKEND_PROTOCOL.md](../../../docs/TAB_BACKEND_PROTOCOL.md)):

| Direction     | Line                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| stdin, first  | `{"type":"hello","protocol":1,"plugin","project_id","feature_id","worktree","state_dir","scopes","api":{"base_url","token_header","token"}}` |
| stdout, first | `{"type":"ready","protocol":1}`, within 5 s                                                                                                  |
| stdin         | `{"type":"request","id","method","params"}`                                                                                                  |
| stdout        | `{"type":"response","id","result"}` or `{"type":"response","id","error":{"code","message"}}`                                                 |
| stderr        | its log, shown in **+ → Activity…**                                                                                                          |

The crate does the handshake, framing and concurrency; the tab's code is the
methods ([`backend/src/lib.rs`](./backend/src/lib.rs)):

| Method    | Does                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context` | Reads the conversation's title from the Cadencr API with the backend's own token (`features:read`, this conversation only).                                   |
| `ports`   | macOS: `lsof -nP -iTCP -sTCP:LISTEN` and each process's working directory (`lsof -d cwd`). Linux: `/proc/net/tcp{,6}`, `/proc/<pid>/fd`, no external program. |
| `stop`    | `SIGTERM` to a process that is listening **and** whose working directory is inside the conversation's folder; anything else, and Cadencr itself, is refused.  |

Errors carry a stable code the page shows with its message: `LSOF_MISSING`,
`LSOF_FAILED`, `PROC_UNAVAILABLE`, `NOT_LISTENING`, `OUTSIDE_FOLDER`,
`CADENCR_PROCESS`, `STOP_FAILED`, or the Cadencr API's own code for
`context`. Like `lsof` without root, the list holds the user's own
processes — the ones the tab could stop anyway.

The page calls the methods through the SDK, polls `ports` every 5 s while
shown, and checks every answer's shape with Zod (`src/usePorts.ts`):

```ts
const { ports } = await client.backend.request<{ ports: PortEntry[] }>("ports");
await client.backend.request("stop", { pid });
```

## Build it

Besides Node, you need Rust ([rustup.rs](https://rustup.rs)). From this
folder, after `npm run vendor` and `npm install` ([README](../README.md)):

```sh
npm run build          # build:ui (tsc + vite → dist/) then build:backend
npm run build:backend  # cargo build --release, copied to bin/<this platform>/port-monitor
npm run test:backend   # unit tests, a live ports/stop run, and the protocol conformance check
```

`build:backend` ([`scripts/build-backend.mjs`](./scripts/build-backend.mjs))
builds for the platform Rust targets by default. For another one, pass its
target (installed with `rustup target add`):

```sh
npm run build:backend -- --target x86_64-apple-darwin       # bin/darwin-x86_64/ (from an Apple Silicon Mac)
npm run build:backend -- --target aarch64-apple-darwin      # bin/darwin-aarch64/ (from an Intel Mac)
npm run build:backend -- --target x86_64-unknown-linux-musl # bin/linux-x86_64/, static (needs a Linux linker, e.g. cargo-zigbuild)
```

Platforms without a binary in `bin/` simply cannot run the backend; the rest
of the tab still loads. `bin/` and `backend/target/` are gitignored. An arm64
macOS binary must keep the ad-hoc signature the linker gives it: re-sign with
`codesign -s - <file>` after anything that rewrites it.

The crate depends on `cadencr-tab-backend` by path inside this checkout. A
copy of the folder installed elsewhere ships its `bin/` and does not need to
rebuild it. To rebuild it there, delete `path = "…", ` from both
`cadencr-tab-backend` entries in `backend/Cargo.toml`: Cargo then takes the
version it names from crates.io (it never falls back on its own when the path
is missing).

## What the user sees

The backend runs with the user's rights and Cadencr does not sandbox it. It
says so at every step:

- **Settings → Custom tabs**: a "Native code" badge; under the permissions,
  the backend's binaries, its reason and a warning that it can read and
  change any file and use the network.
- **Consent**: the dialog leads with the same warning and only allows the tab
  once **I trust this code to run on my computer with my rights** is ticked.
- **The tab strip**: a chip glyph on the tab and in the **+** menu.
- **+ → Activity…**: whether the backend runs, its pid, why it last stopped,
  its stderr log, and **Stop**.

Its Cadencr access stays limited to `features:read` for this conversation,
like the page's: the `hello` token is not the app's own.

A folder is not a conversation: conversations without their own worktree
share the project folder, so their servers show up, and can be stopped, from
each of them. Windows has no backend binary: there, requests fail with
`PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM`, which the tab shows as its error.

Install it like the other examples ([README](../README.md)), leaving out the
Rust build directory:

```sh
rsync -a --exclude node_modules --exclude backend/target examples/custom-tabs/port-monitor/ ~/.cadencr/plugins/tabs/port-monitor/
```
