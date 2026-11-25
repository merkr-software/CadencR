import type { BrowserScopeIssue } from "../../src/shared/browser-scope-error-copy";
import { isViewportPageError } from "./browser-load-errors";
import type { BrowserTabError } from "./browser-types";

interface TabErrorEntry {
  scopeId: number | null;
  error: BrowserTabError;
}

/**
 * Browser errors, isolated like the tabs themselves: one feature's failure
 * never shows in, nor clears, another feature's Browser.
 *
 * - A tab's structured error belongs to that tab: the feature shows it only
 *   while that tab is active, and it goes away when the tab navigates,
 *   recovers, is dismissed, or closes.
 * - A scope-wide error (persistence, downloads, cleanup) is a brief notice for
 *   the whole feature until dismissed, navigated away, or the scope closes.
 */
export class BrowserScopeErrors {
  private readonly scopeErrors = new Map<
    number | null,
    { message: string; issue?: BrowserScopeIssue }
  >();
  private readonly tabErrors = new Map<string, TabErrorEntry>();

  /**
   * The scope-wide error notice for this feature, or null.
   * The unscoped all-tabs view (`undefined`) has none of its own.
   */
  get(scopeId: number | null | undefined): string | null {
    if (scopeId === undefined) return null;
    return this.scopeErrors.get(scopeId)?.message ?? null;
  }

  getIssue(scopeId: number | null | undefined): BrowserScopeIssue | undefined {
    if (scopeId === undefined) return undefined;
    return this.scopeErrors.get(scopeId)?.issue;
  }

  /** The active tab's structured error when it belongs to `scopeId`, else null. */
  getTabError(
    scopeId: number | null | undefined,
    activeTabId: string | null,
  ): BrowserTabError | null {
    if (scopeId === undefined || !activeTabId) return null;
    const entry = this.tabErrors.get(activeTabId);
    return entry?.scopeId === scopeId ? entry.error : null;
  }

  /** The stored structured error for `tabId`, regardless of active status. */
  tabErrorFor(tabId: string): BrowserTabError | null {
    return this.tabErrors.get(tabId)?.error ?? null;
  }

  /** Whether `tabId` currently displays a full-viewport error page occluding its native guest. */
  hasViewportPageError(tabId: string): boolean {
    return isViewportPageError(this.tabErrors.get(tabId)?.error);
  }

  /** Record a scope-wide error notice; false when the same issue is already stored. */
  report(scopeId: number | null, message: string, issue?: BrowserScopeIssue): boolean {
    const current = this.scopeErrors.get(scopeId);
    if (current?.message === message && JSON.stringify(current.issue) === JSON.stringify(issue)) {
      return false;
    }
    this.scopeErrors.set(scopeId, { message, issue });
    return true;
  }

  /** Store a structured error for one tab; false when an identical error is already stored. */
  reportTab(scopeId: number | null, tabId: string, error: BrowserTabError): boolean {
    const current = this.tabErrors.get(tabId);
    if (current?.scopeId === scopeId && sameTabError(current.error, error)) return false;
    this.tabErrors.set(tabId, { scopeId, error });
    return true;
  }

  /**
   * The user (or an agent) navigated a tab: drop its own error and the
   * feature's scope-wide one, but never another tab's.
   */
  clearForNavigation(scopeId: number | null, tabId: string): boolean {
    const clearedTab = this.tabErrors.delete(tabId);
    const clearedScope = this.scopeErrors.delete(scopeId);
    return clearedTab || clearedScope;
  }

  /** The tab recovered or closed: its own error goes, scope-wide ones stay. */
  releaseTab(tabId: string): boolean {
    return this.tabErrors.delete(tabId);
  }

  /** Dismiss either a specific tab's error (`tabId != null`) or the scope-wide notice (`tabId == null`). */
  dismiss(scopeId: number | null, tabId?: string | null): boolean {
    if (tabId != null) {
      return this.tabErrors.get(tabId)?.scopeId === scopeId ? this.tabErrors.delete(tabId) : false;
    }
    return this.scopeErrors.delete(scopeId);
  }

  /** Every tab of the scope is being closed. */
  clearScope(scopeId: number | null): boolean {
    let changed = this.scopeErrors.delete(scopeId);
    for (const [tabId, entry] of this.tabErrors) {
      if (entry.scopeId === scopeId) {
        this.tabErrors.delete(tabId);
        changed = true;
      }
    }
    return changed;
  }
}

function sameTabError(left: BrowserTabError, right: BrowserTabError): boolean {
  return (
    left.kind === right.kind &&
    left.title === right.title &&
    left.description === right.description &&
    left.code === right.code &&
    left.url === right.url
  );
}
