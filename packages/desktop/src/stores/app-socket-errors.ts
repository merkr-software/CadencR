import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";
import { parseErrorPayload } from "./ws-envelope-payload-session";

/**
 * Error replies for app subscriptions, including the editor file watcher.
 * Git status and its watcher setup are reported by the feature-scoped Git stream.
 */
export function handleAppSocketError(domain: string, action: string, payload: unknown): boolean {
  if (domain !== "session" || action !== "error") return false;
  const error = parseErrorPayload(payload);
  const title =
    error?.code === "WATCHER_ERROR"
      ? translateUi("appSocket.errors.editorWatchingStopped", "Editor file watching stopped")
      : translateUi("appSocket.errors.backgroundUpdateFailed", "Background update failed");
  toast.error(title, {
    id: `app-socket-error:${error?.code ?? "unknown"}`,
    description:
      error?.message ??
      translateUi(
        "appSocket.errors.subscriptionRejected",
        "The service rejected a background subscription.",
      ),
  });
  return true;
}
