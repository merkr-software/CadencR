import type { BrowserWindow } from "electron";
import { relayGuestShortcut } from "./browser-manager-utils";
import { tabCountRecordsEqual } from "./browser-manager-tabs";
import type { BrowserScopeState } from "./browser-scope-state";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserTabWorkspaceController } from "./browser-tab-workspace-controller";
import type {
  BrowserAutomationState,
  BrowserShortcut,
  BrowserStateSnapshot,
} from "./browser-types";
import { sendToWindow } from "./safe-send";

/** Builds and publishes authoritative snapshots without renderer-side reconstruction. */
export class BrowserManagerState {
  private lastCounts: Record<number, number> = {};

  constructor(
    private readonly tabs: Map<string, ManagedTab>,
    private readonly scopes: BrowserScopeState,
    private readonly workspace: BrowserTabWorkspaceController,
    private readonly getError: () => string | null,
    private readonly getWindow: () => BrowserWindow | null,
  ) {}

  snapshot(scopeId?: number | null): BrowserStateSnapshot {
    return this.scopes.snapshot(
      scopeId,
      this.tabs,
      this.getError(),
      this.workspace.metadata(scopeId, this.tabs, this.scopes.activeTabId(scopeId)),
    );
  }

  /** Read on demand by automation: never broadcast to the renderer. */
  automationSnapshot(scopeId?: number | null): BrowserAutomationState {
    return this.scopes.withActiveTabLogs(this.snapshot(scopeId), this.tabs);
  }

  /** Tabs, active tab and error only: console lines and requests never trigger one. */
  emit(scopeId: number | null): void {
    if (scopeId === null) return;
    sendToWindow(this.getWindow(), "browser:state", this.snapshot(scopeId));
  }

  emitCounts(): void {
    const counts = this.workspace.countByScope(this.tabs);
    if (tabCountRecordsEqual(this.lastCounts, counts)) return;
    this.lastCounts = counts;
    sendToWindow(this.getWindow(), "browser:tab-counts", counts);
  }

  emitShortcut(shortcut: BrowserShortcut): void {
    relayGuestShortcut(this.getWindow(), shortcut);
  }
}
