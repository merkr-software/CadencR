# Cadencr provider: Cursor

This monorepo-owned connector runs the official
[Cursor Agent CLI](https://cursor.com/cli) as `agent [flags] acp` and presents an
ACP v1 agent to Cadencr. It is a stdio proxy written in Rust on
[`cadencr-provider-sdk`](../../../packages/provider-plugin-sdk-rs/README.md):

```text
Cadencr ⇄ connector (ACP agent) ⇄ agent acp (connector acts as ACP client)
```

It replaces Cadencr's former built-in Cursor adapter and keeps the provider id
`cursor`, so conversations started with the built-in resume through it (Cursor
`session/load` with the same session id). Everything Cursor-specific now lives
here, because Cadencr runs installed providers through a generic,
provider-neutral ACP adapter (no tool-name normalization, no extension
methods, strict model-selection verification). Modes, access modes,
worktree configuration and background sub-agents reach the host through the
provider-neutral `_meta.cadencr` and `host-integration` conventions
(`docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md`).

Source lives in `plugins/providers/cursor/`. It is an external connector behind
the provider-neutral installation and conformance boundary, not a built-in
adapter or a bundled desktop provider. This source does not publish, sign,
install, or certify a provider package.

## Prerequisites

Install and sign in to the Cursor Agent CLI with Cursor's own tools:

```bash
curl https://cursor.com/install -fsS | bash
agent login
```

The installer places `agent` in `~/.local/bin`. The connector looks for `agent`
on `PATH`, then in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`,
`/usr/bin` and `/snap/bin`. Set `CADENCR_CURSOR_COMMAND` to an absolute path to
use another executable (this replaces the built-in's `cursor_cli_path`
setting). The CLI is executed directly, never through a login shell: Cadencr
already hydrates its own `PATH` from the login shell before launching
connectors.

Credentials stay with Cursor. The connector never reads them; it only asks
`agent acp` to `authenticate` with `cursor_login`, which reuses `agent login`.
Cursor diagnostics are forwarded to stderr and can contain sensitive details.

## Build and validate

From the monorepo root:

```sh
pnpm run check:plugin:cursor   # rustfmt check + clippy -D warnings
pnpm run test:plugin:cursor    # unit tests + fake-agent end-to-end proxy test
pnpm run build:plugin:cursor   # host-native release build → bin/provider
pnpm run package:plugin:cursor --directory /absolute/new/cursor-payload
```

The crate (`cadencr-plugin-provider-cursor`) is a Cargo workspace member, so
`pnpm rust -- test -p cadencr-plugin-provider-cursor` and the workspace-wide
Rust CI checks cover it. `tests/proxy_e2e.rs` drives the built binary against
`tests/fixtures/fake_agent.py` (Python 3), a scripted stand-in for `agent`.
Generated `bin/provider` and `dist/` output are ignored, never committed.

## Executable contract

| Command                                                         | Behavior                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `models --format acp-config-options-v1 --cwd <dir>`             | Runs `agent models` in `<dir>` (15 s timeout) and prints the same three selects as a live session: `mode`, `model` (values are the cold catalog ids — `auto`, `composer-2-fast`, `gpt-5.3-codex-high`, … — `currentValue` is the `(current)` entry or the first) and `access`, with their `_meta.cadencr` mappings. Failures say to run `agent login`; a missing CLI names the installer.                 |
| `host-integration --format cadencr-host-integration-v1`         | `{"worktreeConfigPaths": [".cursor/rules", ".cursor/commands", ".cursor/skills", ".cursor/mcp.json", ".cursor/cli.json"]}` — no `compactCommand` and no `resumeCommand` (see [Deliberate limitations](#deliberate-limitations)).                                                                                                                                                                          |
| `slash-commands --format cadencr-slash-commands-v1 --cwd <dir>` | Prints Cursor's `/` catalog for `<dir>` without starting `agent acp`: `copy-request-id`, the project's and `~`'s `.claude/commands` / `.cursor/commands` files, and the `SKILL.md` skills Cursor lists (`~/.cursor/skills-cursor`, then `.cursor`, `.claude`, `.codex`, `.grok`, `.agents` `skills/`), with Cursor's descriptions; skills carry `"kind": "skill"`. See [Slash commands](#slash-commands). |
| `run --protocol acp-v1 [args…]`                                 | ACP proxy. Descriptor arguments are passed to `agent` before the access flags and `acp`.                                                                                                                                                                                                                                                                                                                  |
| `version`                                                       | Connector version (`0.1.0`).                                                                                                                                                                                                                                                                                                                                                                              |
| `updates --format cadencr-updates-v1`                           | Installed Cursor CLI version (`agent --version`) and the latest build pinned by `https://cursor.com/install` (fetched with the system `curl`).                                                                                                                                                                                                                                                            |
| `update`                                                        | Runs `agent update` noninteractively. Only the latest build is installable; `--version` is refused.                                                                                                                                                                                                                                                                                                       |

Stdout carries only JSON/ACP; diagnostics go to stderr. On stdin EOF, SIGTERM or
SIGINT the connector stops the `agent` process group (SIGTERM, SIGKILL after
2 s). The child runs in its own process group so restarts and shutdown reach
everything it started; if the connector is killed outright, Cursor exits on
stdin EOF.

## Feature mapping

### Initialization

The host's `initialize` is forwarded with
`clientCapabilities._meta.parameterizedModelPicker: true`, which makes Cursor
advertise clean model ids plus separate `fast` / thought-level options. When
the response advertises the `cursor_login` auth method the connector sends
`authenticate {methodId: "cursor_login"}` (60 s timeout) before answering; a
failure tells the user to run `agent login`.

### Configuration options presented to Cadencr

Every `configOptions` list the host receives (`session/new`, `session/load`,
`session/resume`, `session/set_config_option`, `config_option_update`) is:

| Option id                                      | Type   | Values                                                                                                                                                      | Source                                                                                                                            |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `mode` (category `mode`)                       | select | `agent` (Agent), `plan` (Plan), `ask` (Ask)                                                                                                                 | Cursor's own option; known values get the catalog name, description and `_meta.cadencr.permissionMode` (`default`, `plan`, `ask`) |
| `model` (category `model`)                     | select | cold `agent models` catalog ids                                                                                                                             | connector view of Cursor's `model` + companions                                                                                   |
| `access` (`_meta.cadencr.role: "access_mode"`) | select | `default` (Default), `full_access` (Full Access), `auto_review` (Auto Review), each with `_meta.cadencr.accessMode` (`default`, `fullAccess`, `autoReview`) | connector-owned                                                                                                                   |

The cold `models` output carries the identical `mode` and `access` selects
(mode `currentValue` `agent`, access `default`), so Cadencr's catalog modes and
access modes match every live snapshot. Values a newer Cursor adds to `mode`
pass through without `_meta` and stay hidden from the mode chip.

Cursor's `fast` and thought-level options (`effort`, `reasoning`,
`thinkingEffort`, `thought_level`, or any `thought_level` category option) are
hidden: they are folded into the catalog id. The unstable `models` field of
session responses is dropped. `model.currentValue` is the last catalog id the
host applied; before that it is the first catalog id whose decomposition
matches Cursor's live model and companions, else the catalog default. If
`agent models` fails inside `run`, the choices fall back to Cursor's live base
models (`default` shown as `auto`).

`session/set_config_option(model=<catalog id>)` decomposes the id exactly like
the built-in did — `composer-2.5-fast` → base `composer-2.5` + `fast=true`,
`gpt-5.3-codex-high` → base `gpt-5.3-codex` + effort `high`, `*-thinking*` →
thinking on, `auto` → `default` — sets the base model on Cursor, re-resolves
the companions from the model-change response (a model without `fast` never
receives a stale `fast`; explicit non-fast ids turn Fast off), sets each one,
and answers with the full rewritten list. Other option ids are forwarded.

### Access modes

| `access`      | `agent` launch flags                  |
| ------------- | ------------------------------------- |
| `default`     | `--sandbox enabled acp`               |
| `full_access` | `--force --sandbox disabled acp`      |
| `auto_review` | `--auto-review --sandbox enabled acp` |

Default ↔ Auto Review switch in place. A change into or out of Full Access
restarts `agent` with the new flags, replays `initialize`/`authenticate`, and
restores every session with `session/load` (same `sessionId`, `cwd`,
`mcpServers`) while suppressing the replayed history, then re-applies the
previous mode and catalog model. It is refused while a turn is running, and
when Cursor does not advertise `loadSession`.

Cursor saves a conversation only when its first prompt runs; before that,
`session/load` answers “Session not found” and a restart would lose the
session. Cadencr applies the remembered access mode right after
`session/new`, so a switch into Full Access before the first prompt is
accepted and deferred: during that first turn the connector answers each
Cursor permission request `allow_once` (Cursor's sandbox stays on, so the turn
never gets more than Full Access), then restarts `agent` with the Full Access
flags before answering the turn. Leaving Full Access before a fresh session's
first prompt is refused with an explicit error.

Auto Review keeps the built-in's preflight: Cursor's ACP bootstrap ignores
`--auto-review`, so a permission request whose only reasons are plain
`Not in allowlist: <command>` shell misses is answered `allow_once` by the
connector. Safety-policy reasons (delete protection, blocklists, hooks), MCP
and other non-shell requests still reach the user.

### Tool calls

`tool_call` / `tool_call_update` updates and `session/request_permission`
tool calls get Cadencr's canonical tool name in the standard ACP `name` field
(`toolName` too, in permission requests) and canonical `rawInput` keys:
`shell`/`terminal`/`shellToolCall` → `Bash`, `write_file` → `Write`
(`path`/`fileText` → `file_path`/`content`), `Edit` (`oldText`/`newText` →
`old_string`/`new_string`), `ApplyPatch`, `Read`, `Search`, `Move`,
`SwitchMode`, `GenerateImage`, `TodoWrite`, `Task: …` → `Agent`, and Cursor's
`MCP: tool` / `<server>-<tool>: <tool>` titles → `mcp__<server>__<tool>` with
`{server, tool, arguments}` input (arguments recovered from the permission's
single JSON text block). Names are remembered per `toolCallId`, so bare
updates keep their start's name.

### Cursor extensions

| Cursor method           | What Cadencr receives                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cursor/update_todos`   | standard ACP `plan` update (`cancelled` → `pending`; Cursor ids and statuses in each entry's `_meta`); requests get `{}`                                                                                                                                                                                                                                                                                                      |
| `cursor/task`           | `tool_call_update` on the matching call, `name: "Agent"`, `rawInput {description, prompt, subagentType, model, agentId, durationMs}` (`{custom: name}` → name, `unspecified` dropped); an `Agent` call Cursor reports `completed` with `rawOutput.error` becomes `failed`; one reported `completed` with `rawOutput.isBackground: true` gets `_meta.cadencr.subagent: {background: true}` (and `rawInput.isBackground: true`) |
| `cursor/generate_image` | `GenerateImage` tool call carrying the raw payload                                                                                                                                                                                                                                                                                                                                                                            |
| `cursor/ask_question`   | a pending `tool_call` named `AskUserQuestion` (`rawInput {questions: [{question, id, options: [{label, id}], multiSelect}], title}`), then `session/request_permission` with the same tool call and options `submit` (allow_once, “Submit answers”) / `reject` (reject_once, “Reject”)                                                                                                                                        |
| `cursor/create_plan`    | a pending `tool_call` named `ExitPlanMode` (`rawInput {plan, name, overview, todos, isProject, phases}`), then `session/request_permission` whose JSON-RPC id is the plan's `toolCallId`, options `approve` (allow_once, “Approve plan”) / `reject` (reject_once, “Reject”)                                                                                                                                                   |

Host response conventions the connector relies on:

- `_meta.updatedInput` on the AskUserQuestion permission response: the
  drawer's `{answers: {<question text>: "<label>, …"}, structured_answers:
  [{selectedOptionIds: […]}]}`. It becomes Cursor's `answered` outcome
  (structured ids first, labels mapped back to ids, free text through
  `__freeform_other__` + `freeformText`).
- `_meta.feedback` (or top-level `feedback`) on a rejection: Cursor's
  `skipped` reason (`cancelled` when the feedback is “cancel(led)” or the
  outcome is `cancelled`), or the plan's `rejected` reason.

An approved plan switches Cursor to `agent` (`session/set_mode`), emits
`current_mode_update` and a `config_option_update`, answers Cursor
`{outcome: {outcome: "accepted"}}`, and — once Cursor ends the planning turn —
sends the follow-up prompt “Plan approved. Proceed with execution.” before
answering the host's original `session/prompt`, so planning and execution
stay one host turn.

Everything else is forwarded unchanged in both directions (`fs/*`,
`terminal/*`, `session/cancel`, `session/close`, unknown methods, whose
method-not-found errors pass through).

## Slash commands

`slash-commands` reproduces the list Cursor Agent 2026.10.22's ACP server
sends in `available_commands_update` (the CLI's `custom-commands.ts` loader):
same sources, order, ids and descriptions (`<title> (project)`,
`<description> (user skill)`, …), the project root being the nearest ancestor
with `.git`. It was checked against live frames from two scratch repositories
(the user's real `~/.claude`, `~/.agents` and `~/.cursor/skills-cursor`
skills included): identical once the server-side entries below are removed.
The proxy rewrites live `available_commands_update` frames the same way:
names with whitespace are dropped (Cursor lists `Has Space.md` as `Has Space`
but cannot invoke it), duplicate names keep the first entry, and skills get
`_meta.cadencr.kind: "skill"`.

Not reproducible from the filesystem: team commands and Cursor's "global"
commands (`/worktree`, `/best-of-n`, `/simplify`, … marked `(global)`), which
the CLI fetches from Cursor's dashboard API. Cadencr adds them from the last
live session in that directory. The file order is name order (Cursor uses raw
directory order) and frontmatter is a YAML subset of what js-yaml accepts.

## Deliberate limitations

- **No context usage.** Cursor ACP exposes no authoritative context occupancy;
  nothing is guessed.
- **No compaction command.** Cursor Agent 2026.10.22's ACP server has none:
  `/compress` and `/summarize` exist only in the interactive TUI. Sent over
  ACP, `/compress` is an ordinary prompt the model tries to interpret (checked
  live), and it is absent from `available_commands_update`. The former
  built-in's `/compress` compact prompt had the same problem, so
  `host-integration` declares no `compactCommand`.
- **No resume-in-terminal command.** The `sessionId` Cadencr stores is
  Cursor's ACP session id, passed through unchanged (access restarts
  `session/load` the same id). Cursor stores ACP sessions in
  `~/.cursor/acp-sessions/<id>`, separately from interactive chats
  (`~/.cursor/chats/<workspace hash>/<id>`), and `agent --resume <ACP id>`
  opens an empty chat under that id instead of the conversation (checked
  live), so `host-integration` declares no `resumeCommand`.
- **Access mode resets to Default** whenever a new connector process starts;
  Cadencr re-applies the remembered workspace access mode through the
  `access` option (see the first-prompt deferral above).
- **Sub-agents hold the prompt open.** The connector negotiates Cursor's
  `clientCapabilities.subagents`, so Cursor announces each sub-agent with
  `subagent_spawned` (`_meta.cursor.toolCallId`), streams the child's updates
  under a separate session id and ends it with `subagent_state_update`
  (`completed`/`failed`/`cancelled`/`disconnected`). The connector nests the
  child's tool calls under the launching `Agent` call on the parent session
  (`parentToolCallId`), keeps the child's text as the run's summary (its
  other updates are dropped), and ends the run with a `tool_call_update` of
  the launching call carrying `_meta.cadencr.subagent.status` (`disconnected`
  → `failed`). In exchange, Cursor keeps the parent's `session/prompt` open
  until background runs finish, then adds a summary message: measured live,
  a turn launching a `sleep 40` background sub-agent ended after 58 s instead
  of 9 s.
- **Thinking-effort chip.** Effort is chosen through the catalog id; the host's
  separate effort control stays empty because thought-level options are hidden.
- Composer may simply not emit `cursor/ask_question` / `cursor/create_plan` for
  a given turn; Read/Search starts still omit ACP `locations` and raw arguments.
- macOS and Linux only (no Windows build).

## Release status

Compiled providers use a separate path from the tracked-blob preparation in
`plugins/release-policy.json`. The
[native build workflow](../../../.github/workflows/cursor-provider-build.yml)
builds and tests this connector on macOS arm64/Intel and Linux arm64/x86_64.
Each job exercises the **exact distribution executable** with the scripted
Cursor CLI: version, cold/live model reconciliation, ACP initialization, a
scripted turn, session load, access-mode restart and stdin shutdown. The evidence
states `real_cursor_cli: false`; it is native connector conformance, not a test
of Cursor's hosted service or authentication. No personal credentials or paid
model are used. The separate real-CLI smoke evidence below remains scoped to
the host on which it was performed.

The build produces inert payload artifacts plus canonical archives, metadata,
source-pinned submission and request. `PENDING` URLs in the source template are
resolved only in those generated outputs. No compiled binary is committed.

After reviewing a successful build:

1. Land the reviewed source on `main`, retaining the exact build commit.
2. Create `plugins/provider-cursor/v0.1.0` at that exact commit.
3. Dispatch [the author workflow](../../../.github/workflows/cursor-provider-author.yml)
   from `main` with `source_commit`, `build_run` and 64 zeroes for
   `request_sha256`. Inspect its public candidate and request digest.
4. Dispatch again with the inspected digest. The protected
   `official-plugin-publication` job independently checks repository, native
   build run, source/tag, environment protections, payload hashes and the pinned
   released CLI before loading the separately scoped author credential. It
   reconstructs the request again and never executes a candidate payload.
   Required GitHub environment approval remains an operator action.
5. Submit the emitted package/submission pair to the public registry, publish
   through its protected signing workflow, then verify a managed installation
   before releasing the desktop app.

The author workflow accepts only successful runs of this repository's fixed
native build workflow, with all four declared targets and exact source bindings.
The downloaded candidate from the build is for inspection; the protected job
repackages the native payloads with the pinned CLI and confirms the request hash.
An expired or missing artifact, changed byte, tag mismatch, foreign run, or
failed native check stops publication. Existing versions are never overwritten.

`package-template.json` declares `min_app_version` `0.16.0`, the first app
release that ships the host side of this connector: the removal of the
built-in Cursor adapter, generic `_meta.updatedInput` forwarding, and the
provider-neutral conventions the connector emits (`_meta.cadencr` modes,
access mode and background sub-agents, the `host-integration` and
`slash-commands` commands). On an older host the built-in adapter still owns
the `cursor` id.

## Connector artwork

`icon.svg` was created during AI-assisted Cadencr source maintenance on
2026-11-01 as a neutral connector symbol: a 64-unit rounded background, one
chevron-shaped proxy path, one short output line and three circular nodes,
built from basic local SVG primitives. It is not the Cursor logo, contains no
Cursor artwork, and does not imply endorsement by Anysphere/Cursor. The asset is
licensed under this connector's Apache-2.0 `LICENSE`; its SVG carries an SPDX
notice.

## Source review and package inputs

The connector ports the former built-in sources
(`packages/service/src/domain/agents/cursor/` and `packages/cursor-agent-sdk-rs/`)
and their unit tests. `readiness.json` records the license/artwork digests and
the qualification state: fake end-to-end tests plus a prompt-free smoke check
(`models`, `version`, `updates`) against Cursor Agent `2026.10.22-27dcf5f` on
macOS arm64. No target is release-qualified yet.
