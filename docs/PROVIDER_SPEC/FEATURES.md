# Cadencr Provider Capability Coverage Ledger

> - **Status:** Current built-in coverage and regression reference
> - **Last reviewed:** 2026-08-15 against `v0.12.0`
> - **Public provider contract:** ACP v1, as defined by [`BOUNDARIES.md`](./BOUNDARIES.md)

This document records which user-visible capabilities each built-in provider
currently delivers. It is **not** a marketplace admission checklist and it does
not require an ACP provider to implement every feature below. A third-party
provider is admitted through the minimum ACP v1 contract in `BOUNDARIES.md`.
The current `GenericAcpAdapter` covers local descriptor identity, mandatory
pre-session model discovery, selected-model reconciliation, negotiated ACP
configuration, and the baseline ACP v1 session path. The Pi column below records
live validation of a locally authored `pi-acp` connector; it is evidence for the
generic host path, not a first-party support or marketplace-admission promise.

Claude Code and Codex remain the rich parity references. Their native protocols
may expose more detail than ACP v1, but that detail must be translated inside the
owning adapter rather than becoming a Cadencr-specific provider requirement.
Cursor and OpenCode coverage is intentionally honest: partial or missing rows do
not make the provider invalid.

## How to read this ledger

- ✅ **Implemented:** the companion provider document describes a working path.
- 🟡 **Partial:** useful behavior exists, with a documented limitation.
- ❌ **Missing:** unsupported or affected by a known regression.
- **ACP baseline:** part of the minimum live session path Cadencr requires from an
  installed ACP v1 agent.
- **ACP optional:** advertised through ACP configuration, capabilities, or
  standard events and rendered only when present.
- **Built-in extension:** useful first-party behavior with no stable ACP v1
  equivalent; it remains optional and adapter-owned.

The normative language in the detailed sections applies **only after a provider
advertises or emits that capability**. It defines Cadencr's lossless projection
and safety behavior; it does not turn an optional capability into a marketplace
installation gate. Shared backend and frontend code must consume provider-neutral
types and must not branch on provider identity.

## Coverage matrix

| #   | Feature                                  | Contract class               | Claude Code | Codex | Cursor | OpenCode | Pi via local ACP |
| --- | ---------------------------------------- | ---------------------------- | ----------- | ----- | ------ | -------- | ---------------- |
| 1   | Session modes                            | ACP optional capability      | ✅          | ✅    | ✅     | ✅       | ❌               |
| 2   | Thinking                                 | ACP optional capability      | ✅          | ✅    | ✅     | ✅       | ✅               |
| 3   | Partial / streaming messages             | ACP baseline                 | ✅          | ✅    | ✅     | ✅       | ✅               |
| 4   | Bash tool calls + outputs                | ACP optional capability      | ✅          | ✅    | ✅     | ✅       | ✅               |
| 5   | Edits / Writes / Patch                   | ACP optional capability      | ✅          | ✅    | ✅     | ✅       | ✅               |
| 6   | Sub-agents                               | Contained built-in extension | ✅          | ✅    | 🟡     | ✅       | ❌               |
| 7   | Todo                                     | ACP optional capability      | ✅          | ✅    | ✅     | ✅       | ❌               |
| 8   | Thinking level changes                   | ACP optional capability      | ✅          | ✅    | 🟡     | ✅       | ✅               |
| 9   | Model selection changes                  | ACP optional capability      | ✅          | ✅    | ✅     | ✅       | ✅               |
| 10  | Permissions: yes / no / always / session | ACP optional capability      | ✅          | ✅    | ✅     | ✅       | ❌               |
| 11  | MCP                                      | ACP optional capability      | ✅          | ✅    | 🟡     | ❌       | ❌               |
| 12  | Plan approval                            | Contained built-in extension | ✅          | ✅    | ✅     | ❌       | ❌               |
| 13  | Context usage                            | ACP optional capability      | ✅          | ✅    | ❌     | ✅       | 🟡               |
| 14  | Compaction                               | Contained built-in extension | ✅          | ✅    | ✅     | ✅       | 🟡               |
| 15  | Command + skill list                     | ACP optional capability      | ✅          | ✅    | 🟡     | ✅       | 🟡               |
| 16  | Live follow-up prompt targeting          | ACP baseline                 | ✅          | ✅    | ✅     | ✅       | ✅               |
| 17  | Durable session resume/load              | ACP optional capability      | ✅          | ✅    | ✅     | ❌       | ❌               |

Detailed evidence and limitations remain in
[`CLAUDE_CODE.md`](./CLAUDE_CODE.md), [`CODEX.md`](./CODEX.md),
[`CURSOR.md`](./CURSOR.md), and [`OPENCODE.md`](./OPENCODE.md).

### Pi local ACP validation notes

The Pi column was exercised end to end in the development app with a generated
provider workspace and a code-backed `pi-acp` connector:

- seven Pi models were discovered before session creation, and the user had to
  select a model before the first prompt;
- model-specific thinking levels, including `max` where supported, were
  negotiated and could be changed between turns;
- text and thinking streamed separately; Bash output, file writes, reads,
  structured diffs, image input, cancellation, and serialized live follow-up
  all completed successfully;
- Pi slash commands become available after the ACP session handshake. Session
  statistics, naming, export, steering, follow-up mode, and auto-compaction were
  exercised. A small-session compaction correctly reported that there was
  nothing to compact; a successful large-context compaction was not forced;
- `pi-acp` does not advertise session modes, ACP permission requests,
  sub-agents, or structured todos. It accepts MCP server parameters but does not
  forward them to Pi. It exposes usage through `/session`, but does not emit the
  ACP usage updates needed by Cadencr's context meter;
- Pi can persist sessions, but the generic installed-provider host does not yet
  invoke ACP session loading after a service restart. Cadencr keeps the visible
  transcript, while Pi's runtime context starts fresh.

---

## 1. Modes: default / plan / ask / provider-specific execution modes

Cadencr exposes a single provider-neutral mode enum
(`RuntimePermissionMode`):

- `Default` — interactive build, ask before risky tools.
- `AcceptEdits` — auto-approve file edits, prompt for the rest.
- `BypassPermissions` — auto-approve everything (full-access escape hatch).
- `Plan` — model produces a plan; risky tools are blocked until the user
  approves and the session leaves plan mode.
- `Ask` — read-only Q&A without edits or command execution.
- `Auto` — Claude Code v2.1.83+ classifier-backed mode. Providers without an
  equivalent fall back to their everyday permission level.
- `DontAsk` — no prompts, but no sandbox widening either.

A provider MUST:

1. **Translate the mode at session start.** Pass it on the same call that
   spawns or resumes the underlying agent.
2. **Translate the mode mid-session** when the user toggles it from the UI,
   without recreating the session. The change MUST take effect on the next
   user turn at the latest.
3. **Refuse cleanly** modes it does not support, by mapping them to the
   nearest safer mode and documenting that mapping in its companion doc.

Plan-mode transitions back to a build mode when the user approves the plan
(see §12). The adapter, not generic code, decides which build mode to enter
after approval (e.g. Claude Code routes capable models to `Auto`, others to
`AcceptEdits`).

## 2. Thinking

Reasoning content streams as a distinct content block, never folded into the
user-visible assistant text. The adapter MUST emit:

- `RuntimeContentBlock::Thinking { thinking }` for completed thinking blocks
  attached to an assistant message.
- `RuntimeContentDelta::Thinking { thinking }` inside
  `RuntimeStreamEvent::ContentBlockDelta` for incremental thinking text as
  it arrives from the model.

Thinking deltas use the same `index` the provider assigned the thinking
block at start, so the UI can stitch deltas onto the right block.

A provider that exposes a "summary" form of reasoning (Claude Code's
`--thinking-display summarized`, Codex `summary: "auto"`) SHOULD prefer the
summary; raw chain-of-thought is not surfaced.

## 3. Partial / streaming messages

Assistant text and tool input MUST stream incrementally. The adapter emits:

- `RuntimeStreamEvent::MessageStart` once per assistant message, carrying
  `model` and `input_tokens` if known.
- `RuntimeStreamEvent::ContentBlockStart { index, block }` when a new block
  opens (text, thinking, tool_use, …).
- `RuntimeStreamEvent::ContentBlockDelta { index, delta }` for each chunk
  (`Text`, `Thinking`, or `InputJson` for streaming tool args).
- `RuntimeStreamEvent::ContentBlockStop { index }` when the block closes.
- A turn-complete signal (`RuntimeEventKind::Result` plus
  `RuntimeEventMetadata.usage` and `context_window`).

Block indexes MUST be stable for the lifetime of the turn so deltas always
target the right block. The adapter is responsible for assigning indexes
when the underlying provider does not (Codex assigns its own per-item
indexes in `IndexState`; Claude Code receives indexes from the CLI directly).

## 4. Bash tool calls + outputs

Shell command execution surfaces as a tool with the canonical name
`Bash` regardless of provider:

1. `ContentBlockStart { block: ToolUse { name: "Bash", input: { command, … } } }`
   when the model invokes the tool. Streaming `command` text is allowed via
   `InputJson` deltas.
2. `ContentBlockDelta { delta: InputJson { partial_json } }` carrying the
   accumulated stdout/stderr while the command runs (or after it completes,
   if the underlying provider only emits a final block).
3. `ContentBlockStop` when the command finishes.
4. Either an explicit `RuntimeUserContentBlock::ToolResult` or — when the
   provider folds the result into the same item — a final `InputJson` chunk
   with the full output.

The adapter MUST preserve exit status, stdout, and stderr in the surfaced
JSON. Truncation, if any, is the provider's responsibility and MUST be
indicated in the payload.

## 5. Edits / Writes / Patch

File mutations are normalized to the canonical tool names `Write`, `Edit`,
`MultiEdit`, and `ApplyPatch`. The adapter MUST:

- Emit `ContentBlockStart` for the chosen canonical tool with the file path
  and the change payload (full file for `Write`, before/after for `Edit`,
  patch text for `ApplyPatch`).
- Stream patch updates via `InputJson` deltas when the provider emits
  intermediate states (Codex `item/fileChange/patchUpdated`).
- Carry enough information for Cadencr's diff renderer to compute a unified
  diff without re-reading the file (i.e., either the patch text or both
  pre- and post-state).

A provider whose native edit primitive does not match any canonical name
MUST adapt it (e.g. Codex `fileChange` → `ApplyPatch`).

## 6. Sub-agents

Providers that allow a parent agent to spawn child agents MUST:

- Surface the spawn as a tool call named `Agent` (or `Task`) under the
  parent turn.
- Tag every event produced inside the child with `parent_tool_use_id` set
  to the spawning tool-use id, so the UI can nest the child stream under
  the parent block.
- Preserve the child's own `id`s — child tool uses are not renamed.
- Synthesize the child's final text under the parent `Agent` block when
  the provider only delivers it via a tool result (Codex `wait_agent`,
  `agentsStates[thread_id].message`).

A provider that spawns multiple children concurrently MUST keep a registry
that maps `thread_id` (or equivalent) → `parent_tool_use_id` for the
lifetime of the parent turn.

## 7. Todo

The canonical tool name is `TodoWrite`. The adapter MUST normalize the
provider's plan/todo primitive to a JSON input shape of:

```json
{
  "todos": [
    { "content": "...", "status": "pending|in_progress|completed", "activeForm": "..." }
  ]
}
```

Status values are normalized to snake_case. When the provider streams
incremental plan updates (Codex `turn/plan/updated`), the adapter MUST
re-use the same `ContentBlockStart` index for follow-up deltas so the UI
updates the same todo block in place rather than appending a new one.

Priority and other provider-specific fields MAY be preserved in `tool_input`
but MUST NOT be relied upon by shared code.

## 8. Thinking level changes

The user can change reasoning effort (`low` / `medium` / `high` / `xhigh` /
`max`) at any time. The adapter MUST:

- Accept a new effort value via the internal
  `AgentRuntimeSession::set_thinking_effort`
  surface.
- Apply the new value to the **next user turn**. Mid-turn changes are not
  required.
- Persist the value on the session so resume + retry pick it up.

Providers that cannot change effort without restarting the underlying
process MUST hide that detail from shared code (re-spawn transparently or
queue the change for the next turn boundary).

The set of legal effort values is published per-model via the runtime model
catalog; shared code MUST NOT hardcode effort levels.

## 9. Model selection changes

The user can switch models mid-session. The adapter MUST:

- Accept a new model id via the internal `AgentRuntimeSession::set_model` surface.
- Apply the change on the next user turn. The current turn keeps the model
  it started with.
- Reflect the new model in subsequent `MessageStart.model` and any
  context-window calculations.
- Not retroactively rewrite previous turns.

Model ids are provider-native ids (e.g. `claude-sonnet-4-7`, `gpt-5.5`).
The selected provider owns the runtime adapter. Current selections persist the
provider and model together; legacy model-only selections may fall back to
exact catalog ownership, never model-family or prefix matching.

## 10. Permissions: yes / no / always / session

Cadencr exposes three permission decisions to shared code:

- `AllowOnce` — approve this single tool invocation.
- `AllowFuture` — approve and persist a rule so future similar
  invocations are auto-approved. Persistence scope is provider-defined
  (per-session, per-project, or per-user).
- `Deny` — reject this invocation; the model gets a tool error.

The adapter chooses, per tool, which decisions are offered (Codex offers
`AllowFuture` for `Bash`, `ApplyPatch`, network, and elicitation-mode MCP
tools; not for one-off prompts).

Two integration patterns are both valid:

1. **Bridge pattern** (Codex, OpenCode): the provider emits a permission
   request, the adapter normalizes it to a `RuntimePermissionRequest` and
   forwards it to the frontend over WebSocket via the
   `permission_bridge`. The user's decision flows back through the same
   bridge and is sent to the provider as a typed RPC response.
2. **Hook pattern** (Claude Code): the SDK calls a `can_use_tool` callback
   provided at spawn time. The adapter implements that callback by
   round-tripping the request through the same `permission_bridge`, but
   no `RuntimePermissionRequest` events are emitted on the runtime stream.

Either pattern MUST result in the same UX (four-button prompt in the UI:
Allow once / Allow always / Deny / [optional Always for session]) and the
same persistence guarantees.

The special pseudo-tools `AskUserQuestion` and `ExitPlanMode` are routed
through the same permission channel:

- `AskUserQuestion` — the adapter SHOULD return `Allow` with
  `updated_input` containing the user's answer.
- `ExitPlanMode` — `Allow` approves the plan (see §12); `Deny` rejects it.

## 11. MCP

Each session can be configured with one or more MCP servers (stdio is
required; SSE / HTTP optional). The adapter MUST:

- Accept `RuntimeMcpServerConfig` entries on spawn and translate them to
  the provider's native MCP config shape.
- Emit `RuntimeInitEvent.mcp_servers` with the live status of each
  configured server (`name`, `status`).
- Normalize MCP tool names so they are unambiguous across servers. The
  canonical form is `mcp__<server>__<tool>`.
- Route MCP permission elicitation (servers that opt into per-tool
  approval) through the same permission channel as native tools.
- Support hot-swapping the MCP config when the provider exposes it
  (Claude Code `set_mcp_servers`); otherwise re-spawn the session.

Cadencr-managed MCP servers receive `CADENCR_MCP_APPROVAL_MODE` in their
env so they know whether elicitation-style approval is expected.

## 12. Plan approval

When the user starts a turn in `Plan` mode, the model produces a plan but
must NOT execute risky tools. The adapter MUST:

- Surface the produced plan as a `RuntimeContentBlock::ToolUse` with name
  `ExitPlanMode` and `input.plan` set to the plan text.
- Gate that tool through the permission channel as a `PlanApproval`-kind
  request (`RuntimePermissionResponseKind::PlanApproval`).
- On `Allow`: leave plan mode by issuing an internal `set_permission_mode`
  to a build mode. The adapter — not shared code — picks the target mode
  (`Auto` for capable models, `AcceptEdits` otherwise).
- On `Deny`: stay in plan mode; the user can keep iterating with the
  agent.

A provider whose CLI does not produce an explicit `ExitPlanMode` tool
SHOULD synthesize one when its plan item completes (Codex synthesizes
from `item/completed` of type `Plan`).

## 13. Context usage

After every turn-complete event, the adapter MUST populate
`RuntimeEventMetadata.usage` and `RuntimeEventMetadata.context_window`:

- `usage` carries `input_tokens`, `output_tokens`, and (where the provider
  reports them) cache-creation and cache-read tokens. Cached tokens count
  toward the context window.
- `context_window` is the **authoritative** window size for the model used
  on this turn, taken from the provider's own report. Shared code does NOT
  guess from a hardcoded table.

If the provider reports a baseline overhead (Codex's
`CONTEXT_USAGE_BASELINE_TOKENS`), the adapter MAY subtract it so the value
shown to the user is the variable, user-controllable portion.

The frontend computes `total_input_tokens / context_window * 100` and
displays a percentage. No provider branching at that layer.

## 14. Compaction

The adapter MUST emit a `RuntimeEventKind::CompactBoundary` event whenever
the underlying provider compacts its history, carrying
`RuntimeCompactMetadata { trigger, pre_tokens }`. This drives the UI's
`compact_divider` block.

Compaction triggers come in two flavors:

- **Provider-initiated** (token-pressure compaction). Always supported.
- **User-initiated** via the `/compact` slash command. Optional. Providers
  that support it expose `supports_builtin_compact_command() == true`;
  others delegate to Cadencr's `SummaryReplay` strategy when the user
  asks.

`RuntimeCompactionStrategy` distinguishes these two cases for shared code.

## 15. Command + skill list

Slash commands and skills are surfaced through the same enumeration:
`RuntimeSlashCommand { name, description, kind }` where `kind` is
`Command` or `Skill`. The adapter MUST:

- Discover commands from the provider's live source (Claude Code's
  `initialize` response `slash_commands` + `skills`; Codex's
  `list_commands_in_directory` RPC).
- Refresh the list when the working directory changes (project-local
  commands are CWD-scoped).
- Expose them via the runtime route the frontend already calls
  (`/agents/<provider>/slash-commands`).

Built-in commands (e.g. `/compact`) are merged with project-local commands
in the surfaced list.

## 16. Live follow-up prompt targeting

When a user re-sends a message into an existing session, shared code calls
`AgentRuntimeSession::stream_input` with the message body. The adapter MUST
route it to the **current live session** for that runtime — not start a
new one. Routing identifiers used:

- Claude Code: the `session_id` field on the user message envelope, plus
  the fact that stdin is per-process.
- Codex: the `threadId` carried on `turn/start`.

This live-session routing is distinct from durable recovery after the provider
process or Cadencr restarts.

## 17. Durable session resume/load

A provider that advertises durable resume accepts a stored session through
`RuntimeSpawnConfig.resume_session_id` (Claude Code `--resume`, Codex
`thread/resume`, or ACP `session/load`). Resume MUST be transparent: shared code
asks for the session id, and the adapter handles whether to spawn fresh, resume,
or attach to an already-running process. Providers that do not advertise this
optional capability must start a new provider session without deleting Cadencr's
local transcript.

History replay (re-running prior turns) is NOT a v1 requirement.

---

## Adding a provider

### Marketplace or local ACP provider

An ACP-speaking provider does **not** add Rust, TypeScript, or a provider SDK to
Cadencr. It supplies a validated ACP Registry entry plus host installation data,
and the existing `GenericAcpAdapter` launches it as an external process. Admission
depends on the minimum ACP v1 contract and host policy in `BOUNDARIES.md`, not on
implementing every row in this ledger.

Capability data belongs to ACP `initialize`, `session/new`, and later standard
updates; it must not be copied into the marketplace descriptor as a second source
of truth. The current generic adapter does not yet project every optional
negotiated model, mode, authentication, or configuration control into the desktop.
That provider-neutral bridge is tracked separately in `BOUNDARIES.md`.

### First-party built-in integration

A built-in may still need a dedicated service adapter and transport SDK when its
native protocol preserves behavior ACP v1 cannot represent. In that case it must:

1. keep provider-specific decisions and native-to-neutral translation inside
   `packages/service/src/domain/agents/<provider>/`;
2. keep its SDK transport-only;
3. register its factory once in `providers/registry.rs::BUILTIN_PROVIDERS`;
4. add or update a companion coverage document and executable parity fixtures;
5. add no provider-ID branch to shared service or desktop code.
