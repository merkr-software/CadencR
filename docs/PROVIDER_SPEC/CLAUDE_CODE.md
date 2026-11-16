# Provider status — Claude Code

> Reviewed against v0.13.0 source and release changes on 2026-10-13. This is a
> source review, not a new end-to-end parity certification of every local CLI.

![Current provider settings](../../packages/landing/src/assets/docs/v0.13.0/provider-claude.png)

The Phase 0 catalog contract is pinned by
[`claude_code_catalog.json`](../../packages/service/tests/fixtures/provider_parity/v1/claude_code_catalog.json)
and asserted by an inline adapter test. It covers bootstrap identity, fallback
models, ordering, and default without depending on a locally installed CLI.

Status of the Claude Code adapter against [`FEATURES.md`](./FEATURES.md).

The adapter lives in `packages/service/src/domain/agents/claude_code/`
and speaks to the `claude` CLI via the
`packages/claude-agent-sdk-rs/` SDK. The wire protocol is line-delimited
JSON on the CLI's stdio (`--output-format stream-json
--include-partial-messages`) plus typed `control_request` /
`control_response` envelopes for out-of-band commands.

## Status matrix

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Modes: plan / build / accept-edits | ✅ | `--permission-mode` at spawn; `set_permission_mode` control request mid-session. The CLI applies the new mode immediately to subsequent tool requests in the running turn. Claude-supported modes are translated by the adapter; shared modes are not assumed to have a native equivalent. |
| 2 | Thinking | ✅ | `ContentBlock::Thinking` and `ContentDelta::ThinkingDelta` mapped to runtime thinking blocks/deltas. `--thinking-display summarized` always on. |
| 3 | Partial / streaming messages | ✅ | `StreamEventData::ContentBlockStart/Delta/Stop` + `Result` turn-complete. Indexes assigned by the CLI. |
| 4 | Bash tool calls + outputs | ✅ | `Bash` is a native CLI tool; results flow back as `ToolResult` user-messages. |
| 5 | Edits / Writes / Patch | ✅ | `Write`, `Edit`, `MultiEdit` are native; canonical names are preserved. `ApplyPatch` not used (Claude does not emit it). |
| 6 | Sub-agents | ✅ | `Task` tool + `parent_tool_use_id` on every child message; preserved verbatim. |
| 7 | Todo | ✅ | `TodoWrite` is a native CLI tool; input shape already matches the canonical schema. |
| 8 | Thinking level changes | ✅ | `CLAUDE_CODE_EFFORT_LEVEL` env + `--effort` at spawn; effort changes re-spawn the session transparently for the user. |
| 9 | Model selection changes | ✅ | `set_model` control command applies on next turn. |
| 10 | Permissions: yes / no / always / session | ✅ | SDK `can_use_tool` callback bridged to Cadencr's permission UI. `AllowFuture` writes a `PermissionUpdate` to `userSettings` / `projectSettings` / `localSettings`. |
| 11 | MCP | ✅ | `--mcp-config` at spawn, `set_mcp_servers` mid-session, status from `initialize.mcp_servers`. |
| 12 | Plan approval | ✅ | `ExitPlanMode` gated through `can_use_tool`; on approve, `post_plan_approval_mode_wire` picks `Auto` for capable models else `AcceptEdits`. |
| 13 | Context usage | ✅ | Authoritative `result.modelUsage[model].contextWindow`; `usage.total_input_tokens()` includes cache tokens. |
| 14 | Compaction | ✅ | `compact_boundary` system events mapped to `CompactBoundary { trigger, pre_tokens }`. CLI does not expose a `/compact` command; user-initiated compaction falls back to Cadencr `SummaryReplay`. |
| 15 | Command + skill list | ✅ | `slash_commands` + `skills` from `initialize`; both surfaced as `RuntimeSlashCommand` (kind `Command`). |
| 16 | Replay / send-target detection | ✅ | `--resume <uuid>` on spawn; subsequent user messages routed via `session_id` on the user envelope. |

Legend: ✅ implemented · 🟡 partial · ❌ missing.

---

## Per-feature behavior

### 1. Modes: plan / build / accept-edits

Cadencr's `RuntimePermissionMode` is mapped to the CLI's
`--permission-mode` flag at spawn time
(`claude_code/mod.rs::map_permission_mode`):

| Cadencr mode | CLI flag |
|---|---|
| `Default` | `default` |
| `AcceptEdits` | `acceptEdits` |
| `BypassPermissions` | `bypassPermissions` |
| `Plan` | `plan` |
| `Auto` | `auto` |
| `DontAsk` | `dontAsk` |

Mid-session, the adapter calls `Query::set_permission_mode`, which sends:

```json
{ "type": "control_request", "request_id": "...", "request": { "subtype": "set_permission_mode", "mode": "<flag>" } }
```

Per the official Claude Agent SDK
([Configure permissions → During streaming](https://code.claude.com/docs/en/agent-sdk/permissions))
the CLI applies the new mode **immediately to all subsequent tool
requests**, including tool calls in the currently running turn. This is
the contract Cadencr relies on for two cases:

- **Mid-turn chip switch.** The user toggling the chip while the agent
  is editing affects the very next tool call in the same turn — no need
  to wait for a turn boundary.
- **Post-`ExitPlanMode` build mode.** `WsBridgeCanUseTool` issues a
  `set_permission_mode` *before* returning `Allow` from `can_use_tool`,
  so the CLI exits plan mode straight into the chosen build mode (`auto`
  for capable models, `acceptEdits` otherwise) without prompting on the
  first edit.

The SDK awaits the matching `control_response` and surfaces
`SdkError::ControlRequestFailed` if the CLI rejects the change, or
`SdkError::Timeout` if no response arrives. The Cadencr WS handler
gates `mode.changed` broadcasts on `Ok(())` so the FE chip never claims
a mode the CLI didn't actually accept (see `no-optimistic-updates.md`).

There is no schema drift between runtime modes and CLI modes — they
are 1:1.

### 2. Thinking

Two SDK shapes feed the runtime:

- Block form: `ContentBlock::Thinking { thinking }` (final, attached to
  an assistant message). Mapped to `RuntimeContentBlock::Thinking`.
- Streaming form: `ContentDelta::ThinkingDelta { thinking }` inside
  `StreamEventData::ContentBlockDelta`. Mapped to
  `RuntimeContentDelta::Thinking` keyed on the same block index the
  start event used.

The CLI is always launched with `--thinking-display summarized` so the
UI never receives raw chain-of-thought. Opus 4.7+ disables thinking by
default; Cadencr forces summarized output explicitly.

### 3. Partial / streaming messages

The CLI runs with `--output-format stream-json
--include-partial-messages`. The SDK's reader task
(`claude-agent-sdk-rs/src/query.rs`) deserializes each NDJSON line into
`SdkMessage` and forwards it on an mpsc channel. Stream event mapping:

| SDK | Runtime |
|---|---|
| `StreamEvent::MessageStart` | `RuntimeStreamEvent::MessageStart` |
| `StreamEvent::ContentBlockStart` | `RuntimeStreamEvent::ContentBlockStart` |
| `StreamEvent::ContentBlockDelta { TextDelta / ThinkingDelta / InputJsonDelta }` | `RuntimeStreamEvent::ContentBlockDelta` |
| `StreamEvent::ContentBlockStop` | `RuntimeStreamEvent::ContentBlockStop` |
| `Result { subtype, usage, … }` | `RuntimeEventKind::Result` + populated `RuntimeEventMetadata.usage` and `context_window` |

Block indexes come straight from the CLI; the adapter does not rewrite
them.

### 4. Bash tool calls + outputs

Bash is a native CLI tool. Tool invocation arrives as a
`ContentBlock::ToolUse { name: "Bash", input: { command, … } }`; tool
output arrives as a `UserMessage` with a
`ContentBlock::ToolResult { tool_use_id, is_error, content }` whose
`content` carries stdout/stderr packed by the CLI (typically a JSON
object or string, mirrored verbatim).

The adapter does not parse the Bash output — it forwards the content as
`RuntimeUserContentBlock::ToolResult` with `is_error` and the raw value
intact, leaving formatting to the renderer.

### 5. Edits / Writes / Patch

`Write`, `Edit`, and `MultiEdit` arrive as standard `ToolUse` blocks with
their canonical names. Their input JSON streams via `InputJsonDelta`, so
the UI sees the file path immediately and the body as it accumulates.

`ApplyPatch` is not used — Claude Code's CLI does not emit it. Diffs
shown by Cadencr are recomputed by the renderer from
`(old_string, new_string)` (`Edit`), the `edits` array (`MultiEdit`), or
pre/post file contents (`Write`).

### 6. Sub-agents

The `Task` tool spawns a sub-agent. The CLI emits subsequent messages
from the child carrying `parent_tool_use_id` set to the spawning
`Task`'s `tool_use_id`. The adapter preserves that field on every
`AssistantMessage`, `UserMessage`, and `StreamEvent` mapping it
forwards (`claude_code/events.rs`).

The runtime does no extra correlation — the CLI already nests, and the
UI uses `parent_tool_use_id` to render the child block under its parent.

### 7. Todo

`TodoWrite` is a native CLI tool whose input matches the canonical
schema:

```json
{ "todos": [{ "content": "...", "status": "pending|in_progress|completed", "activeForm": "..." }] }
```

The adapter forwards it untouched. Cadencr does not maintain its own
todo state — the tool is a UX projection of the model's view.

### 8. Thinking level changes

Effort is plumbed via two channels at spawn:

- `CLAUDE_CODE_EFFORT_LEVEL` env var (the channel current CLI versions
  honor reliably; tracked upstream as anthropics/claude-code#41028).
- `--effort <level>` flag (kept for forward compatibility).

Mid-session changes go through the normal "edit session settings →
respawn under the resumed session id" flow, so to shared code the
change is transparent — same `session_id`, same conversation, new
effort applied to the next turn.

The legal effort set per model comes from the CLI's `initialize`
response (`supported_effort_levels`); shared code never hardcodes it.

### 9. Model selection changes

`Query::set_model(model)` sends:

```json
{ "type": "control_request", "request_id": "...", "request": { "subtype": "set_model", "model": "<id>" } }
```

The CLI applies the new model on the next user turn — the in-flight
turn keeps the model it started with — and the SDK awaits the matching
`control_response` before returning. The runtime exposes this via
`AgentRuntimeSession::set_model`. Available models come from
`initialize.supported_models`, where each entry carries its own effort,
fast-mode, and auto-mode capability flags.

### 10. Permissions: yes / no / always / session

Claude Code uses the **hook pattern**: at spawn, the adapter installs a
`CanUseTool` callback. When the CLI needs permission it sends:

```json
{ "type": "control_request", "request": {
  "subtype": "can_use_tool",
  "tool_name": "...",
  "input": { … },
  "permission_suggestions": [ { "destination": "userSettings", "rule": "..." } ]
} }
```

The SDK invokes the callback synchronously (the CLI blocks). The
callback (`ClaudeCanUseToolAdapter`) hands the request to Cadencr's
`permission_bridge`, awaits the user's decision, and returns:

- `Allow { updated_input, updated_permissions, tool_use_id }` for
  `AllowOnce` and `AllowFuture` (the latter sets
  `updated_permissions` from `permission_suggestions`).
- `Deny { message, interrupt, tool_use_id }` for `Deny`.

Persistence destinations (`userSettings` / `projectSettings` /
`localSettings`) come from the CLI's suggestion; the adapter does not
invent them.

Two pseudo-tools route through the same channel:

- `AskUserQuestion` — Cadencr returns `Allow` with `updated_input` set
  to the user's textual answer.
- `ExitPlanMode` — see §12.

Because permissions are handled inside the SDK, **no
`RuntimePermissionRequest` events appear on the runtime stream** for
Claude Code. Shared code that sees no events here is correct.

### 11. MCP

MCP servers go in via `--mcp-config` at spawn:

```json
{ "mcpServers": { "<name>": { "type": "stdio", "command": "...", "args": [...], "env": {...} } } }
```

Stdio is the path Cadencr uses; the SDK also supports SSE and HTTP.

`initialize.mcp_servers: [{ name, status }]` populates
`RuntimeInitEvent.mcp_servers`. Status is whatever the CLI reports —
the adapter does not optimistically mark servers connected.

`set_mcp_servers` lets the user hot-swap servers mid-session. It uses
the same `control_request` envelope as the other mid-session commands
(`{ "type": "control_request", "request_id": "...", "request": { "subtype": "set_mcp_servers", "mcp_servers": {…} } }`)
and the SDK awaits the CLI's `control_response`.

Tool names from MCP servers arrive without explicit namespacing in the
CLI's `initialize.tools` list; Cadencr treats them like any other tool
for permission gating. Cadencr's plan-update MCP server uses
`mcp__cadencr-plan__update_plan` (and a legacy alias) — the
canonical-naming rule is enforced at the MCP server side.

### 12. Plan approval

In `Plan` mode, the CLI blocks risky tools and produces a plan. When
the plan is ready, the CLI calls `can_use_tool` with
`tool_name: "ExitPlanMode"` and `input.plan` set to the plan text. The
adapter forwards this through the permission bridge as a
`PlanApproval`-kind request.

On `Allow`, Cadencr issues a `set_permission_mode` to the build mode
chosen by `post_plan_approval_mode_wire(model)`:

- Models that advertise `supports_auto_mode = true` (Sonnet 4.6+, Opus
  4.6+, Sonnet 4.7+, …) → `auto`.
- Older capable models → `acceptEdits`.

The catalog is the live `initialize.supported_models` — the adapter
also handles aliases (`sonnet`, `opus`, `default`) by resolving them
against models the catalog advertises.

On `Deny`, the session stays in plan mode.

### 13. Context usage

Each `Result` message carries:

```json
"modelUsage": {
  "claude-opus-4-7[1m]": { "contextWindow": 1000000, "inputTokens": 500, "outputTokens": 100 }
}
```

`context_window_for_model_from_raw` extracts the right entry —
preferring an exact id match, falling back to the single-entry case for
alias models. The result populates
`RuntimeEventMetadata.context_window`.

`Usage.total_input_tokens()` sums `input_tokens` plus
`cache_creation_input_tokens` and `cache_read_input_tokens`, since
cached tokens consume the window.

### 14. Compaction

The CLI emits `compact_boundary` system messages with
`compact_metadata: { trigger, pre_tokens }`. The adapter maps this to
`RuntimeEventKind::CompactBoundary` carrying the same metadata.

The Claude Code CLI does **not** expose a `/compact` slash command, so
`supports_builtin_compact_command()` returns `false`. When the user
asks for compaction, Cadencr falls back to the
`RuntimeCompactionStrategy::SummaryReplay` flow.

### 15. Command + skill list

`initialize` returns `slash_commands` and `skills` arrays. The adapter
fetches both via `claude_agent_sdk_rs::list_commands(cwd, …)` and maps
each entry to `RuntimeSlashCommand { name, description, kind: Command }`
— skills and commands are presented uniformly in the UI's slash menu.

The list is CWD-scoped; switching projects re-queries it.

### 16. Replay / send-target detection

Resume uses `--resume <session_id>` on spawn — `session_id` is the
UUID captured from the first `Init` system message. The adapter
validates the id is a UUID before passing it through.

For mid-session sends, `stream_input` writes to the CLI's stdin:

```json
{ "type": "user", "message": { "role": "user", "content": [...] }, "session_id": "...", "parent_tool_use_id": null }
```

The CLI routes by `session_id`. There is no separate "target detection"
step — the adapter holds a single live session per slot.

## Current defaults, profiles, and context

- New Claude conversations default to `Auto`. A model known not to support Auto
  resolves to `AcceptEdits`; the displayed mode follows the effective mode.
- Profiles own environment/custom backend configuration. Session Info selects the
  profile for the next prompt; changing it does not restart the current turn.
- Reported context windows are learned from native provider events and remembered
  across restarts. When the window is unknown, show known token counts with a
  pending state rather than inventing a percentage.
- New-conversation provider/model selection follows the last accepted manual
  prompt across projects, with explicit conversation overrides taking priority.
- Thinking and model choices are reconciled with the selected model's advertised
  capabilities, including native profile defaults.

## Conversation branching

`claude_code/branching.rs` implements `SessionBranching` by writing a new transcript
containing the prefix before the selected real user-prompt ordinal. Tool-result,
meta, and compaction-summary records are excluded from prompt counting.

[Rewind & Fork](../REWIND_AND_FORK.md) owns the shared orchestration and code
checkpoint rules. A fork shares the current checkout; it does not restore code.
Provider transcript failure aborts the operation before conversation/code mutation.
