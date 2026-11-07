import type {
  BrowserBounds,
  BrowserElementContext,
  BrowserNetworkEntry,
  BrowserAutomationState,
  BrowserOpenUrlOptions,
  BrowserStateSnapshot,
  BrowserTabMetadata,
} from "./browser-types";
import type { BrowserTarget } from "./browser-interactions";
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
    assert(tabId: string, scopeId?: number | null): unknown;
    guard(tabId: string, scopeId?: number | null): () => void;
  };
  openUrl(url: string, options?: BrowserOpenUrlOptions): Promise<BrowserTabMetadata>;
  openExternalUrl(url: string, options?: BrowserOpenUrlOptions): Promise<BrowserTabMetadata>;
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

export async function dispatchBrowserMcpTool(
  target: BrowserMcpTarget,
  toolName: string,
  args: Record<string, unknown>,
  // Calling feature scope; undefined means scopeless.
  scopeId?: number | null,
): Promise<BrowserBridgeResult> {
  if (toolName !== "browser_close_scope_tabs") await refreshBrowserOriginPolicy();
  switch (toolName) {
    case "browser_list_tabs":
      return text(target.automation.state(scopeId));
    case "browser_open_url": {
      const { url, options } = parseOpenUrlArgs(args, scopeId);
      const opened = await target.openUrl(url, options);
      target.automation.assert(opened.id, scopeId ?? null);
      return text(opened);
    }
    case "browser_open_external_url": {
      const { url, options } = parseOpenUrlArgs(args, scopeId);
      const opened = await target.openExternalUrl(url, options);
      target.automation.assert(opened.id, scopeId ?? null);
      return text(opened);
    }
    case "browser_get_console":
      return getConsole(target, args, scopeId);
    case "browser_get_network":
      return getNetwork(target, args, scopeId);
    case "browser_get_snapshot": {
      const id = tabId(target, args, scopeId);
      return text(
        await authorized(target, id, scopeId, () =>
          target.inspection.snapshot(
            id,
            optionalString(args.selector),
            maxLength(args),
            optionalString(args.format),
          ),
        ),
      );
    }
    case "browser_screenshot":
      return screenshot(target, args, scopeId);
    case "browser_evaluate": {
      const id = tabId(target, args, scopeId);
      return text(
        await authorized(target, id, scopeId, () =>
          target.inspection.evaluate(id, requiredString(args.script, "script")),
        ),
      );
    }
    case "browser_click":
      return click(target, args, scopeId);
    case "browser_fill":
      return fill(target, args, scopeId);
    case "browser_hover": {
      const id = tabId(target, args, scopeId);
      return text(
        await authorized(target, id, scopeId, () =>
          target.inspection.hover(
            id,
            parseTarget(args),
            target.automation.guard(id, scopeId ?? null),
          ),
        ),
      );
    }
    case "browser_wait_for":
      return waitFor(target, args, scopeId);
    case "browser_type":
      {
        const id = tabId(target, args, scopeId);
        await authorized(target, id, scopeId, () =>
          target.inspection.typeText(id, requiredString(args.text, "text")),
        );
      }
      return text({ ok: true });
    case "browser_keypress":
      {
        const id = tabId(target, args, scopeId);
        await authorized(target, id, scopeId, () =>
          target.inspection.keypress(id, requiredString(args.key, "key")),
        );
      }
      return text({ ok: true });
    case "browser_close_scope_tabs":
      return closeScopeTabs(target, scopeId);
    case "browser_select_element_context":
      return selectContext(target, args, scopeId);
    default:
      throw new Error(`Unknown Browser MCP tool: ${toolName}`);
  }
}

async function selectContext(
  target: BrowserMcpTarget,
  args: Record<string, unknown>,
  scopeId?: number | null,
): Promise<BrowserBridgeResult> {
  const id = tabId(target, args, scopeId);
  const authorize = target.automation.guard(id, scopeId ?? null);
  return text(
    await authorized(target, id, scopeId, () =>
      target.inspection.selectElementContext(id, undefined, authorize),
    ),
  );
}

/** Service-only archive cleanup, excluded from the browser MCP tool surface. */
async function closeScopeTabs(
  target: BrowserMcpTarget,
  scopeId?: number | null,
): Promise<BrowserBridgeResult> {
  if (scopeId == null) throw new Error("browser_close_scope_tabs needs a feature scope.");
  // Like the sidebar's close (`browser:close-tabs-for-scope`): restore the
  // scope's persisted tabs first, or a never-opened scope keeps them.
  const before = (await target.restoreScopeMetadata(scopeId)).tabs.length;
  const after = (await target.closeTabsForScope(scopeId)).tabs.length;
  return text({ closed_tabs: before - after });
}

function parseOpenUrlArgs(
  args: Record<string, unknown>,
  scopeId?: number | null,
): { url: string; options: BrowserOpenUrlOptions } {
  return {
    url: requiredString(args.url, "url"),
    options: {
      tabId: optionalString(args.tab_id),
      newTab: optionalBoolean(args.new_tab) ?? false,
      scopeId,
    },
  };
}

async function screenshot(
  target: BrowserMcpTarget,
  args: Record<string, unknown>,
  scopeId?: number | null,
): Promise<BrowserBridgeResult> {
  const id = tabId(target, args, scopeId);
  const selector = optionalString(args.selector);
  const ref = optionalString(args.ref);
  const region = clip(args.clip);
  const data =
    selector || ref
      ? await authorized(target, id, scopeId, () =>
          target.inspection.screenshotTarget(
            id,
            { selector, ref },
            target.automation.guard(id, scopeId ?? null),
          ),
        )
      : await authorized(target, id, scopeId, () => target.inspection.screenshot(id, region));
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

async function click(
  target: BrowserMcpTarget,
  args: Record<string, unknown>,
  scopeId?: number | null,
): Promise<BrowserBridgeResult> {
  const id = tabId(target, args, scopeId);
  if (args.selector !== undefined || args.ref !== undefined) {
    return text(
      await authorized(target, id, scopeId, () =>
        target.inspection.clickTarget(
          id,
          parseTarget(args),
          target.automation.guard(id, scopeId ?? null),
        ),
      ),
    );
  }
  await authorized(target, id, scopeId, () =>
    target.inspection.click(id, requiredNumber(args.x, "x"), requiredNumber(args.y, "y")),
  );
  return text({ ok: true });
}

async function fill(
  target: BrowserMcpTarget,
  args: Record<string, unknown>,
  scopeId?: number | null,
): Promise<BrowserBridgeResult> {
  const id = tabId(target, args, scopeId);
  await authorized(target, id, scopeId, () =>
    target.inspection.fill(id, parseTarget(args), requiredString(args.value, "value")),
  );
  return text({ ok: true });
}

async function waitFor(
  target: BrowserMcpTarget,
  args: Record<string, unknown>,
  scopeId?: number | null,
): Promise<BrowserBridgeResult> {
  const opts = {
    selector: optionalString(args.selector),
    text: optionalString(args.text),
  };
  if (!opts.selector && !opts.text) throw new Error("Expected a selector or text to wait for.");
  const id = tabId(target, args, scopeId);
  return text(
    await authorized(target, id, scopeId, () =>
      target.inspection.waitFor(id, opts, optionalNumber(args.timeout_ms)),
    ),
  );
}

function getConsole(
  target: BrowserMcpTarget,
  args: Record<string, unknown>,
  scopeId?: number | null,
): BrowserBridgeResult {
  const level = optionalString(args.level);
  const entries = target.automation.state(scopeId).consoleEntries;
  const filtered = level ? entries.filter((entry) => entry.level === level) : entries;
  return text(filtered.slice(-positiveInt(args.limit, 50)));
}

function getNetwork(
  target: BrowserMcpTarget,
  args: Record<string, unknown>,
  scopeId?: number | null,
): BrowserBridgeResult {
  const urlContains = optionalString(args.url_contains);
  const includeHeaders = args.include_headers === true;
  let entries = target.automation.state(scopeId).networkEntries;
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

function compactNetwork(
  entry: BrowserNetworkEntry,
  includeHeaders: boolean,
): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    method: entry.method,
    url: entry.url,
    status: entry.status,
    failureReason: entry.failureReason,
    resourceType: entry.resourceType,
    timestamp: entry.timestamp,
  };
  if (includeHeaders) {
    compact.requestHeaders = entry.requestHeaders;
    compact.responseHeaders = entry.responseHeaders;
  }
  return compact;
}

function parseTarget(args: Record<string, unknown>): BrowserTarget {
  const selector = optionalString(args.selector);
  const ref = optionalString(args.ref);
  if (!selector && !ref) throw new Error("Expected a selector or ref.");
  return { selector, ref };
}

function clip(value: unknown): BrowserBounds | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("Expected clip to be an object.");
  const record = value as Record<string, unknown>;
  return {
    x: requiredNumber(record.x, "clip.x"),
    y: requiredNumber(record.y, "clip.y"),
    width: requiredNumber(record.width, "clip.width"),
    height: requiredNumber(record.height, "clip.height"),
  };
}

function maxLength(args: Record<string, unknown>): number | undefined {
  const value = optionalNumber(args.max_length);
  return value !== undefined && value > 0 ? value : undefined;
}

function tabId(
  target: BrowserMcpTarget,
  args: Record<string, unknown>,
  scopeId?: number | null,
): string {
  const explicit = optionalString(args.tab_id);
  if (explicit) {
    target.automation.assert(explicit, scopeId ?? null);
    return explicit;
  }
  const active = target.automation.state(scopeId).activeTabId;
  if (!active) throw new Error("No active browser tab.");
  return active;
}

async function authorized<T>(
  target: BrowserMcpTarget,
  id: string,
  scopeId: number | null | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const authorize = target.automation.guard(id, scopeId ?? null);
  try {
    const result = await operation();
    // Discard results if sharing was revoked while an async read/wait was in flight.
    authorize();
    return result;
  } catch (error) {
    // A page-supplied error can contain private content. Hide it after revocation.
    authorize();
    throw error;
  }
}

function text(value: unknown): BrowserBridgeResult {
  return { text: JSON.stringify(value) };
}
