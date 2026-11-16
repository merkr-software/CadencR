# Custom tab examples

Working [custom tabs](../../docs/CUSTOM_TABS.md): web UIs Cadencr shows as a
tab on a conversation page. Each folder is laid out like the project Cadencr
scaffolds from **Settings → Custom tabs → Create** (same `package.json`
scripts, `tsconfig.json`, Vite config and `src/main.tsx`). What the scaffold
writes in and this repository keeps once — the `@cadencr/tab-sdk` and
`@cadencr/tab-kit` tarballs (`vendor/`) and the agent documents
(`INSTRUCTION.md`, `AGENTS.md`, `CLAUDE.md`) — is copied in by
`npm run vendor` ([`vendor.mjs`](./vendor.mjs)) and gitignored.

Each example is one of the three custom tab levels
([CUSTOM_TABS.md §6.2](../../docs/CUSTOM_TABS.md#62-levels)):

| Example                                  | Level         | Shows                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`files-graph`](./files-graph)           | Read-only     | A treemap of the feature's changed files with a diff side panel. The typed API (`getChangedFiles`, `getFileDiff`), the live `git.status` stream with a debounced refetch, `useStorage`, `useVisibility`, the tab badge, and chart colors taken from theme tokens. Permission: `git:read`.                                |
| [`endpoint-watcher`](./endpoint-watcher) | Read-only     | A GitHub repository's open pull requests and workflow runs. Configuration fields (`config.get()`), a secret substituted server-side (`{{secret:token}}`), egress through `net.fetch` to `network.allowed_origins`, and `ui.openExternal`. No permission.                                                                 |
| [`git-reviewers`](./git-reviewers)       | Runs commands | Who knows the code the branch changes, from its Git history. A declared command (`commands: [git]`) run with `exec.run` in the conversation's folder, three at a time, kept live on `git.status`. Permission: `git:read`.                                                                                                |
| [`port-monitor`](./port-monitor)         | Native code   | The local servers listening on TCP ports, and a Stop button for the ones running in this conversation's folder. A native `backend` written in Rust (one binary per platform) speaking the stdio protocol, calling the Cadencr API with its own scoped token, polled with `backend.request`. Permission: `features:read`. |
| [`native-starter`](./native-starter)     | Native code   | A template for your own repository: a native Rust backend on the published `cadencr-tab-backend` crate, a tab-kit UI on the published npm packages, and a GitHub Actions workflow that builds the three platforms, validates the tab and packs the marketplace archives into a release. No permission.                   |

When you try them, check what Cadencr tells you for each level: the badge and
the permissions block in **Settings → Custom tabs**, the consent dialog (native
code needs an explicit acknowledgment), the glyph on the tab, and
**+ → Activity…** for the last two.

## Build one

From the repository checkout:

```sh
cd examples/custom-tabs/files-graph
npm run vendor       # vendor/*.tgz + INSTRUCTION.md, AGENTS.md, CLAUDE.md
npm install
npm run build        # tsc --noEmit && vite build → dist/
```

`port-monitor` also builds its native backend into `bin/<platform>/` and
needs Rust for it; see [its README](./port-monitor/README.md#build-it).
`native-starter` needs no `npm run vendor`: it installs the SDK and kit from
npm ([its README](./native-starter/README.md)).

After changing `packages/tab-sdk` or `packages/tab-kit`, run
`pnpm vendor:tab-packages` at the repository root, then `npm run vendor` again
and reinstall (`rm -rf node_modules && npm install`): npm caches a `file:`
tarball by its integrity hash.

## Install it in Cadencr

Copy the folder — with `dist/` and `vendor/`, without `node_modules/` — to
`~/.cadencr/plugins/tabs/<id>/`, where `<id>` is the manifest's `id` (the
folder name must match it):

```sh
rsync -a --exclude node_modules examples/custom-tabs/files-graph/ ~/.cadencr/plugins/tabs/files-graph/
```

Cadencr picks it up live. In **Settings → Custom tabs**, approve its
permissions and network origins, enable it for a project, then add it from the
**+** menu of any conversation in that project.

The installed folder is self-contained, like a scaffolded tab: run
`npm install` there once, then `npm run dev` to rebuild `dist/` on every save
(Cadencr reloads the open tab after each build). To change it with an agent,
open the installed folder as a project in Cadencr; its `INSTRUCTION.md` is the
contract the agent reads first. (`npm run vendor` only works inside the
checkout; the installed folder already has what it copies.)

## Further reading

- [`docs/CUSTOM_TABS.md`](../../docs/CUSTOM_TABS.md) — the contract: manifest,
  permissions, policy table, wire protocol.
- [`packages/tab-sdk/README.md`](../../packages/tab-sdk/README.md) — the SDK:
  `connect()`, React hooks, the typed API client, the test host.
- [`packages/tab-kit/README.md`](../../packages/tab-kit/README.md) — theme
  tokens, the Tailwind preset and the components.
