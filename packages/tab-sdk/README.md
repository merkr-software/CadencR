# @cadencr/tab-sdk

The SDK for Cadencr **custom tabs**: web UIs that Cadencr shows as a
feature-page tab, next to Agent, Terminal, Git, Editor and Browser. The tab runs
in an isolated view with no network; everything it reads goes through a
`MessagePort` to the Cadencr host. This package speaks that protocol for you.

[Documentation](https://cadencr.com/docs/tab-sdk/) ·
[npm](https://www.npmjs.com/package/@cadencr/tab-sdk) ·
[Custom tab contract](https://github.com/merkr-software/CadencR/blob/main/docs/CUSTOM_TABS.md)

## Install

```bash
npm install @cadencr/tab-sdk
```

The package is ESM with TypeScript declarations and no runtime dependencies.
The core SDK works without React. For `@cadencr/tab-sdk/react`, also install
the optional React 19 peers:

```bash
npm install react@^19 react-dom@^19
```

Create a host project with **Settings → Custom tabs → Create**. The page must
run inside a Cadencr custom tab; an ordinary browser has no host port and
`connect()` will time out. For isolated tests, use the [fake host](#testing).
See the [authoring guide](https://cadencr.com/docs/libraries/#create-your-first-custom-tab)
for the manifest and static build setup.

## Quick start

```ts
import { connect, toCadencrError } from "@cadencr/tab-sdk";
import { getGitStatus } from "@cadencr/tab-sdk/api";

const output = document.createElement("pre");
output.textContent = "Connecting…";
document.body.append(output);

try {
  const client = await connect();
  window.addEventListener("pagehide", () => client.close(), { once: true });
  const status = await getGitStatus({ feature_id: client.context.feature.id });
  output.textContent = JSON.stringify(status, null, 2);
} catch (error) {
  output.textContent = toCadencrError(error).message;
}
```

Declare `"permissions": ["git:read"]` in `tab.json` for this example and renew
consent after changing permissions. Requests are scoped to the tab's own
project and feature; use the IDs from `client.context`.

`connect()` waits for the port the Cadencr preload posts to the page, performs
the `hello` handshake and applies the Cadencr theme to `<html>` (see
[Theme](#theme)). The SDK starts listening for that port as soon as it is
imported, so calling `connect()` late never misses it. When the host reloads
its side it sends a new port: the client re-handshakes, re-subscribes every
stream and calls each stream's `onResync`.

### React

```tsx
import { CadencrProvider, useStream, useTabContext } from "@cadencr/tab-sdk/react";

function App() {
  return (
    <CadencrProvider
      fallback={<p>Connecting…</p>}
      errorFallback={(error) => <p role="alert">Cannot reach Cadencr: {error.message}</p>}
    >
      <Feature />
    </CadencrProvider>
  );
}

function Feature() {
  const context = useTabContext();
  useStream("git.status", (event) => console.log(event.data));
  return <h1>{context.feature.name}</h1>;
}
```

## Entry points

| Import                      | Use                                                            |
| --------------------------- | -------------------------------------------------------------- |
| `@cadencr/tab-sdk`          | Connection, client, errors, theme helpers, and protocol types. |
| `@cadencr/tab-sdk/api`      | Generated, typed plugin API functions.                         |
| `@cadencr/tab-sdk/react`    | React provider and hooks.                                      |
| `@cadencr/tab-sdk/testing`  | Fake host and fixtures.                                        |
| `@cadencr/tab-sdk/protocol` | Wire types and version constants.                              |

## API

### `connect(options?) → Promise<CadencrClient>`

| Option             | Default            | Meaning                                                      |
| ------------------ | ------------------ | ------------------------------------------------------------ |
| `timeoutMs`        | `10000`            | Wait for the port and the `hello` reply.                     |
| `requestTimeoutMs` | `30000`            | Default per-request timeout.                                 |
| `applyTheme`       | `true`             | Write the theme onto `<html>` now and on every change.       |
| `transport`        | the window message | A `PortSource` or a `MessagePort` (tests use the fake host). |

Rejects with a `CadencrError`: `PLUGIN_API_UNSUPPORTED` when the host speaks no
common API version, `TIMEOUT` when nothing answers (the page is not running in a
Cadencr custom tab).

### `CadencrClient`

| Member                                                                | Description                                                                                                                                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context`, `onContextChange(cb)`                                      | Project, feature, pull request and session of the tab (`TabContext`).                                                                                                  |
| `theme`, `onThemeChange(cb)`                                          | The Cadencr theme (`ThemeSnapshot`: `id`, `appearance`, `tokens`).                                                                                                     |
| `visible`, `onVisibilityChange(cb)`                                   | Whether the tab is shown. Pause expensive work while hidden.                                                                                                           |
| `shortcuts`, `onShortcut(cb)`                                         | The ids of the manifest's `shortcuts` that can fire (Cadencr's own shortcuts take any on the same keys), and presses of them while the tab has focus.                  |
| `instanceId`, `plugin`, `apiVersion`                                  | From the handshake.                                                                                                                                                    |
| `capabilities.list`, `capabilities.isSupported(name)`                 | Capabilities the host announced.                                                                                                                                       |
| `api.request({ method, path, query?, body? })`                        | Call the plugin surface of the Cadencr service. Resolves an `ApiResponse` for every status.                                                                            |
| `api.get/post/put/patch/delete<T>(path, …)`                           | JSON helpers: resolve the body, throw `CadencrError` (service `code`, `status`) on non-2xx.                                                                            |
| `streams.subscribe(topic, handler, { params?, onResync?, onError? })` | Live events. Returns `{ unsubscribe() }`. A `seq` gap, a host resync or a reconnect calls `onResync`: refetch.                                                         |
| `storage.get/set/delete/list`                                         | The plugin's key/value store, per project (JSON values, ≤ 256 KiB each). Writes to one key run in call order.                                                          |
| `state.get/set`                                                       | Per-instance state in host memory; survives the view being recreated.                                                                                                  |
| `config.get()`                                                        | Non-secret configuration from the manifest's `configuration` fields.                                                                                                   |
| `net.fetch(url, { method?, headers?, body?, timeoutMs? })`            | Fetch from an origin in `network.allowed_origins`. `{{secret:<key>}}` in header values is filled in server-side.                                                       |
| `exec.run(program, args?, { timeoutMs? })`                            | Run a program listed in `tab.json` `commands`, without a shell, in the conversation's folder. Resolves `{exitCode, success, stdout, stderr, durationMs}` for any exit. |
| `backend.request<T>(method, params?, { timeoutMs? })`                 | Call the tab's native `backend` (started on first use). Resolves its `result`; its `error` rejects with the backend's own `code`.                                      |
| `ui.toast({ title, description?, variant? })`                         | Show a Cadencr toast.                                                                                                                                                  |
| `ui.openExternal(url)`                                                | Open an `https:` URL in the browser, after the user confirms.                                                                                                          |
| `ui.setBadge(text \| null)`                                           | Up to 4 characters on the tab trigger.                                                                                                                                 |
| `connected`, `onConnectionChange(cb)`                                 | Port lost (`false`) / re-established (`true`).                                                                                                                         |
| `onError(cb)`                                                         | Background failures nobody else handled. Without a listener they are re-thrown asynchronously (`window.onerror`).                                                      |
| `call(method, params, { timeoutMs? })`                                | Raw protocol call.                                                                                                                                                     |
| `close()`                                                             | Unsubscribe streams and stop talking to the host.                                                                                                                      |

`ApiResponse` mirrors `fetch`'s `Response`: `status`, `ok`, `headers`
(lower-cased), `json()`, `text()`, `arrayBuffer()`.

Stream topics: `git.status`, `session.stream`, `files.changes`, `forge.status`,
`feature.events`, `session.status` — each needs the matching manifest
permission.

### Errors

Every failure is a `CadencrError` with a `code`: `PLUGIN_API_UNSUPPORTED`,
`CAPABILITY_DENIED`, `PLUGIN_SCOPE_DENIED`, `PLUGIN_BINDING_DENIED`,
`PLUGIN_NETWORK_DENIED`, `NOT_FOUND`, `BAD_REQUEST`, `TIMEOUT`, `DISCONNECTED`,
`HOST_ERROR` — or, from `api.*` helpers, the service's own stable code. HTTP
errors also carry `status`.

Some `backend.request` failures Cadencr reports to the user itself, with a link
to the tab's Activity: the ones that keep the backend from running at all
(`HOST_REPORTED_BACKEND_CODES` — unsigned or tampered binary, no build for
this platform, crash loop, …). `isReportedByHost(error)` tells them apart, so a
page doesn't show them twice; everything else (`TIMEOUT`, a busy or exited
backend, the backend's own errors) is the page's to show.

```ts
import { isReportedByHost, toCadencrError } from "@cadencr/tab-sdk";

try {
  await client.backend.request("ports");
} catch (error) {
  if (!isReportedByHost(error)) showError(toCadencrError(error).message);
}
```

### Theme

The theme arrives as tokens (`background`, `primary`, `muted-foreground`, …).
The client writes each one onto `<html>` as `--cadencr-<token>`, plus
`data-appearance="light|dark"`, `data-cadencr-theme` and `color-scheme`. Use
the variables directly, or install `@cadencr/tab-kit` for a Tailwind preset and
components that already read them. `applyTheme`, `themeVariables` and
`themeToCss` are exported for custom setups.

### React (`@cadencr/tab-sdk/react`)

| Export                                                                  | Description                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<CadencrProvider fallback? errorFallback? connectOptions?>`            | Connects on mount, closes on unmount. Without `errorFallback` a failure renders a built-in, theme-aware "Can't reach Cadencr" message (`role="alert"`, the error's message and code). |
| `useCadencr()`                                                          | The client.                                                                                                                                                                           |
| `useTabContext()`, `useTheme()`, `useVisibility()`                      | Live values.                                                                                                                                                                          |
| `useShortcut(id, handler)`                                              | Runs `handler` each time the manifest shortcut `id` is pressed while the tab has focus.                                                                                               |
| `useStream(topic, handler, { params?, onResync?, onError?, enabled? })` | One subscription for the component's lifetime; inline callbacks are fine.                                                                                                             |
| `useStorage(key, initial)`                                              | `{ value, loading, error, set(value) }` for one storage key.                                                                                                                          |

### Typed API client (`@cadencr/tab-sdk/api`)

One function per route a custom tab may call, with request and response types,
generated from the service's plugin surface (its policy table). Call
`connect()` first; every function resolves the parsed body and throws a
`CadencrError` (`PLUGIN_SCOPE_DENIED`, `PLUGIN_BINDING_DENIED`, …) on non-2xx.

```ts
import { connect } from "@cadencr/tab-sdk";
import { getFeature, getGitStatus, listFeatures } from "@cadencr/tab-sdk/api";

const cadencr = await connect();
const { feature, project } = cadencr.context;
const current = await getFeature(feature.id); // features:read
const status = await getGitStatus({ feature_id: feature.id }); // git:read
const siblings = await listFeatures({ project_id: project.id });
```

Calls are bound to the tab's own feature and project: `getFeature(otherId)`
fails with `PLUGIN_BINDING_DENIED`. Every scoped route is generated, whatever
your manifest asks for; one outside the tab's `permissions` fails with
`PLUGIN_SCOPE_DENIED`. Each operation in `openapi.plugin.json` carries its
`x-cadencr-scope` and `x-cadencr-tier` (`proposed` routes may still change).
`client.api.request` stays available as the untyped escape hatch.

Maintainers regenerate it with `pnpm --filter @cadencr/tab-sdk generate:api`
(dumps the surface with `dump-openapi --plugin-surface`, then runs orval).
`pluginFetch<T>(url, init)` (and `createPluginFetch(client)`) is the orval
mutator underneath: a service URL (`/api/…?query`) and a `RequestInit` with a
JSON string body in, the parsed body or a `CadencrError` out.

## Testing

`@cadencr/tab-sdk/testing` is a fake host on a standard `MessageChannel`. It
answers `hello` from its options and keeps storage, state and subscriptions in
memory.

```ts
import { expect, it } from "vitest";
import { connect, type CadencrClient } from "@cadencr/tab-sdk";
import { createTestHost, jsonResponse } from "@cadencr/tab-sdk/testing";

it("reads from the host", async () => {
  const host = createTestHost();
  let client: CadencrClient | undefined;
  try {
    client = await connect({ transport: host.transport });
    host.route("GET", "/api/git/status", jsonResponse(200, { files: [] }));
    const status = await client.api.get("/api/git/status", {
      query: { feature_id: client.context.feature.id },
    });
    expect(status).toEqual({ files: [] });
  } finally {
    client?.close();
    host.close();
  }
});
```

| `TestHost` member                                                                | Description                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `transport`, `port`                                                              | Pass `transport` to `connect()`.                             |
| `handle(method, handler)`                                                        | Replace a method's handler; throw `CadencrError` to fail it. |
| `route(method, path, response \| handler)`                                       | Answer `api.request`.                                        |
| `setContext`, `setTheme`, `setVisible`, `emit`                                   | Push events.                                                 |
| `pushStream(idOrTopic, data, { seq? })`, `resync`, `streamError`                 | Drive subscriptions.                                         |
| `requests`, `nextRequest(method?)`, `subscriptions`, `storage`, `state`, `badge` | Inspect what the tab did.                                    |
| `reconnect()`, `disconnect()`, `close()`                                         | Host reload, port loss, teardown.                            |

`createTabContext`, `createThemeSnapshot` and `jsonResponse` build fixtures.
The fake host exercises the transport; service permission enforcement still
needs validation in the desktop app.

## Protocol types

`@cadencr/tab-sdk/protocol` (also re-exported from the root) holds the wire
types and constants shared with the host: `GuestToHost`, `HostToGuest`,
`MethodMap`, `EventMap`, `TabContext`, `ThemeSnapshot`, `API_VERSION`,
`SUPPORTED_API_VERSIONS`, `PORT_MESSAGE_TYPE`, `ERROR_CODES`,
`negotiateApiVersion`.

## Compatibility and troubleshooting

The package is versioned independently of Cadencr. The custom tab host API is
version 1; API operations marked `proposed` can still change. Inspect
`client.capabilities` before relying on optional host features.

| Failure                     | Check                                                     |
| --------------------------- | --------------------------------------------------------- |
| `TIMEOUT` during connection | Run inside a custom tab, or supply a fake-host transport. |
| `PLUGIN_API_UNSUPPORTED`    | Host and SDK need a common API version.                   |
| `PLUGIN_SCOPE_DENIED`       | Declare the scope in `tab.json` and renew consent.        |
| `PLUGIN_BINDING_DENIED`     | Use project/feature IDs from the tab context.             |
| Stale data after reconnect  | Refetch a snapshot in each stream's `onResync`.           |

Close subscriptions and the client when disposing of a non-React page. The
React provider and `useStream` manage their own cleanup. The [full guide](https://cadencr.com/docs/tab-sdk/)
covers streams, errors, and host services together.

## License

Apache-2.0
