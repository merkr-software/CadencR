import type { RuntimeSessionConfigValue } from "@/api/generated";
import { createSessionConfigGet, createSessionConfigSet } from "@/lib/ws-envelope";
import { parseErrorPayload, parseSessionConfigSnapshotPayload } from "./ws-envelope-payload";
import type { StoreAccessors } from "./ws-envelope-types";
import type { WsSessionStore } from "./ws-session-store-types";
import { updateSession } from "./ws-session-types";

type SessionConfigActions = Pick<WsSessionStore, "requestSessionConfig" | "setSessionConfigOption">;

export function createWsSessionConfigActions(ctx: StoreAccessors): SessionConfigActions {
  return {
    async requestSessionConfig(sessionId: string): Promise<void> {
      const session = ctx.getSession(sessionId);
      if (!session.serverSessionId || session.sessionConfigLoading) return;
      ctx.set(
        updateSession(ctx.get(), sessionId, {
          sessionConfigLoading: true,
          sessionConfigError: null,
        }),
      );
      const payload = await ctx
        .get()
        .sendRequest(sessionId, createSessionConfigGet(session.serverSessionId));
      applyConfigResponse(ctx, sessionId, payload, true);
    },

    async setSessionConfigOption(
      sessionId: string,
      configId: string,
      value: RuntimeSessionConfigValue,
    ): Promise<void> {
      const session = ctx.getSession(sessionId);
      if (!session.serverSessionId || session.pendingSessionConfigId) return;
      ctx.set(
        updateSession(ctx.get(), sessionId, {
          pendingSessionConfigId: configId,
          sessionConfigError: null,
        }),
      );
      const payload = await ctx
        .get()
        .sendRequest(sessionId, createSessionConfigSet(session.serverSessionId, configId, value));
      applyConfigResponse(ctx, sessionId, payload, false);
    },
  };
}

function applyConfigResponse(
  ctx: StoreAccessors,
  sessionId: string,
  payload: unknown,
  loading: boolean,
): void {
  const error = parseErrorPayload(payload);
  if (error?.message || error?.code || payload === null) {
    const unsupported = error?.code === "SESSION_CONFIG_UNSUPPORTED";
    ctx.set(
      updateSession(ctx.get(), sessionId, {
        sessionConfigLoading: false,
        sessionConfigSupported: unsupported
          ? false
          : ctx.getSession(sessionId).sessionConfigSupported,
        sessionConfigError: unsupported
          ? null
          : (error?.message ?? "Session configuration timed out."),
        pendingSessionConfigId: null,
      }),
    );
    return;
  }
  const snapshot = parseSessionConfigSnapshotPayload(payload);
  ctx.set(
    updateSession(ctx.get(), sessionId, {
      sessionConfigLoading: false,
      sessionConfigSupported: snapshot ? true : null,
      sessionConfigError: snapshot ? null : "The runtime returned invalid session configuration.",
      pendingSessionConfigId: null,
      ...(snapshot ? { sessionConfig: snapshot.config } : {}),
    }),
  );
  if (loading && !snapshot) {
    console.warn("[ws-session] invalid config.snapshot reply", payload);
  }
}
