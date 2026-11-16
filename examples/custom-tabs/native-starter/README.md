# Native starter

A template for a [custom tab](../../../docs/CUSTOM_TABS_GUIDE.md) with a
native backend, meant to become **your own repository**. The page is a React
UI built with [`@cadencr/tab-kit`](https://www.npmjs.com/package/@cadencr/tab-kit);
it asks its backend — a Rust binary built on
[`cadencr-tab-backend`](https://crates.io/crates/cadencr-tab-backend) — for
what a page cannot read: the conversation's folder and the system it runs on.
A GitHub Actions workflow builds the backend for every platform, checks it
and packs the archives the marketplace points at.

Unlike the other examples, it depends only on published packages (npm and
crates.io), so it builds the same in or out of the Cadencr checkout.

## Make it yours

1. Copy this folder to a new repository (the `.github/` folder included).
2. Pick an id — lowercase letters, digits and `-` — and use it for `id` in
   `tab.json` (the folder name you install it under, below), `name` in
   `package.json`, `package.name` in `backend/Cargo.toml` (the binary's name),
   the three paths under `backend.binary` in `tab.json`, and the
   `native_starter::` path in `backend/src/main.rs` (the id with `_` for
   `-`). The build script, the tests and the workflow read the rest from
   `tab.json` and Cargo.
3. Write your methods in `backend/src/lib.rs`, keep `backend.reasoning` in
   `tab.json` true to what they do (users read it before consenting), and
   call them from `src/App.tsx` with `client.backend.request(method, params)`.
4. Run `npm install` and `cargo check --manifest-path backend/Cargo.toml` to
   update both lockfiles, and commit them: the workflow installs and builds
   with `npm ci` and `--locked`.

The [guide](../../../docs/CUSTOM_TABS_GUIDE.md#shipping-a-native-backend)
covers the backend's lifecycle and the rules it runs under;
[TAB_BACKEND_PROTOCOL.md](../../../docs/TAB_BACKEND_PROTOCOL.md) is the
contract.

## Build it

Needs Node 22+ and Rust ([rustup](https://rustup.rs)).

```sh
npm install
npm run build              # the UI into dist/, the backend into bin/<platform>/
npm run test:backend       # unit tests + protocol conformance of the binary
```

`npm run build:backend -- --target x86_64-apple-darwin` builds another
platform's binary (after `rustup target add x86_64-apple-darwin`).

## Try it in Cadencr

Copy what Cadencr runs — the manifest, the icon, `dist/` and `bin/` — to a
folder named after the tab's id:

```sh
mkdir -p ~/.cadencr/plugins/tabs/native-starter
cp -R tab.json icon.svg dist bin ~/.cadencr/plugins/tabs/native-starter/
```

In **Settings → Custom tabs**, review its access (native code runs with your
rights, so Cadencr asks you to acknowledge it), enable it for a project, then
add it from the **+** menu of a conversation. **+ → Activity…** shows the
backend's state and its stderr log. `cadencr plugin validate
~/.cadencr/plugins/tabs/native-starter --kind tab` checks the folder and runs
the binary through the same conformance checks as the tests.

## Release it

`.github/workflows/release.yml` runs on every push and pull request:

- checks that a `v*` tag matches `tab.json`'s `version`, before building;
- builds the backend on `macos-15` (`darwin-aarch64`, and `darwin-x86_64`
  cross-built) and `ubuntu-24.04` (`linux-x86_64`), with the tests and
  conformance on both runners and lint on Linux;
- downloads the Cadencr CLI release pinned in its `env` (checked against its
  SHA-256), validates the tab — conformance included for the Linux binary —
  and packs `tab.tar.gz` plus one `tab-backend-<platform>.tar.gz` per
  platform. The run summary lists the values the marketplace metadata needs.

Push a tag `v<version>` matching `tab.json`'s `version` and it also creates
the GitHub release holding those archives. Then write the marketplace
metadata from the run summary, as the guide's
[Publishing a tab with a native backend](../../../docs/CUSTOM_TABS_GUIDE.md#publishing-a-tab-with-a-native-backend)
describes, and submit it. A new binary needs a new version: the executable's
SHA-256 is signed into the catalog and users consent again.

To move to a newer CLI, set `CADENCR_CLI_VERSION` and `CADENCR_CLI_SHA256`
in the workflow to the `CADENCR_RELEASE_VERSION` and `CADENCR_RELEASE_SHA256`
of that release's `released-cli.env` asset.

To work on the tab with a coding agent, give it the same instructions a
scaffolded tab gets: create one from **Settings → Custom tabs → Create** and
copy its `INSTRUCTION.md`, `AGENTS.md` and `CLAUDE.md` here.
