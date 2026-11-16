interface TabError {
  scopeId: number | null;
  message: string;
}

/**
 * Browser errors, isolated like the tabs themselves: one feature's failure
 * never shows in, nor clears, another feature's Browser.
 *
 * - A tab's error belongs to that tab: the feature shows it only while that
 *   tab is active, and it goes away when the tab recovers or closes.
 * - A scope-wide error (persistence, downloads, cleanup) shows on every tab of
 *   its feature until the user navigates there or its tabs are all closed.
 */
export class BrowserScopeErrors {
  private readonly scopeErrors = new Map<number | null, string>();
  private readonly tabErrors = new Map<string, TabError>();

  /**
   * The error the feature shows: its scope-wide error, else its active tab's.
   * The unscoped all-tabs view (`undefined`) has none of its own.
   */
  get(scopeId: number | null | undefined, activeTabId: string | null): string | null {
    if (scopeId === undefined) return null;
    const scopeWide = this.scopeErrors.get(scopeId);
    if (scopeWide !== undefined) return scopeWide;
    const tabError = activeTabId ? this.tabErrors.get(activeTabId) : undefined;
    return tabError?.scopeId === scopeId ? tabError.message : null;
  }

  /** Returns whether anything changed, so a repeated failure is not re-published. */
  report(scopeId: number | null, message: string, tabId: string | null = null): boolean {
    if (tabId === null) {
      if (this.scopeErrors.get(scopeId) === message) return false;
      this.scopeErrors.set(scopeId, message);
      return true;
    }
    const current = this.tabErrors.get(tabId);
    if (current?.scopeId === scopeId && current.message === message) return false;
    this.tabErrors.set(tabId, { scopeId, message });
    return true;
  }

  /**
   * The user (or an agent) navigated a tab: drop its own error and the
   * feature's scope-wide one, but never another tab's.
   */
  clearForNavigation(scopeId: number | null, tabId: string): void {
    this.tabErrors.delete(tabId);
    this.scopeErrors.delete(scopeId);
  }

  /** The tab recovered or closed: its own error goes, scope-wide ones stay. */
  releaseTab(tabId: string): void {
    this.tabErrors.delete(tabId);
  }

  /** Every tab of the scope is being closed. */
  clearScope(scopeId: number | null): void {
    this.scopeErrors.delete(scopeId);
    for (const [tabId, error] of this.tabErrors) {
      if (error.scopeId === scopeId) this.tabErrors.delete(tabId);
    }
  }
}
