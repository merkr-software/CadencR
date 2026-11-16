import type { WebContents } from "electron";
import { parseStartupRecoveryActionUrl } from "./startup-recovery";
import type { StartupRecoveryActionId } from "./startup-recovery";

/** The splash is a fixed document; its only navigation is an intercepted recovery action. */
export function secureSplashWebContents(
  contents: WebContents,
  onAction: (action: StartupRecoveryActionId) => void,
): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    const action = parseStartupRecoveryActionUrl(event.url);
    if (action) onAction(action);
  });
  contents.on("will-frame-navigate", (details) => {
    if (!details.isMainFrame) details.preventDefault();
  });
  contents.on("will-redirect", (event) => event.preventDefault());
}
