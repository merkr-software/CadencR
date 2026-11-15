interface ScopeError {
  message: string;
  /** Tab that raised it; `null` for scope-wide failures (persistence, downloads, cleanup). */
  tabId: string | null;
}

/**
 * Last browser error of each feature scope. Errors stay isolated like the tabs
 * themselves: one feature's failed page load never shows in, nor clears,
 * another feature's Browser. A tab's error goes away when that tab recovers
 * or closes; a scope-wide one when the user navigates in that feature.
 */
export class BrowserScopeErrors {
  private readonly errors = new Map<number | null, ScopeError>();

  /** The scope's error; the unscoped all-tabs view (`undefined`) has none of its own. */
  get(scopeId: number | null | undefined): string | null {
    if (scopeId === undefined) return null;
    return this.errors.get(scopeId)?.message ?? null;
  }

  /** Returns whether anything changed, so a repeated failure is not re-published. */
  report(scopeId: number | null, message: string, tabId: string | null = null): boolean {
    const current = this.errors.get(scopeId);
    if (current?.message === message && current.tabId === tabId) return false;
    this.errors.set(scopeId, { message, tabId });
    return true;
  }

  /**
   * The user (or an agent) navigated a tab: drop its own error and any
   * scope-wide one, but never another tab's.
   */
  clearForNavigation(scopeId: number | null, tabId: string): void {
    const owner = this.errors.get(scopeId)?.tabId;
    if (owner === tabId || owner === null) this.errors.delete(scopeId);
  }

  /** The tab recovered or closed: its own error goes, scope-wide ones stay. */
  releaseTab(tabId: string): void {
    for (const [scopeId, error] of this.errors) {
      if (error.tabId === tabId) this.errors.delete(scopeId);
    }
  }

  /** Every tab of the scope is being closed. */
  clearScope(scopeId: number | null): void {
    this.errors.delete(scopeId);
  }
}
