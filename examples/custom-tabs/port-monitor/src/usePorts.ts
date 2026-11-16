import { useCallback, useEffect, useRef, useState } from "react";
import { isReportedByHost, toCadencrError, type CadencrError } from "@cadencr/tab-sdk";
import { useCadencr, useVisibility } from "@cadencr/tab-sdk/react";
import { z } from "zod";

/** One process listening on one port, as the backend (`backend/src/ports.rs`) reports it. */
const portEntrySchema = z.object({
  port: z.number().int(),
  pid: z.number().int(),
  command: z.string(),
  user: z.string().nullable(),
  /** `null` where the platform cannot tell (another user's process). */
  cwd: z.string().nullable(),
  addresses: z.array(z.string()),
  /**
   * Running in this conversation's folder; `null` when unknown. Conversations
   * that share a folder (no worktree of their own) share these processes too.
   */
  inFolder: z.boolean().nullable(),
});
export type PortEntry = z.infer<typeof portEntrySchema>;

const portsSchema = z.object({ ports: z.array(portEntrySchema) });

const conversationSchema = z.object({ title: z.string() });
export type Conversation = z.infer<typeof conversationSchema>;

export type PortsState =
  | { status: "loading" }
  | { status: "error"; error: CadencrError }
  | { status: "ready"; ports: PortEntry[] };

/** The backend's answers are JSON nothing has checked yet: parse before rendering. */
function parseReply<T>(schema: z.ZodType<T>, method: string, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(`The backend answered \`${method}\` with an unexpected shape.`);
  return parsed.data;
}

/** The backend reads the socket tables each time: often enough to feel live, not more. */
const POLL_MS = 5_000;

/**
 * The listening ports, polled from the tab's backend while the tab is shown.
 * The first call starts the backend (Cadencr launches `bin/<platform>/port-monitor`);
 * a backend that cannot start or crashes surfaces here as a `CadencrError`.
 */
export function usePorts() {
  const client = useCadencr();
  const visible = useVisibility();
  const [state, setState] = useState<PortsState>({ status: "loading" });
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversationLoading, setConversationLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  /** Poll once; the spinner turns only when the user asked (`userInitiated`). */
  const load = useCallback(
    async (userInitiated: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (userInitiated) setRefreshing(true);
      try {
        const result = parseReply(portsSchema, "ports", await client.backend.request("ports"));
        setState({ status: "ready", ports: result.ports });
      } catch (error) {
        setState({ status: "error", error: toCadencrError(error) });
      } finally {
        inFlight.current = false;
        if (userInitiated) setRefreshing(false);
      }
    },
    [client],
  );
  const reload = useCallback(() => load(true), [load]);

  useEffect(() => {
    setConversationLoading(true);
    client.backend
      .request("context")
      .then((value) => setConversation(parseReply(conversationSchema, "context", value)))
      .catch((error: unknown) => {
        // Cadencr itself reports a backend that cannot start (with a link to
        // its Activity); a second toast would only repeat it. Anything else —
        // a timeout, a busy or exited backend — is ours to show.
        if (isReportedByHost(error)) return;
        void client.ui.toast({
          title: "Couldn't read the conversation",
          description: toCadencrError(error).message,
          variant: "error",
        });
      })
      .finally(() => setConversationLoading(false));
  }, [client]);

  useEffect(() => {
    if (!visible) return;
    void load(false);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [visible, load]);

  /**
   * Stop one process, tell the user how it went, and reload the list —
   * whatever happened, even if the toast could not be shown (then `stop`
   * rejects with that failure, after the reload).
   */
  const stop = useCallback(
    async (entry: PortEntry) => {
      try {
        await client.backend.request("stop", { pid: entry.pid });
        await client.ui.toast({
          title: `Stopped ${entry.command}`,
          description: `Process ${entry.pid} on port ${entry.port}.`,
          variant: "success",
        });
      } catch (error) {
        await client.ui.toast({
          title: `Couldn't stop ${entry.command}`,
          description: toCadencrError(error).message,
          variant: "error",
        });
      } finally {
        await reload();
      }
    },
    [client, reload],
  );

  return { state, conversation, conversationLoading, refreshing, reload, stop };
}
