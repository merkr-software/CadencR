import { HistoryReadError } from "@/lib/history-read-error";
import { isAxiosError } from "axios";
import { apiErrorMessage } from "@/lib/api-errors";
import type { WsConnection } from "@/lib/ws-connection";
import { RECONNECT_INTERVAL_MS } from "@/lib/ws-reconnect";
import type { AgentBlockData } from "@/types/agent-block";
import type { StoreAccessors } from "./ws-envelope-handler";
import { blocksPatchWithDerived } from "./ws-message-processing";
import { updateSession, WS_RECONNECTING_CODE } from "./ws-session-types";

export function withoutReconnectNotices(blocks: AgentBlockData[]): AgentBlockData[] {
  if (!blocks.some((block) => block.errorCode === WS_RECONNECTING_CODE)) return blocks;
  return blocks.filter((block) => block.errorCode !== WS_RECONNECTING_CODE);
}

/** All readers on this socket share the automatic retry and its outcome. */
export async function recoverConnectedHistory(
  ctx: StoreAccessors,
  sessionId: string,
  connection: WsConnection,
  read: () => Promise<void>,
): Promise<void> {
  const session = ctx.get().sessions[sessionId];
  const dbId = session.sessionDbId;
  if (dbId == null) return;
  const isCurrent = () =>
    ctx.transport.get(sessionId)?.conn === connection &&
    connection.isOpen() &&
    ctx.get().sessions[sessionId]?.sessionDbId === dbId;
  const failure = session.historyLoadFailure;
  if (failure?.resyncSessionDbId === dbId) {
    ctx.set(
      updateSession(ctx.get(), sessionId, { historyLoadFailure: { ...failure, retrying: true } }),
    );
  }
  for (let attempt = 0; isCurrent(); attempt++) {
    try {
      await read();
      if (
        isCurrent() &&
        ctx.get().sessions[sessionId].historyLoadFailure?.resyncSessionDbId !== undefined
      ) {
        ctx.set(updateSession(ctx.get(), sessionId, { historyLoadFailure: null }));
      }
      return;
    } catch (error) {
      if (!isCurrent()) return;
      if (attempt === 0 && isAxiosError(error) && error.code === "ERR_NETWORK") {
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_INTERVAL_MS));
        continue;
      }
      const current = ctx.get().sessions[sessionId];
      if (current.historyLoadFailure && current.historyLoadFailure.resyncSessionDbId === undefined)
        return;
      const blocks = withoutReconnectNotices(current.blocks);
      ctx.set(
        updateSession(ctx.get(), sessionId, {
          ...(blocks === current.blocks
            ? {}
            : blocksPatchWithDerived(current.streamingState, blocks)),
          historyLoadFailure: {
            resyncSessionDbId: dbId,
            retrying: false,
            message:
              error instanceof HistoryReadError
                ? { issue: error.issue }
                : apiErrorMessage(error, "") || { issue: "incomplete" },
          },
        }),
      );
      return;
    }
  }
}
