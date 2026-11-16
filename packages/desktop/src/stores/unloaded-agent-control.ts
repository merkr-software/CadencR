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

function agents(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}

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
  toast.loading(`Stopping ${agents(sessionIds.length)}…`, {
    id: STOP_TOAST_ID,
    description: "Their conversations aren't open in this window.",
  });
  // Same meaning as for the socket stop: a turn that already ended is stopped.
  const failures = await settleAll(
    sessionIds,
    (id) => interruptAgentSession(id),
    SESSION_COMMANDS.interrupt.satisfiedBy,
  );
  toast.dismiss(STOP_TOAST_ID);
  if (failures.length === 0) {
    toast.success(`Stopped ${agents(sessionIds.length)}`, { id: STOPPED_TOAST_ID });
    return;
  }
  toast.error(`Couldn't stop ${agents(failures.length)}`, {
    id: STOP_FAILED_TOAST_ID,
    description: apiErrorMessage(failures[0], "The agent didn't answer the stop."),
  });
}

export async function suspendUnloadedAgents(sessionIds: readonly number[]): Promise<void> {
  if (sessionIds.length === 0) return;
  toast.loading(`Pausing ${agents(sessionIds.length)} for sleep…`, { id: SUSPEND_TOAST_ID });
  const failures = await settleAll(sessionIds, (id) => suspendAgentSession(id));
  toast.dismiss(SUSPEND_TOAST_ID);
  if (failures.length === 0) return;
  toast.warning(`${agents(failures.length)} kept running into sleep`, {
    id: SUSPEND_FAILED_TOAST_ID,
    description: apiErrorMessage(failures[0], "The agent didn't answer the pause."),
  });
}
