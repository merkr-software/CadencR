# Provider capability projection

> Reviewed on 2026-10-13 against v0.13.0. These rules apply to capabilities a
> provider advertises or emits; they do not make every optional feature mandatory.

See [coverage and evidence](./FEATURES.md) for individual providers.

![Current provider settings](../../packages/landing/src/assets/docs/v0.13.0/providers.png)

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
- `DontAsk` — noninteractive execution where supported. Its actual approval and
  sandbox policy is provider-owned; it is not a universal promise of unchanged
  access. See the companion adapter document before equating it with a native mode.

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
  "todos": [{ "content": "...", "status": "pending|in_progress|completed", "activeForm": "..." }]
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

Cadencr exposes semantic permission decisions to shared code:

- `AllowOnce` — approve this single tool invocation.
- `AllowFuture` — approve and persist a rule so future similar
  invocations are auto-approved. Persistence scope is provider-defined
  (per-session, per-project, or per-user).
- `AllowForSession` — allow matching requests for the current session where offered.
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

Either pattern MUST use the shared request UI with only the choices the provider
actually offers. Preserve opaque option IDs, labels, decision scope, and the
provider's persistence guarantees rather than inventing a universal button set.

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

When an authoritative window is known, the frontend computes
`total_input_tokens / context_window * 100`. Otherwise it shows known token counts
and a pending window state, without a guessed percentage. No provider branching
at that layer.

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

## 17. Durable session restore and close

A provider that advertises durable resume accepts a stored session through
`RuntimeSpawnConfig.resume_session_id` (Claude Code `--resume`, Codex
`thread/resume`, or ACP). The installed-provider host prefers
`sessionCapabilities.resume` plus `session/resume`, then uses legacy
`loadSession` plus `session/load` as a compatibility fallback. An explicit
resume that neither path supports MUST fail
visibly rather than start a fresh provider session. Shared code asks for the
session id; the adapter owns the provider-native restore details, and Cadencr's
local transcript remains intact.

When `sessionCapabilities.close` is advertised, Cadencr MUST send a bounded
`session/close` before terminating the provider process. Close failure cannot
leave the child unowned. Resume and close are negotiated runtime capabilities,
not descriptor or marketplace fields.

History replay (re-running prior turns) is NOT a v1 requirement.

---
