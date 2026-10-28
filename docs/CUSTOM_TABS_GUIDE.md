# Custom tabs — guide

Custom tabs let you put any web UI next to Agent, Terminal, Git, Editor and
Browser in a conversation: a graph of what the feature changed, your team's CI
dashboard, a bridge to an in-house tool. You build them; Cadencr hosts them,
themes them and hands them the conversation's context.

This guide covers using and building them. The contract every part follows is
[Custom tabs](./CUSTOM_TABS.md); API details live in the
[`@cadencr/tab-sdk`](../packages/tab-sdk/README.md) and
[`@cadencr/tab-kit`](../packages/tab-kit/README.md) READMEs. Working examples
are in [`examples/custom-tabs`](../examples/custom-tabs/README.md).

Custom tabs are desktop only for now. The phone and remote views show a
placeholder instead.

## Three levels

Every custom tab is one of three levels. Cadencr shows the level wherever the
tab appears, so you always know what you are allowing.

| Level             | What the tab can do                                                                                                                                       | Where you see it                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Read-only**     | Show a page that reads Cadencr data through its permissions, and reach the websites it declares. Nothing else.                                            | A "Read-only" badge in Settings.                                                      |
| **Runs commands** | Also ask Cadencr to run the programs it lists (for example `git`) in the conversation's folder, without a shell.                                          | A "Runs commands" badge, a terminal glyph on the tab, every command in **Activity…**. |
| **Native code**   | Also run its own program on your computer, **with your user rights**. Cadencr does not sandbox it: it can read and change your files and use the network. | A "Native code" badge, a chip glyph on the tab, its state and log in **Activity…**.   |

Whatever the level, the tab's access to Cadencr itself stays limited to its
permissions: even a native backend gets its own scoped token, never yours.
Only allow a "Runs commands" tab you trust, and a "Native code" tab only if
you would install it as an app. A marketplace tab may ship native code too:
its listing says "Runs native code with your rights" before you install it, its
binary is signed into the catalog and checked before every launch, and a
blocked tab's backend is stopped.

## Using a custom tab

1. **Turn it on.** Open **Settings → Custom tabs**. Each tab lists what it can
   read (its permissions) and which websites it may contact. Enable it for every
   project with **Enable in all projects**, or per project with
   **Inherit / On / Off**. The first time, Cadencr asks you to accept its
   permissions, the programs it runs and, for native code, tick
   **I trust this code to run on my computer with my rights**. If a later
   version asks for more, the tab pauses until you accept again.
2. **Add it to a conversation.** Click **+** at the end of the tab strip and
   pick the tab. It behaves like the built-in tabs: drag it into a split, move
   it between panes, close it with **×**. Closing removes it from that
   conversation only.
3. **Configure it.** If the tab declares settings, they appear on its card in
   Settings: global values, values per project, and secrets. A secret is stored
   by Cadencr and never shown again, not even to the tab itself (see
   [Network access and secrets](#network-access-and-secrets)).

The **+** menu also shows actions for the focused custom tab: **Reload**,
**Open DevTools**, **Open source project** and, for a tab that runs commands
or native code, **Activity…**: every command it ran (or was refused) in this
conversation, and its backend's state and log, with **Stop**.

When a tab can't run, it says why in place: not built yet, invalid
`tab.json`, turned off for this project, crashed (with **Reload**), or not
available on this device.

## Creating a custom tab

**Settings → Custom tabs → Create custom tab**, or **Create custom tab…** in the
**+** menu. Give it a name. Cadencr then:

- creates `~/.cadencr/plugins/tabs/<id>/`, a Git repository with a starter tab
  (Vite, React, TypeScript, Tailwind v4, the tab SDK and kit);
- creates a project for it with an agent conversation, and places the new tab in
  that conversation;
- turns the tab on for that project.

Ask the agent what the tab should show. The starter's `INSTRUCTION.md`
(mirrored in `AGENTS.md`/`CLAUDE.md`) teaches it the contract, the SDK, the
permissions and the design rules. Then:

```bash
npm install
npm run dev     # vite build --watch — Cadencr reloads the tab on every rebuild
```

Cadencr serves `dist/` (the folder holding `entry`). Sources and `tab.json` are
never served. A change to `tab.json` is picked up live too. If it widens the
permissions, you are asked to accept them again.

## Building one

### The manifest

`tab.json` declares who the tab is and what it may do:

```json
{
  "schema_version": 1,
  "kind": "tab",
  "id": "files-graph",
  "name": "Files graph",
  "version": "0.1.0",
  "api_version": 1,
  "entry": "dist/index.html",
  "tab": { "label": "Files graph" },
  "permissions": ["git:read"],
  "network": { "allowed_origins": [], "reasoning": null },
  "configuration": []
}
```

Rules are in [CUSTOM_TABS.md §3](./CUSTOM_TABS.md#3-manifest--tabjson);
`cadencr plugin validate --kind tab <dir>` checks a folder. Settings shows the
same errors on the tab's card.

### Permissions

| Permission       | What the tab can read                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| `features:read`  | This conversation's feature and project, and the project's other features.              |
| `git:read`       | Status, diffs, history and branches of this conversation's worktree; live `git.status`. |
| `forge:read`     | The pull/merge request of this conversation; live `forge.status`.                       |
| `files:read`     | Files of this conversation's worktree; live `files.changes`.                            |
| `agent:observe`  | The agent conversation's history and live `session.stream` (read only).                 |
| `workspace:read` | Every project and feature; live `session.status`.                                       |

A tab never gets your Cadencr token. Each open tab receives a short-lived grant
for **its** conversation only. The service checks every request against a fixed
list of read-only routes, so a tab cannot send prompts, answer permission gates,
change settings or reach another conversation.

### The SDK

```tsx
import { CadencrProvider, useTabContext, useStream } from "@cadencr/tab-sdk/react";
import { getChangedFiles } from "@cadencr/tab-sdk/api";

function App() {
  const { feature } = useTabContext(); // project, feature, branch, PR, session
  const [files, setFiles] = useState<string[]>([]);
  const refresh = () =>
    getChangedFiles({ feature_id: feature.id, mode: "uncommitted" }).then((f) =>
      setFiles(f.map((x) => x.file)),
    );
  useEffect(() => void refresh(), [feature.id]);
  useStream("git.status", () => void refresh()); // pushed live, no polling
  return (
    <ul>
      {files.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

createRoot(root).render(
  <CadencrProvider>
    <App />
  </CadencrProvider>,
);
```

The client also has the following:

- **`storage`**: a key/value store for each tab and project, kept by Cadencr.
- **`state`**: per-instance state that survives reloads.
- **`config`**: the tab's settings, without secrets.
- **`net.fetch`**: see the next section.
- **`ui`**: a toast, opening a link (the user confirms), and a badge on the tab.
- **`capabilities`**: what the host supports.

`@cadencr/tab-sdk/testing` provides a fake host so you can unit-test a tab
without Cadencr.

### Keyboard shortcuts

A tab can declare the keys it handles while it has focus, and receive them
with `useShortcut`:

```json
"shortcuts": [
  { "id": "refresh", "keys": ["mod", "alt", "r"], "description": "Refresh the graph" }
]
```

```tsx
useShortcut("refresh", () => void refresh());
```

`mod` is ⌘ on macOS and Ctrl elsewhere, and `mod`, `ctrl` or `alt` must be
held. Cadencr's own shortcuts — the command palette, the pane switches, Git
actions and the rest — always win over a focused tab, so a declared shortcut
on the same keys never fires. Settings → Custom tabs lists such a shortcut as
not available and names the Cadencr shortcut that takes it. The keyboard
shortcuts cheatsheet (⌘⇧?) lists the shortcuts that can fire. The format is
in [CUSTOM_TABS.md](CUSTOM_TABS.md#3-manifest--tabjson).

### Look native

Import the kit once:

```css
@import "tailwindcss";
@import "@cadencr/tab-kit/preset.css";
```

Use its components (`Button`, `Card`, `Badge`, `Tabs`, `Tooltip`, `Select`,
`EmptyState`…) and the theme utilities (`bg-background`, `text-muted-foreground`,
`bg-chart-2`…). They are built from Cadencr's own design system and follow the
user's theme, light or dark, live. Never hardcode colors.

### Running commands

To run a program, list it with a reason:

```json
"commands": [
  { "program": "git", "reasoning": "Reads who changed the files of this branch." }
]
```

```ts
const { stdout, success } = await client.exec.run("git", ["log", "--format=%an", "--", path]);
```

Cadencr runs it without a shell, in the conversation's folder, finds it on
your `PATH`, stops it after 30 s (`timeoutMs`, up to 120 s) or 1 MiB of
output, and records it in **Activity**. Shells, interpreters and package
runners (`bash`, `node`, `python`, `npx`…) cannot be listed: they would run
anything. A tab that needs one ships a backend instead.

### Shipping a native backend

When a tab needs a long-running process, its own dependencies or many tools,
it ships a backend: a **native executable** per platform, inside the tab
folder. Scripts (`#!`), interpreters and programs on your `PATH` are refused
— the user consents to that file, so it has to be the program itself.
Declare it with a reason and one binary per platform you support:

```json
"backend": {
  "reasoning": "Lists the processes listening on local ports.",
  "protocol": 1,
  "binary": {
    "darwin-aarch64": "bin/darwin-aarch64/my-backend",
    "darwin-x86_64": "bin/darwin-x86_64/my-backend",
    "linux-x86_64": "bin/linux-x86_64/my-backend"
  }
}
```

Cadencr runs the binary of the platform it runs on, directly — no shell, no
arguments, the tab folder as working directory — on the tab's first
`client.backend.request(method, params)`, keeps it running as long as the
tab stays in its conversation's tab strip (hidden, idle, or while you are in
another conversation or Settings) and stops it 30–50 s after the tab closes
(a 30 s grace, checked every 10 s). On a platform you leave out,
the rest of the tab still works and requests fail with
`PLUGIN_BACKEND_UNAVAILABLE_ON_PLATFORM`. Windows has no platform key yet.

The backend talks to Cadencr in JSON lines on stdin/stdout: a `hello` with
the conversation, its folder, a writable `state_dir` and a Cadencr API token
limited to the tab's permissions; its `ready` answer within 5 s; then
`request` lines it answers with `response` lines, in any order. stderr is its
log, shown in **Activity…**. The full contract is
[TAB_BACKEND_PROTOCOL.md](./TAB_BACKEND_PROTOCOL.md);
[CUSTOM_TABS.md §4.7](./CUSTOM_TABS.md#47-native-backend-backendrequest)
covers how Cadencr starts, checks and stops it.

#### Write it in Rust

Rust is the recommended language: the
[`cadencr-tab-backend`](../packages/tab-backend-sdk-rs/README.md) crate does
the handshake, framing, concurrency and error handling, so a backend is one
function. A crate next to your UI code, say `backend/`:

```toml
# backend/Cargo.toml
[package]
name = "my-backend"
version = "0.1.0"
edition = "2021"

[dependencies]
cadencr-tab-backend = "0.1"
serde_json = "1"

[dev-dependencies]
cadencr-tab-backend = { version = "0.1", features = ["conformance"] }
```

Until the crate is on crates.io, depend on it by path from a Cadencr checkout
(`{ path = "<checkout>/packages/tab-backend-sdk-rs", version = "0.1" }`), as
the example does.

```rust
// backend/src/main.rs
use std::process::ExitCode;

use cadencr_tab_backend::{serve, Context, Error};
use serde_json::{json, Value};

fn handle(cx: &Context) -> Result<Value, Error> {
    match cx.method() {
        "greet" => {
            let name: String = cx.params()?;
            Ok(json!(format!("hello, {name}")))
        }
        other => Err(Error::unknown_method(other)),
    }
}

fn main() -> ExitCode {
    serve(handle)
}
```

```ts
const greeting = await client.backend.request<string>("greet", "Ada");
```

Some rules the crate cannot enforce for you:

- **Write only under `cx.state_dir()`.** The tab folder is read-only for a
  marketplace tab. `state_dir` is kept across runs and updates, and is shared
  by the tab's backends in every conversation: use a sub-folder per
  `cx.hello().feature_id`, or locks.
- **Keep stdout for the protocol.** `serve` already redirects stray
  `println!` output to the log on Unix; log with `eprintln!`.
- **Call Cadencr with the backend's own token** (feature `api`,
  `cx.api()?.get(…)`); it carries only the tab's permissions.

`testing::TestHost` (in the crate) drives a handler in-process for unit
tests, and the `conformance` feature checks the built binary the way Cadencr
drives it — see the example's `backend/tests/conformance.rs`.

#### Build it for each platform

`cargo build --release` builds for the machine you are on; copy the result to
the path `tab.json` names for that platform and keep it executable:

```sh
cargo build --release --manifest-path backend/Cargo.toml
mkdir -p bin/darwin-aarch64
rm -f bin/darwin-aarch64/my-backend
cp backend/target/release/my-backend bin/darwin-aarch64/my-backend
```

Remove the old binary before copying the new one: macOS remembers the code
signature of an executable it has run, and kills a file rewritten in place on
its next launch (`exited with signal: 9`, a crash in Activity).

For the other platforms, add the Rust target and pass `--target`; the binary
lands in `backend/target/<triple>/release/`:

| Platform key     | Rust target                                               | Notes                                                                                                |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `darwin-aarch64` | `aarch64-apple-darwin`                                    | Builds from any Mac (`rustup target add aarch64-apple-darwin`).                                      |
| `darwin-x86_64`  | `x86_64-apple-darwin`                                     | Builds from any Mac (`rustup target add x86_64-apple-darwin`).                                       |
| `linux-x86_64`   | `x86_64-unknown-linux-gnu` or `x86_64-unknown-linux-musl` | Build on Linux, or cross-compile with a Linux linker (for example `cargo-zigbuild`). musl is static. |

An Apple-silicon (`darwin-aarch64`) binary must carry a code signature, or
Cadencr refuses it (`PLUGIN_BACKEND_UNSIGNED`) — macOS would kill it anyway.
The Apple linker that `cargo` uses signs arm64 output ad hoc, so a fresh
build is fine; after anything that rewrites the file (some `strip` runs,
patchers), re-sign it with `codesign -s - <file>`. `bin/` and
`backend/target/` are build output: gitignore them.

#### Check it

`cadencr plugin validate <folder> --kind tab` checks the manifest, reports
every platform's binary that is missing or not native, and runs this
platform's binary through the protocol conformance checks: `ready` in time
and with the right protocol, an error for an unknown method, surviving
malformed lines, two concurrent requests, a clean exit when stdin closes, and
nothing but protocol messages on stdout. A failed check fails the command
(`TAB_BACKEND_CONFORMANCE_FAILED`, with each check's result and the
backend's last stderr lines); a binary not built yet is only a warning. Pass
`--no-run` where the binary cannot be executed, such as a CI machine of
another platform. From a Cadencr checkout:

```sh
pnpm rust -- run -q -p cadencr-cli -- plugin validate ~/.cadencr/plugins/tabs/my-tab --kind tab
```

#### Other languages

Any toolchain that produces a native executable works — Go, Zig, C, C++… —
as long as it implements [TAB_BACKEND_PROTOCOL.md](./TAB_BACKEND_PROTOCOL.md).
`cadencr plugin validate` checks it the same way, whatever it is written in.

[`examples/custom-tabs/port-monitor`](../examples/custom-tabs/port-monitor)
is a complete one: a Rust backend that lists listening ports and stops
servers started in the conversation's folder, with `npm run build:backend`
building it into `bin/<platform>/`.
[`examples/custom-tabs/native-starter`](../examples/custom-tabs/native-starter)
is the one to start from in your own repository: it builds against the
published crate and npm packages, and its GitHub Actions workflow builds the
three platforms, validates the tab and packs the archives below into a
release.

### Network access and secrets

A tab has no network of its own. To call another service, declare its origin
and say why:

```json
"network": {
  "allowed_origins": ["https://gitlab.example.com"],
  "reasoning": "Reads merge-request pipelines from the team GitLab."
},
"configuration": [
  { "key": "token", "type": "secret", "label": "Access token", "scope": "global" }
]
```

Then call `client.net.fetch(url, { headers: { Authorization: "Bearer {{secret:token}}" } })`.
Cadencr makes the request, substitutes the secret on its side and returns the
response. The tab code never sees the token. Requests to other origins, and to
private network addresses, are refused.

## Limits in this version

- Native backends are not sandboxed. They run with your user rights; only their
  access to Cadencr is limited.

- Desktop only. The phone and remote views show a placeholder.
- At most six custom tabs stay alive at once; a hidden one beyond that is
  unloaded and comes back, with its `state`, when shown again.
- Every plugin route is `proposed`: it may still change before custom tabs can
  be published. The SDK and kit are versioned `0.x` and ship vendored inside the
  starter until they are published on npm.

## Publish a custom tab to the marketplace

Build the tab first (`pnpm build` in its author project). Open the project's
settings and use **Custom tab publication preparation**, then **Prepare a custom
tab bundle**. These sections are available in every build.

The metadata uses the signed catalog's schema-2 `tab` kind. This is a template,
not publishable metadata: replace the checksum and `FIRST_COMPATIBLE_APP_VERSION`
before preparation. The first desktop release with marketplace-tab support has
not been selected yet; released `0.13.1` does **not** support these packages.

```json
{
  "kind": "tab",
  "package": {
    "tab": {
      "id": "files-graph",
      "name": "Files graph",
      "description": "Explore changed files",
      "version": "1.0.0",
      "repository": "https://github.com/acme/files-graph",
      "license": "MIT",
      "api_version": 1,
      "distribution": {
        "archive": "https://github.com/acme/files-graph/releases/download/v1.0.0/tab.tar.gz",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      }
    },
    "host": {
      "publisher": "acme",
      "compatibility": { "min_app_version": "FIRST_COMPATIBLE_APP_VERSION" }
    }
  }
}
```

Use the actual first compatible app version or a later tested release for
`min_app_version`; the placeholder deliberately fails semantic-version validation.
Keep the mixed tab catalog separate from feeds consumed by older clients: their
parsers can reject the unknown `tab` kind before compatibility filtering.

The ID, name, version and API version must match `tab.json`. Preparation replaces
the placeholder checksum with the actual SHA-256 and captures only `tab.json`,
the declared SVG icon and the directory containing the compiled HTML entry.
The distributed entry must be inside a web directory such as `dist/index.html`.
Sources, dependencies, Git history, symlinks and executable file modes are not
distributed. Both compressed and unpacked archives are limited to 32 MiB.

Review the prepared bundle, create the source release, then generate and submit
the registry contribution through the existing publication workflow. Preparing a
bundle alone publishes nothing; the registry still verifies and signs its catalog.

For headless packaging, assemble that same distribution tree and run:

```sh
cadencr registry pack-tab --directory ./staging --output ./tab.tar.gz
```

For release preparation, add `--package ./marketplace-package.json` to bind the
compiled manifest's identity, version and API version to reviewed schema-2 metadata.

### Publishing a tab with a native backend

A backend tab is published as one web archive plus one backend archive per
platform. **Prepare a custom tab bundle** refuses them, so use the CLI:

1. Stage `tab.json`, the icon and your built web root only (no `bin/`), then
   `cadencr registry pack-tab --directory ./stage --output out/tab.tar.gz`.
2. For each platform in `tab.json`'s `backend.binary` (on that platform's CI
   runner if you like):

   ```sh
   cadencr registry pack-tab-backend --directory ./my-tab \
     --target <darwin-aarch64|darwin-x86_64|linux-x86_64> \
     --output out/tab-backend-<platform>.tar.gz
   ```

   It checks that the executable is a regular native file (code-signed on
   Apple silicon: `codesign -s -`, which the Rust linker already does), at most
   128 MiB and outside your web root, then writes a deterministic archive
   (at most 64 MiB) holding just that file, mode `0755`. It prints the values
   step 4 needs.
3. Upload `tab.tar.gz` and every `tab-backend-<platform>.tar.gz` to the **same**
   GitHub release.
4. In your schema-2 metadata, add `"backend": {"protocol": 1, "reasoning": "…"}`
   to `tab` (the same reasoning as `tab.json`) and, under
   `tab.distribution.binary.<platform>`, the `archive` URL you uploaded plus the
   `sha256`, `size`, `cmd`, `executable_sha256` and `executable_size` that
   `pack-tab-backend` printed.
5. Check it: `cadencr registry pack-tab --directory ./stage --package
   metadata.json --output out/check.tar.gz` binds the metadata to `tab.json`;
   `cadencr registry validate-submission` and `cadencr registry
   plan-publication` should show one `backend-<platform>` target per platform.

Users only see the platforms you shipped; elsewhere the listing shows "Not
available on this platform". The `executable_sha256` is signed into the catalog
and checked again before every launch, so any binary change needs a new
version, and users are asked to consent again before it runs. The first version
that adds a backend to an existing tab is reviewed like a new tab.

Marketplace tabs share the mixed catalog source and signing trust already used
by themes (`CADENCR_MANAGED_THEME_INDEX_URL`); no separate signing key is needed.
They appear under **Custom tabs** in the marketplace and install into immutable
revisions under `plugins/managed-tabs`, separate from editable `plugins/tabs`
projects. Installation does not grant permissions. Enable the tab through the
existing consent dialog; changes to its permissions or network origins require
consent again. Updates and removal keep configuration, while installation refuses
to overwrite a local author tab with the same ID.
