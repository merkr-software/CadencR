# Provider status — Codex

> Reviewed against v0.13.0 source and release changes on 2026-10-13. This is a
> source review, not a new end-to-end parity certification of every local CLI.

![Current provider settings](../../packages/landing/src/assets/docs/v0.13.0/provider-codex.png)

The Phase 0 catalog contract is pinned by
[`codex_catalog.json`](../../packages/service/tests/fixtures/provider_parity/v1/codex_catalog.json)
and asserted by an inline adapter test. It covers identity, model capability
projection, access modes, and default selection using deterministic synthetic
app-server models rather than a local CLI probe.

Status of the Codex adapter against [`FEATURES.md`](./FEATURES.md).

The adapter lives in `packages/service/src/domain/agents/codex/` and
speaks to the `codex` app server via the
`packages/codex-app-server-sdk-rs/` SDK. The wire protocol is JSON-RPC
2.0 over stdio: requests / responses for control calls
(`thread/start`, `turn/start`, `thread/compact/start`, …) plus
unidirectional notifications for streaming events
(`item/started`, `item/agentMessage/delta`, `turn/plan/updated`, …).

## Status matrix

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Modes: plan / build / accept-edits | ✅ | Mapped to `approvalPolicy` + `sandboxPolicy`; plan mode signaled via `collaborationMode.mode = "plan"` on `turn/start` (sandbox stays `workspaceWrite`). |
| 2 | Thinking | ✅ | `item/reasoning/textDelta` + `item/reasoning/summaryTextDelta` → `RuntimeContentDelta::Thinking` keyed on the item's stable index. |
| 3 | Partial / streaming messages | ✅ | `item/started`, `item/agentMessage/delta`, `item/completed` → standard `MessageStart` / `ContentBlockStart` / `Delta` / `Stop`. Indexes assigned by `IndexState`. |
| 4 | Bash tool calls + outputs | ✅ | `item/commandExecution` start + `outputDelta` + `completed`; output aggregated in `command_outputs` and surfaced via `InputJson` deltas. |
| 5 | Edits / Writes / Patch | ✅ | `item/fileChange` normalized to `ApplyPatch`; patch text streams via `patchUpdated`. |
| 6 | Sub-agents | ✅ | Both raw `spawn_agent` function_call and `collabAgentToolCall { tool: "spawnAgent" }`; `SubagentRegistry` stamps `parent_tool_use_id` on every child event. |
| 7 | Todo | ✅ | `turn/plan/updated` mapped to `TodoWrite` with status normalized to snake_case; index reused for in-place updates. |
| 8 | Thinking level changes | ✅ | `effort` parameter on every `turn/start`; also surfaced via `collaborationMode.settings.reasoning_effort`. Stored in `CodexSession.effort`. |
| 9 | Model selection changes | ✅ | `model` parameter on every `turn/start`; provider selection and Codex catalog ownership determine the adapter. |
| 10 | Permissions: yes / no / always / session | ✅ | ServerRequest bridged to `permission_bridge`; decisions map to `accept` / `acceptForSession` / `decline` / `cancel`. `AllowFuture` available where the request advertises it (Bash, ApplyPatch, NetworkAccess, MCP elicitation). |
| 11 | MCP | ✅ | Servers passed in `thread/start.config.mcp_servers`; tool names normalized to `mcp__<server>__<tool>`. Status from `mcp_server_status_list`. Cadencr-managed servers receive `CADENCR_MCP_APPROVAL_MODE`. |
| 12 | Plan approval | ✅ | `item/completed` for type `Plan` synthesizes an `ExitPlanMode` `ToolUse` plus a `PlanApproval` permission request. |
| 13 | Context usage | ✅ | `thread/tokenUsage/updated` → usage; `modelContextWindow` minus `CONTEXT_USAGE_BASELINE_TOKENS` reported as the user-visible window. |
| 14 | Compaction | ✅ | User-initiated via `thread/compact/start` RPC; provider-initiated via `thread/compacted` notification. Both emit `CompactBoundary`. |
| 15 | Command + skill list | ✅ | `list_commands_in_directory()` RPC returns commands + skills with their `kind`; mapped 1:1 to `RuntimeSlashCommand`. |
| 16 | Replay / send-target detection | ✅ | `thread/resume` when `resume_session_id` set, else `thread/start`. Active turn id tracked in `event_loop` to keep per-turn caches isolated. |

Legend: ✅ implemented · 🟡 partial · ❌ missing.

---

## Per-feature behavior

### 1. Modes: plan / build / accept-edits

Codex has no native `plan` flag, so the mapping is split across three
fields in `turn/start.params` (`codex/turn_start.rs`,
`codex/model.rs`):

| Cadencr mode | `approvalPolicy` | `sandboxPolicy.type` | `collaborationMode.mode` |
|---|---|---|---|
| `Default` / `AcceptEdits` / `Auto` | `on-request` | `workspaceWrite` | `default` |
| `Plan` | `on-request` | `workspaceWrite` | `plan` |
| `BypassPermissions` / `DontAsk` | `never` | `dangerFullAccess` | `default` |

Plan mode does **not** narrow the sandbox: it sets
`collaborationMode.mode = "plan"` and lets per-tool approval gate risky
actions. This is intentional — narrowing the sandbox would break the
exact tools the user wants the model to plan around.

Workspace-write policy emits the full schema:

```json
{
  "type": "workspaceWrite",
  "writableRoots": ["<cwd>"],
  "readOnlyAccess": { "type": "fullAccess" },
  "networkAccess": false,
  "excludeTmpdirEnvVar": false,
  "excludeSlashTmp": false
}
```

`turn/start` re-sends these on every turn, so toggling the mode
(`set_permission_mode`) takes effect on the next user message without
restarting the thread.

### 2. Thinking

Reasoning streams via two notifications, both routed through
`reasoning_delta_event` (`codex/event_items.rs`):

- `item/reasoning/textDelta` — raw reasoning text.
- `item/reasoning/summaryTextDelta` — summarized form (preferred when
  the model emits both).

The first delta opens a `ContentBlockStart` with a fresh thinking
block; subsequent deltas reuse the index allocated by
`IndexState::index_for(item_id)`. `item/completed` for the reasoning
item emits `ContentBlockStop`.

### 3. Partial / streaming messages

Text streams via `item/agentMessage/delta` after a paired
`item/started` of type `agentMessage` opens the block. The adapter
allocates a per-item index in `IndexState` and reuses it for every
delta from that item, so the UI stitches deltas onto the right block.

`turn/started` triggers `MessageStart`; `turn/completed` triggers the
turn-complete `Result` event with usage and context window populated.

### 4. Bash tool calls + outputs

Three notifications drive Bash:

| Notification | Effect |
|---|---|
| `item/started` (type `commandExecution`) | `ContentBlockStart { name: "Bash", input: { command, … } }` |
| `item/commandExecution/outputDelta` (or legacy `command/exec/outputDelta`) | `ContentBlockDelta { InputJson { partial_json: "{\"output\": ...}" } }` |
| `item/completed` (same item) | `ContentBlockStop` |

Output is accumulated in `command_outputs: HashMap<item_id, String>`
inside `event_loop` so deltas always carry the cumulative buffer. If
`item/started` arrives late, `events.rs` synthesizes both start and
result on the `item/completed` path so the UI never sees a result
without a header.

Some `commandExecution` items are "exploring actions" (e.g. read-only
metadata calls) and are filtered out by
`event_command_actions::is_exploring_action` so they don't clutter the
chat.

### 5. Edits / Writes / Patch

Codex models all file mutations as a single `fileChange` item type;
the adapter normalizes it to the canonical `ApplyPatch` tool name:

| Notification | Effect |
|---|---|
| `item/started` (type `fileChange`) | `ContentBlockStart { name: "ApplyPatch", input: { changes, patch } }` |
| `item/fileChange/patchUpdated` | `ContentBlockDelta { InputJson }` carrying the rebuilt patch text |
| `item/completed` | `ContentBlockStop` |

`event_inputs.rs` rebuilds the patch text from the `changes` array
using the literal Codex patch grammar (`*** Begin Patch`,
`*** Add/Update/Delete File: <path>`, `*** Move to: <path>`, unified
diff lines, `*** End Patch`).

When a file change requires approval, Codex sends
`item/fileChange/requestApproval`, which the adapter normalizes to a
permission request for the canonical `ApplyPatch` tool — see §10.

### 6. Sub-agents

Codex multiplexes parent and child threads onto a single event stream,
so the adapter has to do the routing. Two paths are supported:

**Raw OpenAI shape**:

1. A `function_call` named `spawn_agent` arrives; the adapter emits a
   `ContentBlockStart { name: "Agent", input }`.
2. Its `function_call_output` carries
   `agentsStates: { <thread_id>: { status, message } }`. The adapter
   registers `thread_id → parent_tool_use_id` in `SubagentRegistry`
   and synthesizes a Text block under the parent if `message` is
   present.

**Collab shape**:

1. `item/started` of type `collabAgentToolCall` with
   `tool: "spawnAgent"` and `receiverThreadIds` opens the parent
   `Agent` block and registers the children.
2. Other collab ops (`send_input`, `wait_agent`, `close_agent`) keep
   their own tool names; they don't register new threads.

Once registered, every event carrying a `threadId` in the registry is
post-processed in `notification_events` to set
`parent_tool_use_id`, ensuring the UI nests the child stream under the
correct `Agent` tool block. `wait_agent` outputs that carry a final
message synthesize a Text block under the parent.

### 7. Todo

`turn/plan/updated` is the source. The first update opens
`ContentBlockStart { name: "TodoWrite", input: { todos: [...] } }`;
subsequent updates emit `ContentBlockDelta { InputJson }` reusing the
same index, so the UI mutates the existing block in place.

Codex statuses are normalized to snake_case:

| Codex | Cadencr |
|---|---|
| `inProgress` | `in_progress` |
| `completed` | `completed` |
| `pending` | `pending` |

### 8. Thinking level changes

`turn/start.params.effort` carries the level on every turn; it is also
mirrored into `collaborationMode.settings.reasoning_effort`. The value
is held in `CodexSession.effort: Arc<RwLock<Option<String>>>`.

`AgentRuntimeSession::set_thinking_effort` writes the new value; the
next `turn/start` call sends it. There is no mid-turn change.

### 9. Model selection changes

`turn/start.params.model` carries the model on every turn; held in
`CodexSession.model: Arc<RwLock<Option<String>>>`.

The selected `codex_cli` provider owns the adapter. Legacy model-only
selections use exact provider catalog ownership; Codex is never inferred from
`gpt-` or `codex-` prefixes in shared routing.

### 10. Permissions: yes / no / always / session

Codex uses the **bridge pattern**. A request arrives as a JSON-RPC
`ServerRequest` (numeric `id`), e.g.
`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`,
`mcpServer/elicitation/request`.

The adapter parses it into a `RuntimePermissionRequest` and emits a
`permission_request_event` with:

- `tool_name` — canonical: `Bash`, `ApplyPatch`, `NetworkAccess`,
  `RequestPermissions`, or `mcp__<server>__<tool>`.
- `tool_use_id` — the ServerRequest id, used to thread the response
  back.
- `options` — built per-tool via `permission_options`. `AllowFuture`
  is offered for `Bash`, `ApplyPatch` / `apply_patch`,
  `NetworkAccess`, and any MCP request whose `_meta.persist`
  advertises `["session", "always"]`.

The user's decision flows back through `permission_bridge` and is
translated by `responses.rs`:

| Cadencr decision | Codex decision |
|---|---|
| `AllowOnce` | `accept` (or `acceptForSession` if the request only allows session-scoped accept) |
| `AllowFuture` | `acceptForSession` (or `accept` if not advertised) |
| `Deny` | `decline` (or `cancel` if available) |

Sent as a JSON-RPC response:

```json
{ "id": <request_id>, "result": { "decision": "accept" | "acceptForSession" | "decline" | "cancel" } }
```

MCP servers running in elicitation mode (when
`CADENCR_MCP_APPROVAL_MODE=elicitation` is exported into the server's
env) receive their own per-tool approval prompts via the same path.

### 11. Plan approval

When the session is in plan mode, Codex eventually emits an
`item/completed` of type `Plan` carrying the plan text. The adapter
synthesizes:

1. `ContentBlockStart { id: "codex_plan_approval_<item_id>", name: "ExitPlanMode", input: { plan: <text> } }` plus its matching `ContentBlockStop`.
2. A `permission_request_event` of kind `codex_permission_request`,
   `tool_name: "ExitPlanMode"`, `request_id` equal to the approval id.

The user's decision flows through the same bridge as any other
permission. On `Allow`, shared session code calls
`set_permission_mode` to leave plan mode (Codex re-sends the new
`approvalPolicy` / `collaborationMode.mode = "default"` on the next
`turn/start`).

### 12. Context usage

`thread/tokenUsage/updated` notifications carry:

```json
{ "tokenUsage": { "last": {...}, "total": { "totalTokens": ..., "modelContextWindow": ... } } }
```

`event_usage.rs` reports input/output/total tokens and computes a
"usable" window:

- If `modelContextWindow ≤ CONTEXT_USAGE_BASELINE_TOKENS` (128K from
  the SDK constant), report raw values.
- Otherwise subtract the baseline from both `totalTokens` and
  `modelContextWindow` so the percentage shown matches what the user
  actually controls.

The result populates `RuntimeEventMetadata.usage` and
`context_window`.

### 13. Bash tool calls — see §4.

### 14. Compaction

Two flows:

- **User-initiated.** The runtime calls `CodexSession::compact()`,
  which sends `thread/compact/start`. The server runs the compaction
  and emits a `thread/compacted` notification on completion.
- **Provider-initiated.** The server emits `thread/compacted` on its
  own when token pressure forces a compaction.

Either path lands in `events.rs::notification_events` matching
`thread/compacted`, which dispatches `compact_event(params)` →
`RuntimeEventKind::CompactBoundary { metadata: { trigger, pre_tokens } }`.

`supports_builtin_compact_command()` returns `true` so Cadencr's
`/compact` slash command takes the user-initiated path rather than
the `SummaryReplay` fallback.

### 15. Command + skill list

`list_commands_in_directory(cwd)` is a JSON-RPC call returning an
array of entries with `name`, `description`, and a `kind` of
`Command` or `Skill`. The adapter maps each entry directly to
`RuntimeSlashCommand` and exposes them through
`/agents/codex/slash-commands`.

The list is CWD-scoped — switching projects re-queries.

### 16. Replay / send-target detection

On spawn, if `RuntimeSpawnConfig.resume_session_id` is set, the
adapter calls `thread/resume` with the stored thread id; otherwise
`thread/start` creates a fresh thread. Either way, subsequent
`turn/start` calls carry `threadId`, so routing inside the codex
server is unambiguous.

`event_loop.rs` tracks `active_turn_id`: it is set on `turn/started`
(and on context-compaction start), and cleared on `turn/completed`
or compaction completion. Per-turn caches (`command_outputs`,
`IndexState`) are reset on those boundaries so two consecutive turns
never collide on item ids.

Sub-agent routing is the other half of "send-target detection": every
notification carrying a known sub-agent `threadId` is rewritten with
its parent's `parent_tool_use_id` (see §6) so it lands under the
right block in the UI.

## Profiles, Fast mode, and durable usage

- Named Codex profiles can select a native `config.toml` plus environment overrides.
  Settings manages the default; Session Info can override it for a conversation.
  Catalog discovery and runtime spawning use the same resolved profile.
- Fast mode requests the priority service tier when supported. Its persisted
  selection applies to new, resumed, compacted, and active conversations.
- Reasoning summaries are enabled for supported models on the default OpenAI
  provider, including resume. Explicit profile choices and other inference
  providers' defaults remain authoritative.
- Provider-native cumulative usage is recorded once per completed response and
  isolated by provider session. Resume/replayed events must not inflate totals.
- New conversations inherit the last accepted manual provider/model across
  projects. Model/effort changes reconcile supported choices and report failed
  persistence rather than showing an unconfirmed selection.

## Conversation branching

`codex/branching.rs` resolves the selected profile, reads the source thread, forks
it, then rolls the new thread back to the turn before the cut.

The cut must be the first user message in its native turn. A cut inside a turn
with several user messages is refused instead of moving the cut silently. See
[Rewind & Fork](../REWIND_AND_FORK.md) for shared checkpoint and draft behavior.
