import { queryClient } from "@/lib/queryClient";
import { getWorkspaceSettingsQueryKey } from "@/api/settings";
import { parseEffortPayload } from "./ws-envelope-payload";
import type { StoreAccessors } from "./ws-envelope-types";
import {
  parseRuntimeSessionIdPayload,
  parseSessionConfigSnapshotPayload,
  parseModePayload,
} from "./ws-envelope-payload";
import { parseAccessMode } from "@/types/access-mode";
import { parsePermissionMode } from "@/types/permission-mode";
import { providerAcceptsMode } from "@/lib/provider-modes";
import { createSessionConfigState } from "./ws-session-types";
import { updateSession } from "./ws-session-types";

export function handleRuntimeOverridesChanged(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  if (!payload || typeof payload !== "object") return;
  const raw = (payload as { runtime_overrides?: unknown }).runtime_overrides;
  if (!raw || typeof raw !== "object") return;
  const value = raw as Record<string, unknown>;
  const model = value.model;
  const thinking = value.thinking_effort;
  const fast = value.fast_mode;
  if (model !== null && typeof model !== "string") return;
  if (thinking !== null && typeof thinking !== "string") return;
  if (fast !== null && typeof fast !== "boolean") return;
  const effective = (payload as { effective?: unknown }).effective;
  if (!effective || typeof effective !== "object") return;
  const effectiveValue = effective as Record<string, unknown>;
  const effectiveModel = effectiveValue.model;
  const effectiveThinking = effectiveValue.thinking_effort;
  const effectiveFast = effectiveValue.fast_mode;
  if (effectiveModel !== null && typeof effectiveModel !== "string") return;
  if (effectiveThinking !== null && typeof effectiveThinking !== "string") return;
  if (typeof effectiveFast !== "boolean") return;
  const current = ctx.get().sessions[sessionId]?.currentSelection;
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      runtimeOverrides: { model, thinking_effort: thinking, fast_mode: fast },
      currentSelection: current
        ? { providerId: current.providerId, modelId: effectiveModel ?? "" }
        : null,
      currentThinkingEffort: effectiveThinking ?? undefined,
      fastMode: effectiveFast,
    }),
  );
}

export function handleRuntimeSessionId(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const p = parseRuntimeSessionIdPayload(payload);
  const sessionIdValue = p?.runtime_session_id;
  if (sessionIdValue && sessionIdValue !== ctx.getSession(sessionId).runtimeSessionId) {
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        runtimeSessionId: sessionIdValue,
        ...createSessionConfigState(),
      }),
    );
  }
}

export function handleSessionConfigSnapshot(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const snapshot = parseSessionConfigSnapshotPayload(payload);
  if (!snapshot) {
    console.warn("[ws-session] invalid config.snapshot broadcast", payload);
    return;
  }
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      sessionConfig: snapshot.config,
      sessionConfigLoading: false,
      sessionConfigSupported: true,
      sessionConfigError: null,
      pendingSessionConfigId: null,
    }),
  );
}

export function handleAccessModeChanged(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
): void {
  const p = parseModePayload(payload);
  if (p?.mode) {
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        accessMode: parseAccessMode(p.mode),
      }),
    );
  }
}

export function handleModeChanged(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseModePayload(payload);
  const session = p?.mode ? ctx.getSession(sessionId) : null;
  const parsedMode = p?.mode ? parsePermissionMode(p.mode) : null;
  if (!parsedMode || !session) return;
  const providerId = session.currentSelection?.providerId;
  if (providerId == null) return;
  if (providerAcceptsMode(providerId, parsedMode)) {
    ctx.set(updateSession(ctx.get(), sessionId, { permissionMode: parsedMode }));
  }
}

export function handleEffortSetOk(ctx: StoreAccessors, sessionId: string, payload: unknown): void {
  const p = parseEffortPayload(payload);
  const previous = ctx.get().sessions[sessionId]?.currentThinkingEffort;
  ctx.set(updateSession(ctx.get(), sessionId, { currentThinkingEffort: p?.thinking_effort }));
  if (p?.thinking_effort !== previous) {
    void queryClient.invalidateQueries({ queryKey: getWorkspaceSettingsQueryKey() });
  }
}
