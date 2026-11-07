import type { BrowserWindow } from "electron";
import { agentActivityFor } from "./browser-agent-activity";
import { startBrowserBridgeServer, type BrowserBridgeHandle } from "./browser-bridge-server";
import type { BrowserManager } from "./browser-manager";
import { dispatchBrowserMcpTool } from "./browser-mcp-dispatch";
import { sendToWindow } from "./safe-send";
import type { SidecarHandle } from "./sidecar";

/** The loopback endpoint the service relays agents' Browser MCP calls to. */
export function startAgentBrowserBridge(
  getManager: () => BrowserManager | null,
  getMainWindow: () => BrowserWindow | null,
): Promise<BrowserBridgeHandle> {
  return startBrowserBridgeServer({
    dispatch: async (toolName, args, featureId) => {
      const manager = getManager();
      if (!manager) throw new Error("Browser manager is not ready.");
      // Shield the renderer's focus (most visibly the agent prompt) from being
      // stolen by the guest page while the agent drives the browser.
      const result = await manager.focusGuard.run(() =>
        dispatchBrowserMcpTool(manager, toolName, args, featureId),
      );
      // Let the renderer follow the agent (auto layout, activity indicator).
      const activity = agentActivityFor(toolName, featureId);
      if (activity) sendToWindow(getMainWindow(), "browser:agent-activity", activity);
      return result;
    },
  });
}

/**
 * The dev service runs outside Electron, so it learns the Browser bridge over
 * HTTP once it is up (the packaged one gets it through its environment).
 */
export async function registerBrowserBridgeWithService(
  handle: SidecarHandle,
  bridge: BrowserBridgeHandle,
): Promise<void> {
  if (!handle.authToken) {
    throw new Error("Cannot register Browser bridge: service auth token is missing.");
  }
  const response = await retryBrowserBridgeRegistration(handle, bridge);
  if (!response.ok) {
    throw new Error(
      `Cannot register Browser bridge: service returned ${response.status} ${await response.text()}`,
    );
  }
}

async function retryBrowserBridgeRegistration(
  handle: SidecarHandle,
  bridge: BrowserBridgeHandle,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await fetch(`${handle.baseUrl}/api/browser-bridge`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-cadencr-token": handle.authToken ?? "",
        },
        body: JSON.stringify({ url: bridge.url, token: bridge.token }),
      });
    } catch (error) {
      lastError = error;
      if (attempt < 59) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Cannot register Browser bridge: ${String(lastError)}`);
}
