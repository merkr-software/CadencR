import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { parseToolArgsObject } from "@/lib/tool-args";

export interface McpTool {
  server: string;
  tool: string;
  label: string;
  detail?: string;
  arguments: Record<string, unknown>;
}

interface McpIdentity {
  server: string;
  tool: string;
}

const MCP_PREFIX = "mcp__";
const HISTORICAL_SERVER_ALIASES: Record<string, string> = {
  cadencr_browser: "cadencr-browser",
  cadencr_project: "cadencr-project",
  cadencr_workspace: "cadencr-workspace",
  chrome_devtools: "chrome-devtools",
};

// Production OpenCode history predating adapter-side canonicalization stores
// MCP calls as `<server>_<tool>`. Bare names are ambiguous, so only resolve
// servers observed in that history; new calls are canonicalized before persist.
const HISTORICAL_BARE_SERVERS = ["chrome-devtools", "codegraph"] as const;

const FRIENDLY_LABELS: Record<string, (t: UiTranslator) => string> = {
  browser_click: (t) => t("tools.mcp.clickingBrowser", "Clicking browser"),
  browser_get_console: (t) => t("tools.mcp.readingConsole", "Reading console"),
  browser_get_network: (t) => t("tools.mcp.readingNetwork", "Reading network"),
  browser_get_snapshot: (t) => t("tools.mcp.capturingSnapshot", "Capturing snapshot"),
  browser_keypress: (t) => t("tools.mcp.pressingKey", "Pressing key"),
  browser_list_tabs: (t) => t("tools.mcp.listingBrowserTabs", "Listing browser tabs"),
  browser_open_url: (t) => t("tools.mcp.openingUrl", "Opening URL"),
  browser_select_element_context: (t) =>
    t("tools.mcp.selectingElementContext", "Selecting element context"),
  browser_screenshot: (t) => t("tools.mcp.takingScreenshot", "Taking screenshot"),
  browser_type: (t) => t("tools.mcp.typingInBrowser", "Typing in browser"),
  click: (t) => t("tools.mcp.clicking", "Clicking"),
  evaluate_script: (t) => t("tools.mcp.evaluatingScript", "Evaluating script"),
  fetch_openai_doc: (t) => t("tools.mcp.fetchingDocumentation", "Fetching documentation"),
  fill: (t) => t("tools.mcp.fillingField", "Filling field"),
  list_console_messages: (t) => t("tools.mcp.readingConsole", "Reading console"),
  list_pages: (t) => t("tools.mcp.listingPages", "Listing pages"),
  navigate_page: (t) => t("tools.mcp.navigatingPage", "Navigating page"),
  new_page: (t) => t("tools.mcp.openingPage", "Opening page"),
  project_archive_session: (t) => t("tools.mcp.archivingASession", "Archiving a session"),
  project_compare_sessions: (t) => t("tools.mcp.comparingSessions", "Comparing sessions"),
  project_create_schedule: (t) => t("tools.mcp.schedulingAPrompt", "Scheduling a prompt"),
  project_delete_schedule: (t) => t("tools.mcp.deletingASchedule", "Deleting a schedule"),
  project_find_related_sessions: (t) =>
    t("tools.mcp.findingRelatedSessions", "Finding related sessions"),
  project_get_session_status: (t) =>
    t("tools.mcp.checkingSessionStatus", "Checking session status"),
  project_get_settings: (t) => t("tools.mcp.readingSettings", "Reading settings"),
  project_get_worktree_status: (t) =>
    t("tools.mcp.checkingWorktreeStatus", "Checking worktree status"),
  project_link_sessions: (t) => t("tools.mcp.linkingSessions", "Linking sessions"),
  project_list_schedules: (t) => t("tools.mcp.listingSchedules", "Listing schedules"),
  project_list_sessions: (t) => t("tools.mcp.listingProjectSessions", "Listing project sessions"),
  project_read_session: (t) => t("tools.mcp.readingProjectSession", "Reading project session"),
  project_read_session_tail: (t) => t("tools.mcp.readingSessionTail", "Reading session tail"),
  project_send_session_message: (t) =>
    t("tools.mcp.sendingSessionMessage", "Sending session message"),
  project_spawn_session: (t) => t("tools.mcp.spawningSession", "Spawning session"),
  project_update_schedule: (t) => t("tools.mcp.updatingASchedule", "Updating a schedule"),
  project_update_settings: (t) => t("tools.mcp.changingSettings", "Changing settings"),
  search_commits: (t) => t("tools.mcp.searchingCommits", "Searching commits"),
  search_openai_docs: (t) => t("tools.mcp.searchingDocumentation", "Searching documentation"),
  take_screenshot: (t) => t("tools.mcp.takingScreenshot", "Taking screenshot"),
  take_snapshot: (t) => t("tools.mcp.takingSnapshot", "Taking snapshot"),
  wait_for: (t) => t("tools.mcp.waitingForPage", "Waiting for page"),
  workspace_get_settings: (t) => t("tools.mcp.readingSettings", "Reading settings"),
  workspace_list_projects: (t) =>
    t("tools.mcp.listingWorkspaceProjects", "Listing workspace projects"),
  workspace_read_session: (t) =>
    t("tools.mcp.readingWorkspaceSession", "Reading workspace session"),
  workspace_read_sessions: (t) =>
    t("tools.mcp.searchingWorkspaceSessions", "Searching workspace sessions"),
  workspace_recent_activity: (t) => t("tools.mcp.readingRecentActivity", "Reading recent activity"),
  workspace_session_graph: (t) => t("tools.mcp.readingSessionGraph", "Reading session graph"),
  workspace_update_settings: (t) => t("tools.mcp.changingSettings", "Changing settings"),
};

export function parseMcpTool(
  toolName: string,
  toolArgs?: string,
  t: UiTranslator = translateUi,
): McpTool | undefined {
  const namedIdentity = identityFromName(toolName);
  if (!namedIdentity) return undefined;

  const rawArgs = parseToolArgsObject(toolArgs) ?? {};
  const explicit = explicitIdentity(rawArgs);
  const identity = explicit ?? namedIdentity;

  const normalized = normalizeAppIdentity(identity, rawArgs);
  const args = explicit ? nestedArguments(rawArgs) : rawArgs;
  const displayServer = normalized.server.startsWith("cadencr-")
    ? normalized.server.slice("cadencr-".length)
    : normalized.server;
  return {
    server: displayServer,
    tool: normalized.tool,
    label: Object.hasOwn(FRIENDLY_LABELS, normalized.tool)
      ? FRIENDLY_LABELS[normalized.tool](t)
      : titleCaseTool(normalized.tool),
    detail: mcpDetail(args, t),
    arguments: args,
  };
}

/** Stable semantic identity for grouping MCP calls without parsing their arguments. */
export function mcpToolKey(toolName: string): string | undefined {
  const identity = identityFromName(toolName);
  if (!identity) return undefined;
  const normalized = normalizeAppIdentity(identity, {});
  return `${normalized.server}:${normalized.tool}`;
}

function explicitIdentity(args: Record<string, unknown>): McpIdentity | undefined {
  const server = nonEmptyString(args.server);
  const tool = nonEmptyString(args.tool);
  return server && tool ? { server, tool } : undefined;
}

function identityFromName(name: string): McpIdentity | undefined {
  if (name.startsWith(MCP_PREFIX)) return prefixedIdentity(name.slice(MCP_PREFIX.length));
  return bareIdentity(name);
}

function prefixedIdentity(rest: string): McpIdentity | undefined {
  const separator = rest.indexOf("__");
  if (separator < 1) return undefined;
  const rawServer = rest.slice(0, separator);
  const tool = rest.slice(separator + 2).replace(/^_+/, "");
  if (!tool) return undefined;
  return { server: HISTORICAL_SERVER_ALIASES[rawServer] ?? rawServer, tool };
}

function bareIdentity(name: string): McpIdentity | undefined {
  const server = HISTORICAL_BARE_SERVERS.find((candidate) => name.startsWith(`${candidate}_`));
  if (!server) return undefined;
  const tool = name.slice(server.length + 1);
  return tool ? { server, tool } : undefined;
}

function normalizeAppIdentity(identity: McpIdentity, args: Record<string, unknown>): McpIdentity {
  if (identity.server !== "codex_apps") return identity;
  const appContext = recordValue(args.appContext);
  const contextApp = nonEmptyString(appContext?.appName)?.toLowerCase();
  const contextAction = nonEmptyString(appContext?.actionName);
  if (contextApp && contextAction) return { server: contextApp, tool: contextAction };

  const separator = identity.tool.includes(".") ? "." : identity.tool.includes("___") ? "___" : "_";
  const index = identity.tool.indexOf(separator);
  if (index < 1) return identity;
  return {
    server: identity.tool.slice(0, index),
    tool: identity.tool.slice(index + separator.length),
  };
}

function nestedArguments(args: Record<string, unknown>): Record<string, unknown> {
  return recordValue(args.arguments) ?? args;
}

function mcpDetail(args: Record<string, unknown>, t: UiTranslator): string | undefined {
  const tabId = nonEmptyString(args.tab_id);
  if (tabId) return t("tools.mcp.tab", "Tab {{tabId}}", { tabId });
  for (const key of [
    "title",
    "summary",
    "commit_message",
    "repository_full_name",
    "repo_full_name",
    "query",
    "url",
    "filePath",
    "file_path",
    "key",
  ]) {
    const value = nonEmptyString(args[key]);
    if (value) return value.slice(0, 120);
  }
  for (const key of ["prompt", "message"]) {
    const value = nonEmptyString(args[key]);
    if (value) return value.slice(0, 80);
  }
  return undefined;
}

function titleCaseTool(name: string): string {
  return name
    .replace(/[.-]/g, "_")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
