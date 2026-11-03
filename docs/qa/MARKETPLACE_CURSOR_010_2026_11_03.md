# Cursor 0.1.0 managed installation — 2026-11-03

## Scope

Verify that Cadencr 0.16.0 can discover, install and activate the published
Cursor connector before removing the former built-in provider. The local test
used the real Cursor Agent CLI on macOS arm64, an isolated Cadencr database and
settings directory, and the browser renderer connected to the real service.
No prompt, paid model turn or authentication request was sent by the test host.

## Published inputs

| Input                        | Evidence                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Connector                    | [Cursor 0.1.0 author release](https://github.com/merkr-software/CadencR/releases/tag/plugins/provider-cursor/v0.1.0)   |
| Registry archives            | [Managed Cursor 0.1.0 release](https://github.com/merkr-software/cadencr-registry/releases/tag/provider-cursor-v0.1.0) |
| Signed catalog publication   | [Successful protected publication](https://github.com/merkr-software/cadencr-registry/actions/runs/41591457530)        |
| Catalog SHA-256              | `d4e36be3e31581ecd8fe3022606dc23fdae2c23592a3f646e70de3f260e707e2`                                                     |
| macOS arm64 archive SHA-256  | `d76d600c6350157a60ec2fa195d264b9416beec6f6d74a66f284ddc4f0dd6b4c`                                                     |
| Installed executable SHA-256 | `990ac8ab8e098812d999a0241098fbc8d8ea47ac6368e7ecf51c8b8f91ab2537`                                                     |

The authenticated catalog contains six entries. Its five previous entries are
unchanged; the only addition is Cursor 0.1.0, with minimum app version 0.16.0
and four native targets. The installed executable matches the author release.

## Results

| Test                                                         | Result                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Discover Cursor in the public marketplace                    | Pass: version 0.1.0, recommended for this machine, signed catalog verified |
| Install the registry-owned macOS arm64 archive               | Pass: archive and executable hashes verified; installation receipt saved   |
| Restart the isolated service                                 | Pass: marketplace reports Cursor as active                                 |
| Read the runtime catalog for an empty test workspace         | Pass: HTTP 200, Cursor available, 270 models, default `auto`               |
| Initialize an empty ACP session and explicitly select `auto` | Pass with the exact published executable and real Cursor CLI               |

The browser console retained development-shell warnings about runtime config,
the CSP meta tag, an initial WebSocket reconnect and contenteditable focus.
There was no installation API error after the correction. The final service
log contained no warnings or errors.

## Admission regressions fixed

The original installation probe rejected a valid initial model different from
the discovery default, despite an identical ordered list of 270 model IDs.
The probe now validates the initial selector and catalog, applies the discovered
choice, then strictly verifies the authoritative response.

Cursor also retains a conversation only after its first prompt. Reloading this
empty disposable session in a fresh connector process explicitly reports that
exact session ID as absent. Only that structured JSON-RPC response is recorded
as unprobed; it never becomes a successful restore and never creates replacement
context. Other restore errors and mismatched restored configuration still
reject installation. Runtime resume/load behavior remains unchanged.

Eleven targeted Rust tests pass, including different initial models, invalid
selectors, changed catalogs, ignored model selection, incorrect restored
models, unsupported restore methods, unrelated missing session IDs, and both
stable resume and legacy load for an unretained empty probe session. The
dedicated security/regression review found no blocking issue in the fix.

## Receipt and limits

The sanitized managed-install receipt records:

```json
{
  "verified_version": "0.1.0",
  "model_config_id": "model",
  "model_count": 270,
  "default_model": "auto",
  "resume": "not_advertised",
  "load": "unprobed",
  "close": "not_advertised",
  "prompt": "unprobed",
  "os_sandbox_applied": false
}
```

This proves prompt-free managed admission and activation on macOS arm64. It
does not prove a paid turn, history restoration after a real turn, packaged
Electron behavior, or interactive Linux installation. The connector's four
native build/qualification jobs use a scripted Cursor CLI and explicitly record
`real_cursor_cli: false`; they do not substitute for those integration checks.
The isolated QA database, receipt, logs and failure history are retained.
