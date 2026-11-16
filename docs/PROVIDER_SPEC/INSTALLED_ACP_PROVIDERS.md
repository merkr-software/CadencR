# Installed code-backed providers (local substrate)

> - **Status:** Backend and developer-project substrate implemented; general-purpose desktop installation deliberately withdrawn
> - **Last reviewed:** 2026-10-13 against v0.13.0 (local creation/import and inactive public marketplace)
> - **Code:** `packages/service/src/domain/agents/providers/installed/`
> - **Executable contract:** [`PROVIDER_PACKAGE.md`](./PROVIDER_PACKAGE.md)

A provider joins the runtime registry through a descriptor, but the descriptor
is only identity and host launch policy. The referenced executable must contain
provider-specific code implementing Cadencr's mandatory pre-session `models`
command and its live ACP v1 mapping. Pointing Cadencr at an arbitrary ACP
executable is not sufficient.

Developers can create this substrate from Settings → Providers → **Add
provider**. That flow creates an ordinary Git-backed Cadencr project with
`README.md` and `INSTRUCTION.md`, plus a local descriptor targeting the
project's `bin/provider` build output. It does not download or admit third-party
code, and it does not change the user's ordinary pane or worktree layout. See
[`PROVIDER_PACKAGE.md`](./PROVIDER_PACKAGE.md#developer-workspace-generator).

The user configures and authenticates the provider's native CLI before using the
connector. Provider-account authentication is outside Cadencr: descriptors and
future packages cannot contain credentials or authentication behavior, and the
generic adapter does not broker ACP authentication. Cadencr's loopback API
authentication and package signature/checksum verification are separate host
security requirements.

## Local creation and import in v0.13.0

![Current provider connector entry point](../../packages/landing/src/assets/docs/v0.13.0/providers.png)

Settings → CLI Providers → Add provider can also import an existing Git repository
whose code-backed connector has already been built at the required executable
path. Importing source does not build or install dependencies. Validation and
model discovery use the same executable contract as a generated connector.
Restart Cadencr after registration or descriptor changes to activate them.

Public marketplace browsing, package installation, and publication are inactive
in this release. The developer-project flow and local descriptor lifecycle remain
available. See [release configuration](../MARKETPLACE_RELEASE_CONFIG.md) and the
[user guide](../../packages/landing/src/pages/docs/providers.mdx).

## Where descriptors live

`<settings-dir>/providers/<agent-id>.json`, which is `~/.cadencr/settings/providers/`
in a packaged build and `<db-dir>/cadencr-settings/providers/` in a dev run.
The directory is scanned **once at startup**, in file-name order.

The file name must equal the agent's `id`. The directory is how a user manages
installs, so a file whose name disagrees with the identity inside it is refused
rather than silently trusted.

Lifecycle writes replace descriptor files atomically with owner-only `0600`
permissions on Unix. This matters because executable arguments and environment
values may contain credentials.

## Descriptor format

```jsonc
{
  // Cadencr host envelope version. Only `1` is understood today.
  "schema_version": 1,

  // Registry-shaped portable agent metadata.
  // https://github.com/agentclientprotocol/registry — agent.schema.json
  "agent": {
    "id": "acme-agent", // ^[a-z][a-z0-9-]*$
    "name": "Acme Agent", // display name; becomes the catalog label
    "version": "1.4.0", // MAJOR.MINOR.PATCH (suffixes allowed)
    "description": "An ACP agent",
    "repository": "https://github.com/acme/agent",
    "website": "https://acme.dev",
    "authors": ["Acme"],
    "license": "MIT",
    // Local developer packages use the ACP Registry repository convention:
    // the portable entry names a relative package asset.
    "icon": "icon.svg",

    // Optional only in Cadencr's hand-written local profile. The strict ACP
    // Registry validation profile requires this field.
    "distribution": {
      "binary": {
        "darwin-aarch64": {
          "archive": "https://github.com/acme/agent/releases/download/v1.4.0/acme-darwin-arm64.tar.gz",
          "sha256": "…64 hex chars…",
          "cmd": "acme",
        },
      },
    },
  },

  // Cadencr host policy. Never part of the portable entry.
  "installation": {
    "enabled": true, // default true
    "assets": {
      "directory": "/opt/acme", // absolute package root; never returned to the renderer
    },
    "executable": {
      "command": "/opt/acme/bin/cadencr-acme-provider", // absolute path, required
      "args": ["--region", "eu"], // appended provider args, never a shell string
      "env": { "ACME_REGION": "eu" }, // local non-secret launch config only
    },
  },
}
```

Fields Cadencr does not model at the top level of `agent` are preserved verbatim.
The host envelope (`schema_version`, `installation`) is Cadencr's own, so an
unknown key there is a typo rather than a newer registry field: it is refused,
not ignored.

### Validation profiles

| Profile                      | `distribution` | Additional policy                                                       |
| ---------------------------- | -------------- | ----------------------------------------------------------------------- |
| Local host descriptor        | Optional       | Rejects ACP-owned capability fields and whitespace-only launch metadata |
| Strict ACP Registry v1 entry | Required       | Mirrors the pinned upstream `agent.schema.json` shape                   |

Both profiles validate every supplied registry field: URI-formatted
`repository`, `website`, and binary `archive`; id and version patterns;
distribution cardinality; platform keys; checksum syntax; and typed, non-null
properties. The upstream root schema permits additional properties, so unknown
root fields round-trip through `AcpAgentEntry::extra`. Its nested distribution
objects set `additionalProperties: false`, so unknown nested fields are rejected
rather than silently dropped.

The vendored upstream snapshots live at
`packages/service/tests/fixtures/acp_registry/v1/`: the v1 schema plus a real
`claude-acp` entry. Tests validate the entry and compare its serialized value to
the original JSON, making schema drift or data loss an explicit source change.

**A descriptor may not declare capabilities or provider-account authentication.**
No models, modes, permission maps, thought levels, auth methods, or credentials.
Models come from executable code through the required
`models --format acp-config-options-v1` command; session state and other runtime
capabilities come from `initialize` and session setup. Such a descriptor field
is rejected with `DESCRIPTOR_SCHEMA_VIOLATION`. The user preconfigures the native
CLI outside Cadencr.

## What this build does and does not do

| Supported                                                                                    | Deferred                                                                                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Code-backed `models` discovery plus ACP v1 runtime                                           | ACP v2                                                                                   |
| An explicitly selected local provider-package executable                                     | Normal-user marketplace browsing/install UI                                              |
| Startup loading plus durable add/enable/disable/remove HTTP operations                       | Hot activation / reload                                                                  |
| Explicit `restart_required` activation semantics                                             | General-purpose desktop provider installation                                            |
| Strict descriptor validation and lossless typed round-trip                                   | Portable registry import/export workflow (managed signed-index ingestion is implemented) |
| Provider-neutral live select/boolean configuration snapshot plus authenticated WS get/set    | Richer ACP configuration types beyond the v1 baseline                                    |
| Connector-owned `icon.svg`, bounded and inlined from its host-declared package root          | Release signing-key/blocklist provisioning                                               |
| Pre-prompt validation that live ACP still contains and confirms the selected model           | Packaged-app validation of a real signed distribution                                    |
| Opaque option IDs and authoritative replacement from `session/set_config_option`             | Category-specific placement and built-in-control migration                               |
| Stable durable restore (`session/resume`, legacy `session/load` fallback) and graceful close | Marketplace package-management UI                                                        |

## Requirements on the provider executable

Before ACP starts, the executable must satisfy the command contract in
[`PROVIDER_PACKAGE.md`](./PROVIDER_PACKAGE.md). Cadencr only marks an installed
provider available when `models` returns a verified non-empty model catalog and
a default belonging to that catalog. Discovery failures remain visible as an
unavailable provider; they never fall through to a speculative first prompt.

The runtime baseline from `BOUNDARIES.md` §"Minimum ACP v1 admission contract":
`initialize` at protocol version 1, `session/new`, `session/prompt`,
`session/cancel`, and `session/update`, with standard JSON-RPC errors for
optional methods it does not implement. Optional capabilities widen what the
workspace can offer; they are never an admission requirement. Model discovery
is preflighted on catalog access. Managed package admission also runs bounded,
prompt-free `version`, model, initialize, disposable-session reconciliation,
conditional resume/load, and close probes before activation, records the
non-secret evidence, and repeats conformance on rollback.
The client advertises ACP v1 boolean configuration support. Options returned by
`session/new`, stable `session/resume`, or legacy `session/load` become the live provider-neutral snapshot, and a
successful `session/set_config_option` response replaces that snapshot with its
complete `configOptions` list. Descriptors still cannot declare any of these
values. For code-backed installed providers, the selected pre-session model is
checked against the live ACP selector, applied, and confirmed before
`session/prompt` is allowed.
`packages/service/tests/fixtures/fake_acp_agent.py` provides minimal, rich, and
durable deterministic ACP v1 modes. The rich mode exercises commands,
select/boolean configuration, permissions, plans, usage/cost, shell and edit
tools, diffs, and an MCP-shaped tool call; its "gate" prompt raises the
`AskUserQuestion` and `ExitPlanMode` gates described below. The durable mode persists context and
requires `session/load` after the first subprocess is closed. The `--host`
mode declares the optional host conventions below (mode and access selectors,
`host-integration`, `embeddedContext`, agent-initiated mode switches,
background sub-agents); `tests/installed_acp_host_conventions_test.rs` drives
it through the runtime, HTTP catalog/diagnostics/settings, and WebSocket.
`--slash-commands` / `--slash-commands-invalid` / `--slash-commands-failing`
cover the optional `slash-commands` command and `--live-commands` sends an
`available_commands_update` after `session/new`;
`tests/installed_acp_slash_commands_test.rs` drives them through
`GET /api/prompt-commands`.
`tests/installed_acp_provider_test.rs` drives those modes through the runtime
registry and the Cadencr host-authenticated HTTP + real WebSocket surfaces, including
interruption of an active turn and subprocess-restart resume. ACP v2 lifecycle
remains separate, deferred coverage.

Stable v1 restore prefers `sessionCapabilities.resume` plus `session/resume`,
retains legacy load only as fallback, and sends an advertised, bounded
`session/close` before terminating the child. An explicit resume that neither
path supports fails rather than calling `session/new`; replay suppression is
enabled only for legacy load. These are handshake-owned runtime capabilities,
never descriptor fields.

## Host conventions for input-collecting gates

Cadencr's question drawer and plan gate are driven purely by tool name, so an
installed provider reaches them through standard ACP
`session/request_permission` — no extension methods and no descriptor fields.
These rules are normative for every installed provider:

1. **Tool identity.** The host reads the tool name from the programmatic
   `toolCall.name` (the `toolName` extension is also accepted) and falls back
   to `title` only when neither is present. `title` stays display text.
2. **`AskUserQuestion`.** A permission request whose tool name is
   `AskUserQuestion` opens the question drawer. Its `toolCall.rawInput` is the
   question payload and must follow Claude Code's `AskUserQuestion` input shape
   (`{ "questions": [{ "question", "header", "multiSelect", "options": [{ "label",
   "description"? }] }] }`). The matching `tool_call` notification should carry
   the same `name`; the host renders no tool card for it.
3. **`ExitPlanMode`.** A permission request whose tool name is `ExitPlanMode`
   opens the plan gate; `rawInput.plan` is the plan text. The host treats it as
   a plan approval: rejecting with feedback keeps the turn running, and the
   host never switches permission modes for a provider that advertises none.
   For a provider that maps modes, approving moves the session to its primary
   edit mode (see below).
4. **Options.** Offer at least one `allow_once` and one `reject_once` option.
   The question drawer and plan gate may answer with a decision only; the host
   selects the agent's own option for that decision (falling back to the
   canonical `allow_once` / `reject_once` ids only when none is offered).
5. **Answers ride `_meta`.** The `RequestPermissionResponse` carries the
   user's input under `_meta`:
   - `_meta.updatedInput` — present when the user supplied input. For
     `AskUserQuestion` it is the original `rawInput` plus
     `answers: { "<question text>": "<label>[, <label>…]" }` and, when option
     ids were available, `structured_answers`. An absent or `null` value means
     no edited input.
   - `_meta.feedback` — the user's free-text reason (plan feedback, deny
     reason). It is also mirrored as a top-level `feedback` field for older
     agents.

   For example, an answered question:

   ```json
   {
     "outcome": { "outcome": "selected", "optionId": "answer" },
     "_meta": {
       "updatedInput": {
         "questions": [{ "question": "Color?", "options": [{ "label": "Blue" }] }],
         "answers": { "Color?": "Blue" }
       }
     }
   }
   ```

6. **No caching.** A response that carries `_meta.updatedInput` is never
   recorded as a session-scope grant, so an identical later question prompts
   again.

A connector that wraps a CLI with proprietary question or plan methods
translates them into these standard requests and maps the response back
itself; the host does not route provider extension methods.

## Host conventions for modes and access modes

Mode and access-mode selectors are declared in the `models` output
([`PROVIDER_PACKAGE.md`](./PROVIDER_PACKAGE.md#mode-and-access-mode-selectors)).
At runtime:

1. **Applying a mode.** At spawn (before the first prompt) and on every mode
   change, the host maps its permission mode to the provider value. When the
   live session exposes a `select` option with `"category": "mode"`, it sends
   `session/set_config_option { configId: <that option id>, value }` and
   replaces its configuration snapshot with the response; otherwise it falls
   back to `session/set_mode` with the same value. A refusal fails the spawn or
   the mode change visibly.
2. **Following the agent.** A `current_mode_update`, or a
   `config_option_update` whose mode option changed, that lands on a mapped
   value updates the session's permission mode: it is persisted and every
   viewer receives `session.mode.changed`. Unmapped values only update the
   runtime's local state.
3. **Access modes.** When the requested host access mode is mapped, the host
   applies it at spawn (before the first prompt) and on every live change
   through `session/set_config_option` on the live option whose option-level
   `_meta.cadencr.role` is `"access_mode"` (the id from `models` when the live
   session does not expose one). A provider error fails the spawn or the
   `access_mode.set` request with `MODE_REJECTED_BY_CLI`; nothing is retried
   silently. `access_mode.set` only accepts a mode the provider maps.
4. **Remembered default.** The workspace default for new conversations is the
   generic workspace setting `provider_access_mode.<provider_id>`, value
   `default | fullAccess | autoReview` (default `default`). The key is
   writable for any provider id matching the registry pattern
   `^[a-z][a-z0-9-]*$`, is validated against those three values, and is
   user-only: agent settings tools refuse to change it because `fullAccess`
   lifts approval gates.

## Host conventions for compaction, worktrees and resume

These come from the optional `host-integration` command
([`PROVIDER_PACKAGE.md`](./PROVIDER_PACKAGE.md#host-integration-command)).
With a valid `compactCommand`, the catalog reports `compact_action: true`; the
runtime's `compact()` sends `session/prompt` with `/<compactCommand>`, emits
the manual-compaction turn start, and closes it with a compact boundary unless
the agent reported its own. `worktreeConfigPaths` feed the adapter's worktree
config list, and `resumeCommand` is reported as the catalog's
`resume_command`. Rejections and missing commands are reported as
`host_integration_issue` on the installed-provider diagnostics.

## Host conventions for slash commands

The `/` menu of an installed provider comes from the optional
`slash-commands` command
([`PROVIDER_PACKAGE.md`](./PROVIDER_PACKAGE.md#slash-commands-command)), run
per conversation directory before any session exists, plus the last
`available_commands_update` a live session sent for that directory (its
entries the package did not list are appended). A package without the command
therefore shows the live snapshot after its first session in that directory;
one with it shows its list from the first keystroke. A live
`available_commands_update` still replaces the menu during the session and
drops the cached listing for that directory. A failed or rejected listing is
returned as `error` on `GET /api/prompt-commands` and on the WebSocket
`commands.list` reply, and shown in the `/` menu; the host's own commands stay
usable. `_meta.cadencr.kind: "skill"` on a live `availableCommands` entry
groups it with skills. Nothing here branches on a provider id.

## Background sub-agents

ACP has no notion of a dispatch tool call that returns while its sub-agent
keeps working. On a carrier `tool_call` / `tool_call_update` (a tool named
`Task` or `Agent`: only those create a sub-agent run, so the declaration is
read on any call but has an effect only there), `_meta.cadencr.subagent`
declares one:

- `{"background": true}` marks the carrier as a background launch. It may ride
  the `tool_call`, any update, or the very `tool_call_update` whose `status` is
  `completed` — the host reads it before treating that status as the end of
  the sub-agent. When the launching call completes, the sub-agent stays
  `running` with `background: true`: it is exempt from the turn-end sweep and
  keeps running across turns.
- A later `tool_call_update` with the same `toolCallId` and
  `{"status": "completed" | "failed" | "cancelled", "summary"?: string}`
  finishes it (`cancelled` becomes `stopped` / `interrupted`; `summary` is the
  result summary, and the failure reason for `failed`). It produces no second
  transcript block.
- A background sub-agent that is never finished is stopped
  (`runtime_ended`) when its runtime ends. The session itself is not held
  "working" for it, because an agent may never report the outcome.

Other keys in the object are ignored.

## Prompt capabilities

The host remembers the last `initialize` response's
`agentCapabilities.promptCapabilities` per installed provider (in memory) and
reports it as the catalog's `prompt_capabilities`
(`{image, audio, embedded_context}`), absent until a runtime has been spawned.
A document attachment (PDF) is sent as a standard ACP embedded resource
`{"type": "resource", "resource": {"uri": "file:///attachments/<name>",
"mimeType", "blob"}}`; text files stay inline text. Before `session/prompt` the
runtime refuses, with a visible error, any `image`, `audio` or `resource`
block the agent did not advertise — an attachment is never dropped silently.

## Descriptor lifecycle API

Cadencr host-authenticated loopback API clients can manage descriptor files without
mutating the running registry. Paired remote clients can read diagnostics but
cannot install an executable or alter host launch policy:

| Operation      | Endpoint                                                    | Durable effect                                    |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| Add            | `POST /api/agents/installed-providers`                      | Validates and atomically writes `<agent.id>.json` |
| Enable/disable | `PUT /api/agents/installed-providers/{provider_id}/enabled` | Atomically changes `installation.enabled`         |
| Remove         | `DELETE /api/agents/installed-providers/{provider_id}`      | Moves the descriptor to the OS trash              |

The registry is immutable for the process lifetime. Responses therefore report
`active_now`, `active_after_restart`, `enabled_after_restart`, and
`restart_required`. The latter is true exactly when current activation differs
from next-boot activation, including a repeated disable of a still-active
provider. Existing sessions and transcripts are untouched; a provider that is
disabled or removed remains active for this process until restart. Its ID also
remains reserved by the running registry, so it cannot be reinstalled with a
different launch configuration before that restart.
The diagnostics route rescans descriptor files, so durable changes are visible
immediately while its `registered` field continues to report the current
process registry.

## Desktop exposure

The free-form **Add local ACP provider** dialog is intentionally not shipped.
Model discovery and native-to-ACP mapping require provider-owned code, while a
simple path/arguments/environment form falsely implies that any ACP executable
is sufficient. The local lifecycle API remains developer-only. The signed
code-and-assets transaction, conformance, install-history, blocklist, and
process-policy backends now exist behind separate host-authenticated loopback
APIs. The normal-user marketplace UI remains a later slice, gated on a real
release signing key/blocklist source and packaged-app verification.

Installed providers still carry `origin: "installed_local"` in the service
catalog. Shared desktop/runtime code may use this provider-neutral origin and
generic session-configuration snapshots; it must never add a `pi` or other
provider-ID branch.

Lifecycle-specific refusal codes use the standard `{ error, code }` envelope:

| Code                         | Meaning                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PROVIDER_ALREADY_INSTALLED` | The normalized id has a descriptor, belongs to a built-in id/alias, or is still active in this process |
| `PROVIDER_NOT_INSTALLED`     | No valid descriptor exists at that id's path                                                           |

Descriptor validation failures reuse the stable rejection codes below.

## When a descriptor is refused or quarantined

`GET /api/agents/installed-providers` lists what a current descriptor scan loads
and refuses, and every startup failure is also logged. Two outcomes,
deliberately distinct:

**Rejected** — never becomes a provider, because its identity or shape could not
be trusted:

| Code                           | Meaning                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `DESCRIPTOR_UNREADABLE`        | The file (or the directory) could not be read                                   |
| `DESCRIPTOR_INVALID_JSON`      | Not valid JSON                                                                  |
| `DESCRIPTOR_SCHEMA_VIOLATION`  | JSON, but not a valid host envelope / ACP registry entry                        |
| `UNSUPPORTED_SCHEMA_VERSION`   | `schema_version` is from a newer build                                          |
| `DESCRIPTOR_IDENTITY_MISMATCH` | File name and `agent.id` disagree                                               |
| `DUPLICATE_PROVIDER_ID`        | A built-in id/alias or earlier descriptor owns the normalized public identifier |
| `UNSUPPORTED_DISTRIBUTION`     | No `installation.executable`; local descriptors never download distributions    |
| `INVALID_EXECUTABLE_PATH`      | The command is empty or not absolute                                            |

**Quarantined** — a valid install that cannot run right now. It stays registered
and renders as unavailable with the reason attached, instead of disappearing.
`quarantine_code` (with `quarantine_message`) is the single availability signal;
the catalog's `unavailable` status is derived from it:

| Code                        | Meaning                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `INCOMPATIBLE_PLATFORM`     | The declared distribution names no target for this OS/arch |
| `EXECUTABLE_NOT_FOUND`      | The resolved path is not on disk                           |
| `EXECUTABLE_UNREADABLE`     | The path could not be inspected (permissions, bad path)    |
| `EXECUTABLE_NOT_EXECUTABLE` | The path exists but is not an executable file              |

Built-in providers register first, so a descriptor can never take an id or
public alias they own — `claude`, `anthropic`, `codex`, and `openai` are as
reserved as the canonical built-in ids. Reservation uses the same
case/punctuation-insensitive normalization as provider resolution, preventing
variants such as `claudecode` from shadowing `claude-code`. Enablement does not
enter into it: a disabled descriptor still owns its identifier, so a collision
is refused at load time rather than becoming a surprise the day the user
enables it. The resolver also walks built-ins first, providing defense in depth
if a future registration source bypasses descriptor loading. Ids of
providers that are no longer built in — `cursor` ships as an installed provider
plugin — are not reserved. Conversations recorded under such an id keep their
provider and resume id; until a provider with that id is installed, opening
them fails with `UNSUPPORTED_PROVIDER` instead of starting another provider.

`executable` is reported without its argument vector because arbitrary local
arguments cannot be generically redacted. Future downloaded packages cannot put
provider credentials in arguments or environment; the native CLI is already
configured outside Cadencr.

## Security notes

The executable is exec'd directly with its argument vector — deliberately unlike
the built-in ACP adapters, which go through `$SHELL -l -c "exec …"`. Descriptor
data is marketplace data and must never become shell syntax, and the service
already hydrates its own environment from the login shell at startup, so the
child still inherits a terminal-like `PATH`. A relative command is refused
rather than resolved through `PATH`. Local environment values are host launch
policy: they are never returned by the API and never logged. Downloaded packages
cannot carry provider-account credentials or authentication policy. On Unix the
descriptor itself is atomically stored with mode `0600`. The local-descriptor
process boundary is **not** an OS sandbox — it points at a binary the developer
chose. Managed packages add signed-index/checksum/full-tree verification,
prompt-free conformance, sanitized environments, process-tree termination,
platform resource controls, redacted quarantine, and a cached signed blocklist.
They still do not claim filesystem/network sandboxing; that release gate remains
explicit in `BOUNDARIES.md` Phase 8.
