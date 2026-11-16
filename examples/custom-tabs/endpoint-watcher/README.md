# Endpoint watcher

A small Cadencr custom tab that lists a GitHub repository's open pull
requests and recent workflow runs. It needs no Cadencr permission at all: it
shows the three things a tab uses to talk to the outside world.

## Configuration

`tab.json` declares two settings fields, filled in **Settings → Custom tabs →
Endpoint watcher**:

| Key          | Type     | Scope   | Read by the tab                                                    |
| ------------ | -------- | ------- | ------------------------------------------------------------------ |
| `repository` | `string` | project | `client.config.get()` → `{ repository: "merkr-software/CadencR" }` |
| `token`      | `secret` | global  | never                                                              |

The tab reads the configuration on its first load, on every manual refresh
and whenever it is shown again (there is no "configuration changed" event),
so a repository filled in from Settings appears as soon as you come back.

## Egress and secrets

The tab's page has no network (`connect-src 'none'`). It calls GitHub with
`client.net.fetch(url, init)`; Cadencr's service makes the request, and only
to origins listed in `network.allowed_origins`:

```json
"network": {
  "allowed_origins": ["https://api.github.com"],
  "reasoning": "Reads the configured repository's open pull requests and workflow runs from the GitHub REST API."
}
```

The user approves that list (with the reasoning) before the tab can run, and
again whenever it grows.

The request carries `Authorization: Bearer {{secret:token}}`. The
`{{secret:token}}` placeholder is replaced **server-side**, right before the
request leaves the machine: the token is never sent to the tab, never readable
through `config.get()`, and stripped if a redirect leaves the allowed origins.
When no token is set the service refuses the placeholder with
`PLUGIN_TAB_SECRET_UNKNOWN`; the tab catches that and asks GitHub anonymously
(`src/github.ts`), and its footer says which one happened. Timed polls then
skip the token until the next refresh or show, so an anonymous user doesn't
pay a refused round trip every minute.

## Storage

The selected list (pull requests or workflow runs) is kept with
`useStorage("feed", "pulls")` — the plugin's own key/value store, per project
— so each project remembers its own choice.

## Build and install

```sh
npm run vendor         # copies the SDK/kit tarballs and the agent docs (checkout only)
npm install
npm run build          # tsc --noEmit && vite build → dist/
```

Then copy the folder (with `dist/` and `vendor/`, without `node_modules/`) to
`~/.cadencr/plugins/tabs/endpoint-watcher/` and follow
[the examples README](../README.md#install-it-in-cadencr) to approve, enable
and develop it.
