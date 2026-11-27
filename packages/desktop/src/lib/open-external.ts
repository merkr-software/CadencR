import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";
import { apiErrorMessage, stripElectronIpcPrefix } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";

/**
 * Hand `url` to the OS browser, surfacing a failure as a toast.
 *
 * Never rejects: every caller is a fire-and-forget "open this in my browser"
 * affordance, so the failure belongs in front of the user, not in a `catch` at
 * each call site.
 */
export async function openExternalUrl(url: string, failureMessage: string): Promise<boolean> {
  try {
    await desktopBridge.openExternal(url);
    return true;
  } catch (error) {
    toast.error(failureMessage, {
      description: stripElectronIpcPrefix(
        apiErrorMessage(error, translateUi("workspace.links.openFailed", "External link failed")),
      ),
    });
    return false;
  }
}
