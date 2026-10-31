import { WsSessionAction } from "@/api/generated";

/** Canonical server actions come directly from the backend protocol contract. */
export const SESSION_ACTION = WsSessionAction;
export type SessionActionName = WsSessionAction;

/** Accepted for compatibility with older service versions; no current emitters. */
export const LEGACY_SESSION_ACTION = {
  codexPermissionModeChanged: "codex_permission_mode.changed",
  compactOk: "compact.ok",
  turnComplete: "turn_complete",
} as const;

export type LegacySessionActionName =
  (typeof LEGACY_SESSION_ACTION)[keyof typeof LEGACY_SESSION_ACTION];
