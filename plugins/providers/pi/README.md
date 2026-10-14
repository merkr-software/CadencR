# Cadencr provider: Pi

This monorepo-owned connector runs [Pi](https://pi.dev/) directly in native
[`--mode rpc`](https://pi.dev/docs/latest/rpc) and presents an ACP v1 agent to
Cadencr. It does **not** use or require `pi-acp`.

Source lives in `plugins/providers/pi/` in the Cadencr monorepo. It remains an
external connector behind the provider-neutral installation and conformance
boundary, not a built-in adapter or a bundled desktop provider. This source
import does not publish, sign, install, or certify a provider package.

Imported from the sibling connector repository at commit `95bb90c`, preserving
candidate version `0.4.0`. `LICENSE` and `icon.svg` are retained unchanged; icon
provenance remains pending. No release should be made until provenance and
licensing review are complete.

The import adapts documentation and package scripts for the monorepo. Runtime
hardening beyond that baseline adds a stdin-`EPIPE` guard so fast native-child
exits surface ACP errors instead of crashing the connector, plus shutdown
tracking that closes sessions created after ACP input ends and waits for their
cleanup, preserving cleanup failures in shutdown rejection as well as ACP errors.
Dedicated fake regressions cover these cases. Fake-test results do not
certify compatibility with real upstream Pi or the packaged Cadencr host.

## Prerequisites

- Node.js `>=22.18.0 <23.0.0` (the supported runtime range).
- `pi` available on `PATH`:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1
```

Run `pi` once and configure at least one model provider. Credentials remain
owned by Pi; this connector does not directly access Pi credential storage.
Native Pi diagnostics forwarded through errors or stderr can contain sensitive
information. Review and redact diagnostics before sharing them publicly.

## Build and validate

Run these commands from the monorepo root. The connector has no runtime package
dependencies, and its dedicated scripts are excluded from generic app tasks:

```bash
pnpm install --frozen-lockfile
pnpm --filter @cadencr/pi-provider build:plugin
pnpm --filter @cadencr/pi-provider test:plugin

./plugins/providers/pi/bin/provider version
```

Optional smoke starts real Pi without sending prompts; do not run it as part of
fake-only validation:

```bash
pnpm --filter @cadencr/pi-provider smoke
./plugins/providers/pi/bin/provider models --format acp-config-options-v1 --cwd "$PWD"
```

Optional live QA commands exercise real configured models. The first performs
text and tool turns in a newly created scratch workspace, permits only the exact
`printf PI_RPC_TOOL_OK` bash command, and retains all scratch files; the second restarts the connector between two turns and
proves Pi retained the conversation through ACP `session/resume`:

```bash
CADENCR_PI_LIVE_QA=1 pnpm --filter @cadencr/pi-provider live-qa
CADENCR_PI_LIVE_QA=1 pnpm --filter @cadencr/pi-provider resume-qa
```

Explicit formatting and lint checks are also available from the root:

```bash
pnpm --filter @cadencr/pi-provider format:plugin:check
pnpm --filter @cadencr/pi-provider lint:plugin
```

The build copies every runtime module and the permission extension into the
stable, ignored `bin/` directory. `bin/provider` is marked executable.

## Executable contract

| Cadencr command                                   | Native implementation                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`                                         | Prints the connector version.                                                                                                                    |
| `models --format acp-config-options-v1 --cwd ...` | Starts an ephemeral `pi --mode rpc --no-session --no-approve`, requests `get_available_models` and `get_state`, and emits an ACP model selector. |
| `run --protocol acp-v1`                           | Runs this connector's ACP v1 JSON-RPC server. Each ACP session owns a persistent `pi --mode rpc` child in the requested workspace.               |

Set `CADENCR_PI_COMMAND` when `pi` is not on `PATH`.

Extra descriptor arguments after Cadencr's reserved arguments are forwarded as
a direct Pi argument vector. No shell interpolation is used.

## Feature mapping

The statuses below describe implemented mappings and fake-fixture coverage, not
live compatibility certification or packaged-host conformance.

| Cadencr / ACP feature       | Pi RPC mapping                                                             | Status                                                                                             |
| --------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pre-session model selection | `get_available_models` + `get_state`                                       | Full; provider/model IDs match the live selector exactly.                                          |
| Model metadata              | Native name, context window, image input, reasoning levels                 | Full for metadata Pi exposes.                                                                      |
| Live model changes          | `set_model` followed by authoritative state/config refresh                 | Full.                                                                                              |
| Thinking level              | `get_available_thinking_levels` + `set_thinking_level`                     | Full, including `xhigh` and `max` where the model advertises them.                                 |
| Text streaming              | `message_update.text_delta` → `agent_message_chunk`                        | Full.                                                                                              |
| Thinking streaming          | `message_update.thinking_delta` → `agent_thought_chunk`                    | Full.                                                                                              |
| Images                      | ACP image blocks → Pi RPC image content                                    | Supported when the selected Pi model accepts images.                                               |
| Tool lifecycle              | `tool_execution_start/update/end` → ACP tool call updates                  | Full, including streaming output and raw input/output.                                             |
| Tool permission             | Bundled Pi extension → RPC extension UI → ACP `session/request_permission` | Mutating/custom tools prompt; `read`, `grep`, `find`, and `ls` remain read-only and do not prompt. |
| Cancellation                | ACP `session/cancel` → Pi `abort`                                          | Full; the prompt answers `stopReason: cancelled`.                                                  |
| Durable resume              | Workspace-bound ACP ID → a new `pi --mode rpc --session <native-id>`       | Full through stable `session/resume`; legacy `session/load` remains accepted for older hosts.      |
| Graceful close              | `session/close` → Pi abort (when active) → process teardown                | Full; active work is cancelled before the connector releases the native process.                   |
| Slash commands              | `get_commands` → `available_commands_update`                               | Full for commands Pi exposes in RPC mode.                                                          |
| Usage/context/cost          | `get_session_stats` → ACP `usage_update`                                   | Full for Pi's cumulative session stats.                                                            |
| Auto compaction             | `set_auto_compaction` and compaction boundary events                       | Supported.                                                                                         |
| Queue behavior              | `set_steering_mode` / `set_follow_up_mode`                                 | Exposed as live session options.                                                                   |
| Pi session title            | RPC session info and extension title events                                | Forwarded as ACP session info.                                                                     |
| Errors                      | RPC command/model/extension failures → JSON-RPC errors                     | Surfaced to Cadencr and `stderr`; never silently swallowed.                                        |

## Deliberate limitations

- Pi RPC does not expose dynamic registration for ACP's `mcpServers`, so the
  connector reports that limitation on `stderr` and lets Pi use its own
  extension-provided integrations.
- Pi extension `input` and `editor` dialogs need free-form elicitation, which
  stable ACP v1 does not provide. They are cancelled explicitly. `confirm` and
  `select` dialogs are bridged through ACP permission choices.
- Pi RPC exposes no native plan event. The connector does not infer a plan from
  prose or tool calls.
- Pi executes tools locally. ACP filesystem/terminal delegation is not involved;
  the connector streams Pi's real tool lifecycle back to Cadencr instead.
- Pi RPC has no session-file deletion command, so the connector deliberately
  does not advertise or implement ACP `session/delete`. Pi's own session storage
  remains the source of truth and can be managed with Pi itself.
- Connector versions before `0.3.0` exposed raw Pi session IDs. Those IDs are
  intentionally refused because they cannot prove which workspace owns them;
  start a new conversation once to receive a workspace-bound session ID.

## Test through Cadencr's generic provider path

1. Run `pnpm --filter @cadencr/pi-provider build:plugin` from the monorepo root.
2. Package the resulting `bin/` connector, `icon.svg`, and provider metadata
   using Cadencr's provider-package contract.
3. Install that package through Cadencr's managed-provider API using a trusted
   development index. Do not point a descriptor at either repository's source
   files.
4. Fully restart the **development** Cadencr process when connector registration
   or descriptor data changed. Cadencr intentionally does not hot-reload provider
   registrations.
5. Select **Pi** and choose a model before sending the first message.
6. Exercise text, thinking, a read tool, a bash/write permission, cancellation,
   resume, close, model changes, and the session options.

This directory is connector-owned source. Its release artifact must pass the
same signature, integrity, platform, conformance, quarantine, and process-policy
checks as any other marketplace provider. End users never edit or clone Cadencr.

## Candidate packaging and platform expectations

This is a candidate scaffold, not a published or signed registry artifact.
`pnpm --filter @cadencr/pi-provider package:plugin` produces a deterministic payload directory and SHA-256 manifest
containing `bin/`, `README.md`, `LICENSE`, and `icon.svg` only. Archive/signature
and registry submission remain separate steps.

The launcher requires Node on PATH and a separately installed Pi CLI. The audited
Pi version is `0.85.1`; fixture tests do not establish live upstream compatibility.
Do not advertise a platform until its extracted payload passes host conformance.
The current shebang launcher is POSIX-oriented; Windows requires a separately
verified launcher. No runtime dependencies or credentials are bundled.

`pnpm --filter @cadencr/pi-provider smoke` starts real Pi for prompt-free discovery/session checks. Live and
resume QA additionally send billable prompts and require explicit opt-in.

The candidate recommendation pins Pi `0.85.1` because its public installed protocol
sources were audited. Actual live QA against that version is still pending; this
is not a verified compatibility claim. JSONL frames are limited to 16 MiB of UTF-8
bytes per frame, accommodating substantial base64 image inputs while bounding
unterminated input. Larger image frames must be resized or rejected.

Packaging refuses an existing payload directory, including symlinks. Use
`pnpm --filter @cadencr/pi-provider package:plugin --directory /absolute/new/payload` for a fresh target. The sorted
manifest is written beside it as `payload.SHA256SUMS`. No existing payload is
removed or replaced.
