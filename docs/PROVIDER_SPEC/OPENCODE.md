# Provider status — OpenCode (ACP)

> Reviewed against v0.13.0 source and release changes on 2026-10-13. This review
> updates the earlier ACP migration audit; it is not a new end-to-end parity
> certification of every OpenCode CLI version.

![Current OpenCode settings](../../packages/landing/src/assets/docs/v0.13.0/provider-opencode.png)

The adapter lives in `packages/service/src/domain/agents/opencode/`. It launches
`opencode acp` and uses the shared `agents/acp/runtime/` for line-delimited
JSON-RPC over stdio. OpenCode-specific hooks stay in `opencode/acp/`.
The transport SDK lives in `packages/opencode-sdk-rs/`.

ACP is the live conversation transport. Adapter-owned HTTP side channels still
handle OpenCode questions, child-session events/permissions, native shell work,
and point-in-time branching. This is separate from the removed legacy
long-lived HTTP conversation runtime.

## Coverage

See [FEATURES.md](./FEATURES.md) for the cross-provider ledger and
[CAPABILITY_PROJECTION.md](./CAPABILITY_PROJECTION.md) for projection rules.

| # | Capability | Status | Current path or limitation |
| --- | --- | --- | --- |
| 1 | Modes | ✅ | Plan, Build, and discovered OpenCode agents; acknowledged ACP mode changes |
| 2 | Thinking | ✅ | Thought chunks use a separate runtime thinking block/index |
| 3 | Streaming | ✅ | Shared ACP message/tool lifecycle, with turn-end block closure |
| 4 | Shell tools | ✅ | ACP terminal references enriched with command and output |
| 5 | File changes | ✅ | Edit/Write keys and diff content normalize to the shared input shapes |
| 6 | Subagents | ✅ | Adapter-owned child-to-parent correlation, side-channel updates, and final text |
| 7 | Todo | ✅ | Tool and ACP plan updates normalize and deduplicate within a turn |
| 8 | Thinking changes | ✅ | Negotiated effort configuration; only acknowledged values become current |
| 9 | Model changes | ✅ | Selected model reconciled after setup and changed through ACP config |
| 10 | Permissions/questions | ✅ | Shared ACP gate plus OpenCode question/child-permission bridges |
| 11 | MCP | 🟡 | Injected via ACP session setup; configured servers can retain unknown status |
| 12 | Dedicated plan approval | ❌ | Plan/Build switching exists; no Claude-style `ExitPlanMode` approval handoff |
| 13 | Context usage | ✅ | Authoritative usage/context-window snapshots; no per-turn-total occupancy guess |
| 14 | Compaction | ✅ | Live `/compact` prompt and persisted manual compact boundary |
| 15 | Commands/skills | ✅ | ACP command pushes and a cold per-directory probe |
| 16 | Live follow-up | ✅ | Reuses the active ACP session ID and serializes turns |
| 17 | Durable restore | ✅ | Requires advertised stable resume or legacy load support |

## Mode, model, and effort reconciliation

`opencode/acp/adapter.rs` maps Plan to `plan`, a selected custom agent to its
advertised name, and ordinary supported operation to `build`. The provider
catalog determines which controls the user can select; shared permission modes
are not a claim that every CLI has the same native permission policy.

The session handshake provides the current mode/model and config snapshot.
Initial user selections are applied before the first prompt when required.
Model/effort config changes use the advertised ACP option identity and supported
value. A provider acknowledgment updates the current value; user intent alone
must not masquerade as applied configuration.

New-conversation provider/model selection follows the last accepted manual
prompt across projects, with explicit conversation overrides taking priority.

## Streams, tools, and child sessions

The shared ACP event indexer keeps text and thought streams separate. Tool starts,
updates, completion, cancellation, and turn completion map to provider-neutral
runtime events. Titles/locations/arguments are preserved when the provider emits
them; missing fields must not be invented.

ACP terminal IDs resolve through the session terminal registry so a Bash block
can show its command and stdout/stderr. Edit/Write normalization handles ACP
camelCase inputs and diff content using Cadencr's canonical file-change shapes.

OpenCode Task/Agent completions can synthesize final child text under the parent
tool. The side-channel listener binds child session IDs to parent tool IDs for
live updates and permission routing. `subAgentSessionId` itself is not a parent
tool-use ID.

## Permissions and questions

Standard ACP permission options retain opaque option IDs. Session and future
allow decisions are cached where supported; no-feedback Deny rejects the request.
OpenCode's question sidecar owns answer/deny routing where the upstream question
is not represented as an ordinary ACP permission request.

Plan mode can be changed to Build explicitly. It does not currently produce the
same dedicated plan-approval handoff as Claude Code or Codex. Do not document a
plan gate as available merely because the provider advertises a Plan mode.

## MCP injection and observed status

The shared ACP handshake carries configured MCP servers in `session/new`, stable
`session/resume`, or legacy `session/load`. The old audit's claim that the ACP
path never loads MCP servers because it skips a worktree `opencode.json` writer
no longer describes the implementation.

`OpenCodeAcpAdapter::available_mcp_servers` probes native CLI status through
`opencode_sdk_rs::list_mcp_servers_from_cli`, merges observed entries with the
configured server list, and remembers names for canonical tool normalization.
An unavailable/empty probe leaves configured status intact; it does not mark an
unobserved server connected. Unknown status is therefore a useful limitation,
not proof that a server was omitted from session setup.

Cadencr runtime credentials remain session-scoped. User/project OpenCode
configuration is separate from that injected session configuration.

## Context, compaction, and commands

Context occupancy uses `usage_update.used/size` and session window snapshots.
A `session/prompt` response's turn usage is not substituted for total context
occupancy. Unknown windows show a pending state with known counts.

The live compaction path sends `/compact` and records a manual compact boundary.
ACP `available_commands_update` pushes refresh per-directory command snapshots.
Cold command discovery uses a short-lived ACP probe rather than an unrelated
long-lived `opencode serve` process.

## Durable restore and graceful close

`OpenCodeAcpAdapter::supports_durable_resume()` returns true. The shared lifecycle
then checks the live `initialize` response:

1. Prefer stable `session/resume` when advertised.
2. Fall back to legacy `session/load` when `loadSession` is advertised.
3. Refuse an explicitly requested restore if neither is supported; do not silently
   create a fresh conversation and claim the history was restored.

Stable resume does not replay history. Legacy load may replay updates, which the
host must reconcile. Graceful `session/close` is called when advertised.
OpenCode runtime IDs are opaque nonempty IDs, not Claude UUIDs.

## Rewind and Fork

`opencode/branching.rs` implements `SessionBranching`. An adapter-owned headless
ACP/HTTP path forks the native session before a selected provider message ID,
falling back to the real user-prompt ordinal when necessary.

[Rewind & Fork](../REWIND_AND_FORK.md) handles shared interruption, code checkpoints,
conversation state, and draft restoration. A fork opens a new conversation with
current code in the same worktree. A rewind restores code only when a checkpoint
exists and the restore succeeds. Branch failures abort before the conversation
is replaced with an untrimmed native history.

## Evidence and remaining limitations

- Source anchors: `opencode/mod.rs`, `opencode/acp/{mod,adapter}.rs`,
  `opencode/branching.rs`, and `acp/runtime/lifecycle.rs`.
- Older CLI builds can omit optional config, restore, or close methods. Advertised
  live capabilities and acknowledgments are authoritative.
- The dedicated plan-approval handoff remains absent; use explicit mode switching.
- MCP status can remain unknown even when the configured server was injected.
- The earlier first-cut audit's proposed fixes are historical evidence, not a
  current backlog. Verify a suspected regression against current code/live CLI
  before reintroducing it as an outstanding issue.
