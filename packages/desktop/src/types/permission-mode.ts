export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
  "dontAsk",
] as const;

export const OPENCODE_AGENT_MODE_PREFIX = "opencodeAgent:";

/**
 * Shared permission-mode union. Wire values match the backend's
 * `parse_permission_mode` (packages/service/src/domain/ws_session/handler/mod.rs).
 *
 * Each CLI provider supports a different subset — see `provider-modes.ts` for
 * the per-provider catalog (drives chip rendering & the Shift+Tab cycle) and
 * `provider_supports_mode` on the backend (the validation gate).
 */
export type BuiltinPermissionMode = (typeof PERMISSION_MODES)[number];
export type OpenCodeAgentPermissionMode = `${typeof OPENCODE_AGENT_MODE_PREFIX}${string}`;
export type PermissionMode = BuiltinPermissionMode | OpenCodeAgentPermissionMode;

export function opencodeAgentPermissionMode(agentName: string): OpenCodeAgentPermissionMode {
  return `${OPENCODE_AGENT_MODE_PREFIX}${agentName}`;
}

export function parsePermissionMode(value: unknown): PermissionMode | null {
  if (typeof value !== "string") return null;
  if ((PERMISSION_MODES as readonly string[]).includes(value)) return value as PermissionMode;
  if (
    value.startsWith(OPENCODE_AGENT_MODE_PREFIX) &&
    value.length > OPENCODE_AGENT_MODE_PREFIX.length
  ) {
    return value as OpenCodeAgentPermissionMode;
  }
  return null;
}
