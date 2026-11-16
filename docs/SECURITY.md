# Desktop and service security boundaries

## Renderer, main process, and embedded browser

| Surface                                  | Authority                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Electron main process                    | Holds the per-launch service token and brokers authenticated service transport.                                                                                                                              |
| Main application renderer                | Receives no raw launch token through runtime configuration or preload. Main injects the token only into service HTTP/WebSocket requests from the configured main renderer frame to the exact service origin. |
| Embedded browser pages and plugin guests | Use separate sessions and receive no main-renderer credential injection or privileged IPC authority.                                                                                                         |

Privileged IPC checks the current main window's frame identity and configured
renderer target: the exact development origin or packaged renderer file. An
arbitrary loopback page, another file, or a subframe does not inherit that trust.
The renderer build exposes an explicit environment-variable allowlist that
excludes the development API token. Desktop WebSockets use the main-injected
header without returning that bearer through a selected subprotocol.

The trusted renderer can still issue authenticated API operations. Keeping the
raw token in main narrows credential exposure; it does not isolate service data
from compromised application-renderer code.

MCP/agent navigation and automation in shared browser tabs reject Cadencr's own
application and service surfaces, including configured remote origins. Human-only
tabs may browse these surfaces; that does not grant agents automation access.
Request interception provides a backstop for agent/shared browser surfaces, and
MCP dispatch refreshes the current host-surface policy through a lightweight,
authenticated listener-metadata endpoint before execution. Its origins come
from the effective running listener, so a settings edit or read failure cannot
hide an active tunnel. This avoids loading settings, devices and audit history
for every browser action. Browser operations check document identity around
asynchronous work; opaque/replaced frames fail closed. JavaScript evaluation is
excluded from Cadencr's automatic tool-approval allowlist across provider
namespaces. Approval to evaluate does not remove the browser surface checks.

TLS certificate verification remains enabled. Cadencr does not install a global
certificate-error bypass for the embedded browser. The remote listener's
self-signed certificate does not grant unrelated embedded pages a TLS exception.
Remote application responses also prevent framing through CSP `frame-ancestors
'none'` and `X-Frame-Options: DENY`.

## Diagrams and file previews

Both diagram renderers sanitize their final SVG output immediately before DOM
insertion. DOMPurify's SVG profile is combined with restrictions on active
markup, event handlers, external references and CSS. Styles are scoped to the
individual diagram; local fragment references remain available for markers and
filters. This is an output boundary, not a claim that renderer input can never
exercise parser bugs.

HTML and SVG file previews use an opaque-origin iframe with
`sandbox="allow-scripts"`. Their restrictive CSP is inserted before untrusted
content: network connections, external subresources, child frames, workers,
objects, base URLs and form submissions are denied. Inline scripts and styles
remain enabled for interactive local previews. The sandbox isolates application
storage and parent DOM access; it is not a script-free preview or a universal
navigation/resource-exhaustion sandbox. CSP connection/subresource restrictions
do not establish complete network isolation for every navigation path.

## Local credentials and filesystem access

Forge credentials are stored as plaintext in `~/.cadencr/forge/tokens.json`.
Settings documents can also contain provider credentials. On Unix, Cadencr creates
private directories with mode `0700` and credential/settings/database files with
mode `0600`; startup tightens existing settings and SQLite database/WAL/SHM files
in place. Existing database contents and inodes are preserved. Permission checks
avoid rewriting already-private modes, so file watchers do not observe startup
chmod loops. Existing custom parent directories are not chmodded. Final secret-file symlinks and hard links
are rejected rather than followed; permission failures are surfaced.

These permissions separate operating-system accounts. They do **not** isolate
credentials from programs running as the same account, including coding agents
with filesystem tools. A forge token entered into Cadencr remains readable by
that account. Use narrowly scoped tokens and revoke them at the forge when no
longer needed. Cadencr does not currently store these tokens in an OS credential
vault. Forge authentication command output is treated as secret even on failure;
user-facing errors contain the exit status and login instructions, not stderr.

Generated development `.env` files are created privately and tightened when the
setup/worktree/doctor helpers read them; the service also tightens its `.env`
before loading it. Worktree database cloning tightens the checked source inode to
`0600` before reflink/copy creation, so the destination inherits private modes.
The APFS path retains reflink cloning through `fclonefileat` on the checked
source descriptor, called through macOS's bundled JavaScript bridge; replacing
the source pathname cannot change the cloned inode. The fallback uses a bounded full copy
through an exclusive `0600` descriptor so even write failures preserve partial
files. Both copy paths refuse existing destinations; failed partial copies are
retained for inspection rather than overwritten or removed. Permission changes do not
encrypt files or their backups.

## Remote authentication

Pairing links carry their short-lived code in the URL fragment (`/#code=...`),
which is not sent in the HTTP request target. Codes remain single-use and expire
after two minutes. Treat the entire pairing link as a credential until used or
expired.

For LAN pairing, the host initially shows only a plain connection address. The
user opens that address on the other device, inspects its certificate viewer,
and enters the complete SHA-256 fingerprint for comparison on the host before a
pairing code is minted/displayed. The gate resets when the selected origin or
host certificate changes, or the dialog is reopened; a missing fingerprint
blocks LAN pairing. This is a manual comparison gate: Cadencr cannot inspect the
other device's browser certificate and does not implement TLS pinning for it.
A private Tailscale connection with a browser-trusted certificate is recommended;
the configured private-tunnel route relies on ordinary browser certificate trust.

New remote-browser pairings default to `sessionStorage`, so the device token is
not retained after the tab session closes. Explicit **Trust this device** consent
stores it in `localStorage` instead. The token also lives in memory for the
active session; storage is a mirror, not protection from same-origin scripts.

Pair attempts are limited to five per source IP per minute. Failed HTTP and
WebSocket authentication share a separate budget of twenty failures per source
IP per minute. Once exhausted, subsequent remote requests are rejected before
authentication until the window expires, including valid credentials from that
same IP. Known authenticated loopback and plugin traffic retain isolated buckets.
The broad request ceiling remains an additional backstop.

## Rust dependency review: 2026-10-23

The review used RustSec advisory database commit
`84d943a6deeb8cc6c6f632531aaf4f1c62275239` (updated 2026-10-23).
Run the audit without suppressions:

```sh
pnpm rust -- audit
pnpm rust -- tree --edges normal -i rsa -p cadencr-service
pnpm rust -- tree --edges normal -i zip@0.6.6 -p cadencr-service
```

| Dependency         | Reviewed lockfile version                     |
| ------------------ | --------------------------------------------- |
| `rustls`           | `0.23.46`                                     |
| `rustls-webpki`    | `0.103.16`                                    |
| `webpki-roots`     | `1.0.11`                                      |
| `ctutils`          | `0.4.5`                                       |
| `quinn-proto`      | `0.11.19`                                     |
| `tokio`            | `1.54.1`                                      |
| Direct `zip`       | `9.0.5`                                       |
| `chacha20` / `der` | `0.10.2` / `0.8.2` (replaced yanked versions) |

The direct ZIP version also addresses the upstream
[dual-header advisory](https://github.com/zip-rs/zip2/security/advisories/GHSA-m665-v7pm-7grj),
whose patch is `9.0.5`. Provider package extraction validates paths, entry types,
permissions and size budgets itself instead of using `ZipArchive::extract()`.
Legacy ZIP decoding and AES encryption are disabled on the direct dependency.

The audit decreased from **19 to 4 vulnerability findings** and still exits
unsuccessfully. No advisory is ignored:

| Residual finding                                                                                                                                                                                                            | Active dependency path and assessment                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`RUSTSEC-2023-0071`](https://rustsec.org/advisories/RUSTSEC-2023-0071.html), `rsa 0.9.10`                                                                                                                                  | `service → web-push → jwt-simple → superboring → rsa`, also directly through the service's `jwt-simple`. Upstream reports no patched version. Cadencr's VAPID path generates/signs ES256 keys; it does not call RSA private-key operations. The affected crate remains in the active build graph.                                                                             |
| [`RUSTSEC-2026-0367`](https://rustsec.org/advisories/RUSTSEC-2026-0367.html), [`0368`](https://rustsec.org/advisories/RUSTSEC-2026-0368.html), [`0369`](https://rustsec.org/advisories/RUSTSEC-2026-0369.html), `zip 0.6.6` | `service → ironcalc 0.8.3 → zip 0.6.6`. The pinned spreadsheet engine has no compatible dependency update to ZIP 9. Cadencr uses `load_from_xlsx_bytes`; this reads named XML entries in memory and does not call the filesystem extraction APIs implicated by these three advisories. The older parser remains active for workbook recalculation and is not claimed patched. |

The same audit retains maintenance warnings for `paste 1.0.15` (through
`utoipa-axum`) and `tokio-io 0.1.13` (through the futures compatibility graph), plus
an unsoundness warning for `rand 0.7.3` through `nvim-rs → parity-tokio-ipc`,
and a yanked-package warning for `spin 0.9.8` through `flume`/`lazy_static`.
These transitive dependencies remain; upgrading the surrounding libraries or
replacing them needs separate compatibility work. This review is a dated
assessment of the active paths, not a clean-audit claim.
