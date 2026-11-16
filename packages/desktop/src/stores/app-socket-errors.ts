import { toast } from "sonner";
import { parseErrorPayload } from "./ws-envelope-payload-session";

/**
 * Error replies the service sends on the app socket when a subscription fails
 * — e.g. `WATCHER_ERROR` when Linux runs out of inotify watches. No session
 * owns them, so they are surfaced here instead of being dropped.
 */
export function handleAppSocketError(domain: string, action: string, payload: unknown): boolean {
  if (domain !== "session" || action !== "error") return false;
  const error = parseErrorPayload(payload);
  const title =
    error?.code === "WATCHER_ERROR" ? "File watching stopped" : "Background update failed";
  toast.error(title, {
    id: `app-socket-error:${error?.code ?? "unknown"}`,
    description: error?.message ?? "The service rejected a background subscription.",
  });
  return true;
}
