import type { BrowserAgentActivity } from "./browser-types";

/** Tools that don't act on a page the user would want to watch. */
const UNWATCHED_TOOLS = new Set(["browser_list_tabs", "browser_open_external_url"]);

/**
 * The `browser:agent-activity` event to push after an agent browser MCP call
 * succeeds, or null when there's nothing for the renderer to follow (no feature
 * pin, or a tool that doesn't touch an in-app page).
 */
export function agentActivityFor(
  toolName: string,
  featureId: number | undefined,
): BrowserAgentActivity | null {
  if (featureId === undefined || UNWATCHED_TOOLS.has(toolName)) return null;
  return { scopeId: featureId, action: toolName === "browser_open_url" ? "open" : "interact" };
}
