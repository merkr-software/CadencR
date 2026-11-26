import type {
  BrowserAgentTabsList,
  BrowserAutomationState,
  BrowserBounds,
  BrowserElementContext,
  BrowserNetworkEntry,
  BrowserOpenUrlOptions,
  BrowserStateSnapshot,
  BrowserTabMetadata,
} from "./browser-types";
import type { BrowserTarget } from "./browser-interactions";
import type { EnsureAgentAccessOptions } from "./browser-open-controller";
import { refreshBrowserOriginPolicy } from "./runtime-config";
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  positiveInt,
  requiredNumber,
  requiredString,
} from "./browser-arg-validation";

export interface BrowserMcpTarget {
  state(scopeId?: number | null): BrowserStateSnapshot;
  automation: {
    state(scopeId?: number | null): BrowserAutomationState;
    listTabs(scopeId?: number | null): BrowserAgentTabsList;
    assert(tabId: string, scopeId?: number | null): unknown;
    assertApprovable?: (tabId: string, scopeId?: number | null, allowBlank?: boolean) => unknown;
    isSharedOrAgent?: (tabId: string, scopeId?: number | null) => boolean;
    tabLogs?: (
      tabId: string,
      scopeId?: number | null,
    ) => Pick<BrowserAutomationState, "consoleEntries" | "networkEntries">;
    guard(tabId: string, scopeId?: number | null): () => void;
  };
  activeScopeTabId?: (scopeId?: number | null) => string | null;
  ensureAgentAccess?: (
    tabId: string,
    scopeId: number | null,
    options?: EnsureAgentAccessOptions,
  ) => Promise<void>;
  openUrl(
    url: string,
    options?: BrowserOpenUrlOptions,
    signal?: AbortSignal,
  ): Promise<BrowserTabMetadata>;
  openExternalUrl(
    url: string,
    options?: BrowserOpenUrlOptions,
    signal?: AbortSignal,
  ): Promise<BrowserTabMetadata>;
  ensureScopeRestored?: (scopeId: number) => Promise<void>;
  restoreScopeMetadata(scopeId: number): Promise<BrowserStateSnapshot>;
  closeTabsForScope(scopeId: number): Promise<BrowserStateSnapshot>;
  inspection: {
    snapshot(
      tabId: string,
      selector?: string,
      maxLength?: number,
      format?: string,
    ): Promise<unknown>;
    screenshot(tabId: string, clip?: BrowserBounds): Promise<string>;
    screenshotTarget(tabId: string, target: BrowserTarget, authorize?: () => void): Promise<string>;
    evaluate(tabId: string, script: string): Promise<unknown>;
    click(tabId: string, x: number, y: number): Promise<void>;
    clickTarget(tabId: string, target: BrowserTarget, authorize?: () => void): Promise<unknown>;
    fill(tabId: string, target: BrowserTarget, value: string): Promise<void>;
    hover(tabId: string, target: BrowserTarget, authorize?: () => void): Promise<unknown>;
    waitFor(
      tabId: string,
      opts: { selector?: string; text?: string },
      timeoutMs?: number,
    ): Promise<unknown>;
    typeText(tabId: string, text: string): Promise<void>;
    keypress(tabId: string, keyCode: string): Promise<void>;
    selectElementContext(
      tabId: string,
      anchorId?: string,
      authorize?: () => void,
    ): Promise<BrowserElementContext | unknown>;
  };
}

/** Result of a Browser MCP tool: a JSON text payload plus an optional viewable image. */
export interface BrowserBridgeResult {
  text: string;
  image?: { mimeType: string; data: string };
}

type Args = Record<string, unknown>;
type ScopeId = number | null | undefined;

export async function dispatchBrowserMcpTool(
  target: BrowserMcpTarget,
  toolName: string,
  args: Args,
  // Calling feature scope; undefined means scopeless.
  scopeId?: number | null,
  signal?: AbortSignal,
): Promise<BrowserBridgeResult> {
  if (toolName !== "browser_close_scope_tabs") await refreshBrowserOriginPolicy();
  const run = <T>(op: (id: string, auth: () => void) => Promise<T>) =>
    withTab(target, args, scopeId, signal, op);
  const runText = async (op: (id: string, auth: () => void) => Promise<unknown>) =>
    text(await run(op));
  const runOk = async (op: (id: string) => Promise<void>) => {
    await run(op);
    return text({ ok: true });
  };
  switch (toolName) {
    case "browser_list_tabs":
      if (scopeId != null) {
        if (target.ensureScopeRestored) await target.ensureScopeRestored(scopeId);
        else await target.restoreScopeMetadata(scopeId);
      }
      return text(target.automation.listTabs(scopeId));
    case "browser_open_url":
      return openTab(target, args, scopeId, false, signal);
    case "browser_open_external_url":
      return openTab(target, args, scopeId, true, signal);
    case "browser_get_console":
      return getConsole(target, args, scopeId, signal);
    case "browser_get_network":
      return getNetwork(target, args, scopeId, signal);
    case "browser_get_snapshot":
      return runText((id) =>
        target.inspection.snapshot(
          id,
          optionalString(args.selector),
          maxLength(args),
          optionalString(args.format),
        ),
      );
    case "browser_screenshot":
      return screenshot(target, args, scopeId, signal);
    case "browser_evaluate":
      return runText((id) => target.inspection.evaluate(id, requiredString(args.script, "script")));
    case "browser_click":
      return args.selector !== undefined || args.ref !== undefined
        ? runText((id, auth) => target.inspection.clickTarget(id, parseTarget(args), auth))
        : runOk((id) =>
            target.inspection.click(id, requiredNumber(args.x, "x"), requiredNumber(args.y, "y")),
          );
    case "browser_fill":
      return runOk((id) =>
        target.inspection.fill(id, parseTarget(args), requiredString(args.value, "value")),
      );
    case "browser_hover":
      return runText((id, auth) => target.inspection.hover(id, parseTarget(args), auth));
    case "browser_wait_for": {
      const opts = { selector: optionalString(args.selector), text: optionalString(args.text) };
      if (!opts.selector && !opts.text) throw new Error("Expected a selector or text to wait for.");
      return runText((id) => target.inspection.waitFor(id, opts, optionalNumber(args.timeout_ms)));
    }
    case "browser_type":
      return runOk((id) => target.inspection.typeText(id, requiredString(args.text, "text")));
    case "browser_keypress":
      return runOk((id) => target.inspection.keypress(id, requiredString(args.key, "key")));
    case "browser_close_scope_tabs":
      return closeScopeTabs(target, scopeId);
    case "browser_select_element_context":
      return runText((id, auth) => target.inspection.selectElementContext(id, undefined, auth));
    default:
      throw new Error(`Unknown Browser MCP tool: ${toolName}`);
  }
}

async function openTab(
  target: BrowserMcpTarget,
  args: Args,
  scopeId: ScopeId,
  external: boolean,
  signal?: AbortSignal,
): Promise<BrowserBridgeResult> {
  const url = requiredString(args.url, "url");
  const options: BrowserOpenUrlOptions = {
    tabId: optionalString(args.tab_id),
    newTab: optionalBoolean(args.new_tab) ?? false,
    scopeId,
  };
  const opened = external
    ? signal
      ? await target.openExternalUrl(url, options, signal)
      : await target.openExternalUrl(url, options)
    : signal
      ? await target.openUrl(url, options, signal)
      : await target.openUrl(url, options);
  target.automation.assert(opened.id, scopeId ?? null);
  return text(opened);
}

/** Service-only archive cleanup, excluded from the browser MCP tool surface. */
async function closeScopeTabs(
  target: BrowserMcpTarget,
  scopeId: ScopeId,
): Promise<BrowserBridgeResult> {
  if (scopeId == null) throw new Error("browser_close_scope_tabs needs a feature scope.");
  // Like the sidebar's close (`browser:close-tabs-for-scope`): restore the
  // scope's persisted tabs first, or a never-opened scope keeps them.
  const before = (await target.restoreScopeMetadata(scopeId)).tabs.length;
  const after = (await target.closeTabsForScope(scopeId)).tabs.length;
  return text({ closed_tabs: before - after });
}

async function screenshot(
  target: BrowserMcpTarget,
  args: Args,
  scopeId: ScopeId,
  signal?: AbortSignal,
): Promise<BrowserBridgeResult> {
  const selector = optionalString(args.selector);
  const ref = optionalString(args.ref);
  const region = clip(args.clip);
  const { id, data } = await withTab(target, args, scopeId, signal, async (tabId, authorize) => ({
    id: tabId,
    data:
      selector || ref
        ? await target.inspection.screenshotTarget(tabId, { selector, ref }, authorize)
        : await target.inspection.screenshot(tabId, region),
  }));
  // Empty captures produce malformed image data that can wedge later agent turns.
  if (!data) {
    throw new Error(
      "Screenshot returned no image data — the tab is blank or not rendered yet. " +
        "Use browser_get_snapshot to inspect the page, or wait for it to load.",
    );
  }
  return {
    text: JSON.stringify({
      tabId: id,
      selector: selector ?? null,
      ref: ref ?? null,
      clip: region ?? null,
      format: "png",
    }),
    image: { mimeType: "image/png", data },
  };
}

async function getConsole(
  target: BrowserMcpTarget,
  args: Args,
  scopeId: ScopeId,
  signal?: AbortSignal,
): Promise<BrowserBridgeResult> {
  const level = optionalString(args.level);
  const { consoleEntries } = await resolveLogs(target, args, scopeId, signal);
  const filtered = level ? consoleEntries.filter((entry) => entry.level === level) : consoleEntries;
  return text(filtered.slice(-positiveInt(args.limit, 50)));
}

async function getNetwork(
  target: BrowserMcpTarget,
  args: Args,
  scopeId: ScopeId,
  signal?: AbortSignal,
): Promise<BrowserBridgeResult> {
  const urlContains = optionalString(args.url_contains);
  const includeHeaders = args.include_headers === true;
  let { networkEntries: entries } = await resolveLogs(target, args, scopeId, signal);
  if (args.failed_only === true) {
    entries = entries.filter((entry) => entry.failureReason || (entry.status ?? 0) >= 400);
  }
  if (urlContains) entries = entries.filter((entry) => entry.url.includes(urlContains));
  return text(
    entries
      .slice(-positiveInt(args.limit, 50))
      .map((entry) => compactNetwork(entry, includeHeaders)),
  );
}

async function resolveLogs(
  target: BrowserMcpTarget,
  args: Args,
  scopeId: ScopeId,
  signal?: AbortSignal,
): Promise<Pick<BrowserAutomationState, "consoleEntries" | "networkEntries">> {
  const explicit = optionalString(args.tab_id);
  if (explicit) {
    await approveAndAssert(target, explicit, scopeId, signal);
    return readTabLogs(target, explicit, scopeId);
  }
  const scopeActive = target.activeScopeTabId?.(scopeId);
  if (scopeActive) {
    if (target.automation.isSharedOrAgent?.(scopeActive, scopeId)) {
      try {
        return readTabLogs(target, scopeActive, scopeId);
      } catch {
        return { consoleEntries: [], networkEntries: [] };
      }
    }
    if (target.ensureAgentAccess) {
      const listed = target.automation.listTabs(scopeId).tabs.find((tab) => tab.id === scopeActive);
      if (listed?.requiresApproval) {
        await approveAndAssert(target, scopeActive, scopeId, signal);
        return readTabLogs(target, scopeActive, scopeId);
      }
    }
    return { consoleEntries: [], networkEntries: [] };
  }
  return target.automation.state(scopeId);
}

function readTabLogs(
  target: BrowserMcpTarget,
  tabId: string,
  scopeId: ScopeId,
): Pick<BrowserAutomationState, "consoleEntries" | "networkEntries"> {
  if (target.automation.tabLogs) return target.automation.tabLogs(tabId, scopeId);
  const state = target.automation.state(scopeId);
  return {
    consoleEntries: state.consoleEntries.filter((entry) => entry.tabId === tabId),
    networkEntries: state.networkEntries.filter((entry) => entry.tabId === tabId),
  };
}

function compactNetwork(
  entry: BrowserNetworkEntry,
  includeHeaders: boolean,
): Record<string, unknown> {
  const base = {
    method: entry.method,
    url: entry.url,
    status: entry.status,
    failureReason: entry.failureReason,
    resourceType: entry.resourceType,
    timestamp: entry.timestamp,
  };
  return includeHeaders
    ? { ...base, requestHeaders: entry.requestHeaders, responseHeaders: entry.responseHeaders }
    : base;
}

function parseTarget(args: Args): BrowserTarget {
  const selector = optionalString(args.selector);
  const ref = optionalString(args.ref);
  if (!selector && !ref) throw new Error("Expected a selector or ref.");
  return { selector, ref };
}

function clip(value: unknown): BrowserBounds | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("Expected clip to be an object.");
  const record = value as Args;
  return {
    x: requiredNumber(record.x, "clip.x"),
    y: requiredNumber(record.y, "clip.y"),
    width: requiredNumber(record.width, "clip.width"),
    height: requiredNumber(record.height, "clip.height"),
  };
}

function maxLength(args: Args): number | undefined {
  const value = optionalNumber(args.max_length);
  return value !== undefined && value > 0 ? value : undefined;
}

async function withTab<T>(
  target: BrowserMcpTarget,
  args: Args,
  scopeId: ScopeId,
  signal: AbortSignal | undefined,
  operation: (id: string, authorize: () => void) => Promise<T>,
): Promise<T> {
  const id = await resolveTabId(target, args, scopeId, signal);
  const authorize = target.automation.guard(id, scopeId ?? null);
  try {
    const result = await operation(id, authorize);
    // Discard results if sharing was revoked while an async read/wait was in flight.
    authorize();
    return result;
  } catch (error) {
    // A page-supplied error can contain private content. Hide it after revocation.
    authorize();
    throw error;
  }
}

async function resolveTabId(
  target: BrowserMcpTarget,
  args: Args,
  scopeId: ScopeId,
  signal?: AbortSignal,
): Promise<string> {
  const explicit = optionalString(args.tab_id);
  if (explicit) return approveAndAssert(target, explicit, scopeId, signal);
  const scopeActive = target.activeScopeTabId?.(scopeId);
  if (scopeActive) return approveAndAssert(target, scopeActive, scopeId, signal);
  const active = target.automation.state(scopeId).activeTabId;
  if (active) return active;
  throw new Error("No active browser tab.");
}

async function approveAndAssert(
  target: BrowserMcpTarget,
  id: string,
  scopeId: ScopeId,
  signal?: AbortSignal,
): Promise<string> {
  const normalizedScopeId = scopeId ?? null;
  if (target.ensureAgentAccess && !target.automation.isSharedOrAgent?.(id, normalizedScopeId)) {
    await target.ensureAgentAccess(id, normalizedScopeId, { allowBlank: false, signal });
  }
  target.automation.assert(id, normalizedScopeId);
  return id;
}

function text(value: unknown): BrowserBridgeResult {
  return { text: JSON.stringify(value) };
}
