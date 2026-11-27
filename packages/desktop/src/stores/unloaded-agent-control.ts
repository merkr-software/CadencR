import { translateUi } from "@/lib/i18n/ui";
/**
 * Stop or pause agents whose conversation this window holds no socket for (a
 * schedule, MCP, or another device started them). The socket commands cannot
 * reach those, so they go over HTTP. Each request answers once the agent
 * acknowledged; whether it is still working stays the status book's to say
 * (no-optimistic-updates), so nothing local changes on success.
 */
import { toast } from "sonner";
import { interruptAgentSession, suspendAgentSession } from "@/api/generated";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import { SESSION_COMMANDS } from "./ws-session-commands";

// Each outcome has its own id: a reused sonner id keeps the previous toast's
// fields (description, duration).
const STOP_TOAST_ID = "stop-unloaded-agents";
const STOPPED_TOAST_ID = "stop-unloaded-agents:stopped";
const STOP_FAILED_TOAST_ID = "stop-unloaded-agents:failed";
const SUSPEND_TOAST_ID = "suspend-unloaded-agents";
const SUSPEND_FAILED_TOAST_ID = "suspend-unloaded-agents:failed";

/** The failures among `request`'s answers, less those meaning it already holds. */
async function settleAll(
  sessionIds: readonly number[],
  request: (sessionId: number) => Promise<unknown>,
  satisfiedBy: ReadonlySet<string> = new Set(),
): Promise<unknown[]> {
  const results = await Promise.allSettled(sessionIds.map((id) => request(id)));
  return results.flatMap((result) =>
    result.status === "rejected" && !satisfiedBy.has(apiErrorCode(result.reason) ?? "")
      ? [result.reason]
      : [],
  );
}

export async function stopUnloadedAgents(sessionIds: readonly number[]): Promise<void> {
  if (sessionIds.length === 0) return;
  toast.loading(
    translateUi("conversation.background.stopping", "Stopping {{count}} agents…", {
      count: sessionIds.length,
      defaultValue_one: "Stopping {{count}} agent…",
    }),
    {
      id: STOP_TOAST_ID,
      description: translateUi(
        "conversation.background.offscreen",
        "Their conversations aren't open in this window.",
      ),
    },
  );
  // Same meaning as for the socket stop: a turn that already ended is stopped.
  const failures = await settleAll(
    sessionIds,
    (id) => interruptAgentSession(id),
    SESSION_COMMANDS.interrupt.satisfiedBy,
  );
  toast.dismiss(STOP_TOAST_ID);
  if (failures.length === 0) {
    toast.success(
      translateUi("conversation.background.stopped", "Stopped {{count}} agents", {
        count: sessionIds.length,
        defaultValue_one: "Stopped {{count}} agent",
      }),
      { id: STOPPED_TOAST_ID },
    );
    return;
  }
  toast.error(
    translateUi("conversation.background.stopFailed", "Couldn't stop {{count}} agents", {
      count: failures.length,
      defaultValue_one: "Couldn't stop {{count}} agent",
    }),
    {
      id: STOP_FAILED_TOAST_ID,
      description: apiErrorMessage(
        failures[0],
        translateUi("conversation.background.stopTimeout", "The agent didn't answer the stop."),
      ),
    },
  );
}

export async function suspendUnloadedAgents(sessionIds: readonly number[]): Promise<void> {
  if (sessionIds.length === 0) return;
  toast.loading(
    translateUi("conversation.background.pausing", "Pausing {{count}} agents for sleep…", {
      count: sessionIds.length,
      defaultValue_one: "Pausing {{count}} agent for sleep…",
    }),
    { id: SUSPEND_TOAST_ID },
  );
  const failures = await settleAll(sessionIds, (id) => suspendAgentSession(id));
  toast.dismiss(SUSPEND_TOAST_ID);
  if (failures.length === 0) return;
  toast.warning(
    translateUi("conversation.background.pauseFailed", "{{count}} agents kept running into sleep", {
      count: failures.length,
      defaultValue_one: "{{count}} agent kept running into sleep",
    }),
    {
      id: SUSPEND_FAILED_TOAST_ID,
      description: apiErrorMessage(
        failures[0],
        translateUi("conversation.background.pauseTimeout", "The agent didn't answer the pause."),
      ),
    },
  );
}
