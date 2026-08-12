/**
 * Typed contract for the `session.*` WebSocket action names the backend emits.
 *
 * Single frontend source of truth for the action strings sent from
 * `packages/service/src/domain/ws_session/` (server → client broadcasts that
 * reach `handleSessionAction` in `ws-envelope-handler`; request/response
 * replies are resolved by `ref` before dispatch and are not listed here). The
 * strings are hand-mirrored
 * from the Rust emit sites until the backend ships a generated protocol
 * contract (`feature/backend-typed-ws-protocol-contract`); when it lands,
 * replace the literals below with that import and keep these key names so the
 * dispatch table in `ws-envelope-handler` needs no changes.
 *
 * Client → server action names (`prompt.send`, `model.set`, …) live with their
 * envelope builders in `@/lib/ws-envelope` and are intentionally not duplicated
 * here.
 */
export const SESSION_ACTION = {
  initialized: "initialized",
  runtimeSessionId: "runtime_session_id",
  mcpServers: "mcp_servers",
  message: "message",
  userMessage: "user_message",
  permissionRequest: "permission.request",
  error: "error",
  compacting: "compacting",
  accessModeChanged: "access_mode.changed",
  legacyCodexPermissionModeChanged: "codex_permission_mode.changed",
  modeChanged: "mode.changed",
  providerSetOk: "provider.set.ok",
  modelSetOk: "model.set.ok",
  effortSetOk: "effort.set.ok",
  fastModeSetOk: "fast_mode.set.ok",
  profileChanged: "profile.changed",
  compactStarted: "compact.started",
  compactOk: "compact.ok",
  cleared: "cleared",
  deleted: "deleted",
  usageUpdate: "usage_update",
  streamStatus: "stream_status",
  promptReceived: "prompt_received",
  lifecycle: "lifecycle",
  gateClosed: "gate.closed",
  featureRenamed: "feature.renamed",
  featureAutonaming: "feature.autonaming",
  branchRewound: "branch.rewound",
  branchForked: "branch.forked",
  configSnapshot: "config.snapshot",
  ended: "ended",
  turnComplete: "turn_complete",
} as const;

export type SessionActionName = (typeof SESSION_ACTION)[keyof typeof SESSION_ACTION];
