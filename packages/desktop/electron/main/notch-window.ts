import { app, screen, type BrowserWindow } from "electron";
import {
  DEFAULT_NOTCH_PREFS,
  isNotchPreview,
  type NotchCapabilities,
  type NotchConfig,
  type NotchFeatureRef,
  type NotchHotRect,
  type NotchNotification,
  type NotchPrefs,
  type NotchReadyPayload,
  type NotchSnapshot,
  type NotchSnoozeMinutes,
} from "../../src/shared/notch";
import {
  probeHardwareNotches,
  resolveNotchPlacements,
  type NotchPlacement,
  type ProbedNotch,
} from "./notch-geometry";
import { NotchIslandWindow } from "./notch-island-window";
import { sendNotificationClick } from "./notifications";
import { sendToWindow } from "./safe-send";

export interface NotchControllerOptions {
  getMainWindow: () => BrowserWindow | null;
}

/** Relays shared agent state to identical islands on the user's selected displays. */
export class NotchController {
  private readonly islands = new Map<number, NotchIslandWindow>();
  private enabled = false;
  private snapshot: NotchSnapshot = { agents: [] };
  private pendingNotifications: NotchNotification[] = [];
  private prefs: NotchPrefs = DEFAULT_NOTCH_PREFS;
  /** Kept across window rebuilds; read against the wall clock, so it outlasts a sleep correctly. */
  private snoozedUntil: number | null = null;
  private probe: Promise<ProbedNotch[] | null> | null = null;
  private placing: Promise<void> | null = null;
  private readonly onDisplaysChanged = (): void => {
    this.probe = null;
    void this.place();
  };
  private readonly onDisplayMetricsChanged = (
    _event: Electron.Event,
    _display: Electron.Display,
    changed: string[],
  ): void => {
    if (changed.includes("bounds") || changed.includes("scaleFactor")) this.onDisplaysChanged();
  };

  constructor(private readonly options: NotchControllerOptions) {}

  /** Only currently owned island renderers may use the island IPC channels. */
  windowForSender(senderId: number): BrowserWindow | null {
    return this.islandForSender(senderId)?.window ?? null;
  }

  async capabilities(): Promise<NotchCapabilities> {
    if (process.platform !== "darwin") return { supported: false, hardware: false };
    const placements = await this.resolvePlacements("both");
    return { supported: true, hardware: placements.some((placement) => placement.hardware) };
  }

  async configure({ enabled, prefs }: NotchConfig): Promise<void> {
    if (process.platform !== "darwin") return;
    const displayChanged = this.prefs.displayMode !== prefs.displayMode;
    this.prefs = prefs;
    for (const island of this.islands.values()) island.updatePrefs(prefs);
    if (enabled === this.enabled) {
      if (enabled && displayChanged) await this.place();
      return;
    }
    await this.setEnabled(enabled);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (process.platform !== "darwin" || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.probe = null;
      screen.on("display-added", this.onDisplaysChanged);
      screen.on("display-removed", this.onDisplaysChanged);
      screen.on("display-metrics-changed", this.onDisplayMetricsChanged);
      try {
        await this.place();
      } catch (error) {
        // Stay off so the renderer's next configure retries from scratch.
        await this.setEnabled(false);
        throw error;
      }
      return;
    }
    screen.off("display-added", this.onDisplaysChanged);
    screen.off("display-removed", this.onDisplaysChanged);
    screen.off("display-metrics-changed", this.onDisplayMetricsChanged);
    for (const island of this.islands.values()) island.destroy();
    this.islands.clear();
    this.pendingNotifications = [];
  }

  pushSnapshot(snapshot: NotchSnapshot): void {
    this.snapshot = snapshot;
    for (const island of this.islands.values()) island.pushSnapshot(snapshot);
  }

  pushNotification(notification: NotchNotification): void {
    if (!this.enabled) return;
    if (this.isSnoozed() && !isNotchPreview(notification)) return;
    if (this.islands.size === 0) {
      this.pendingNotifications = [...this.pendingNotifications, notification].slice(-4);
      return;
    }
    for (const island of this.islands.values()) island.pushNotification(notification);
  }

  markReady(senderId: number): NotchReadyPayload {
    return this.requireIsland(senderId).markReady();
  }

  /** Mute every selected island together; the deadline survives display changes. */
  snooze(minutes: NotchSnoozeMinutes | null): void {
    this.snoozedUntil = minutes == null ? null : Date.now() + minutes * 60_000;
    if (minutes != null) {
      this.pendingNotifications = this.pendingNotifications.filter(isNotchPreview);
    }
    for (const island of this.islands.values()) island.updateSnooze(this.snoozedUntil);
  }

  /** Keep all islands closed until their own pointer regions are left. */
  collapse(): void {
    for (const island of this.islands.values()) island.collapse();
  }

  private isSnoozed(): boolean {
    return this.snoozedUntil != null && Date.now() < this.snoozedUntil;
  }

  setHotRect(senderId: number, rect: NotchHotRect): void {
    this.requireIsland(senderId).setHotRect(rect);
  }

  openFeature(ref: NotchFeatureRef): void {
    const main = this.options.getMainWindow();
    if (!main || main.isDestroyed()) throw new Error("The Cadencr window is not open.");
    if (main.isMinimized()) main.restore();
    main.show();
    app.focus({ steal: true });
    main.focus();
    sendNotificationClick(main, ref);
    this.collapse();
  }

  dismissFeature(ref: NotchFeatureRef): void {
    sendToWindow(this.options.getMainWindow(), "notch:dismissed", ref);
  }

  private islandForSender(senderId: number): NotchIslandWindow | undefined {
    return [...this.islands.values()].find(
      (island) => !island.window.isDestroyed() && island.window.webContents.id === senderId,
    );
  }

  private requireIsland(senderId: number): NotchIslandWindow {
    const island = this.islandForSender(senderId);
    if (!island) throw new Error("Rejected IPC call from an untrusted notch window.");
    return island;
  }

  private async resolvePlacements(mode = this.prefs.displayMode): Promise<NotchPlacement[]> {
    this.probe ??= probeHardwareNotches();
    const probed = await this.probe;
    return resolveNotchPlacements(
      screen.getAllDisplays(),
      screen.getPrimaryDisplay(),
      probed,
      mode,
    );
  }

  /** Serialize bursts of display/settings changes, removing only islands no longer selected. */
  private place(): Promise<void> {
    const run = async (): Promise<void> => {
      const placements = await this.resolvePlacements();
      if (!this.enabled) return;
      const selected = new Set(placements.map((placement) => placement.display.id));
      for (const [displayId, island] of this.islands) {
        if (selected.has(displayId)) continue;
        island.destroy();
        this.islands.delete(displayId);
      }
      for (const placement of placements) {
        const existing = this.islands.get(placement.display.id);
        if (existing && !existing.window.isDestroyed()) {
          existing.updatePlacement(placement);
        } else {
          this.islands.set(
            placement.display.id,
            new NotchIslandWindow(placement, {
              snapshot: this.snapshot,
              prefs: this.prefs,
              snoozedUntil: this.isSnoozed() ? this.snoozedUntil : null,
            }),
          );
        }
      }
      for (const notification of this.pendingNotifications) {
        for (const island of this.islands.values()) island.pushNotification(notification);
      }
      this.pendingNotifications = [];
    };
    const chained = (this.placing ?? Promise.resolve()).then(run, run);
    const tracked = chained.finally(() => {
      if (this.placing === tracked) this.placing = null;
    });
    this.placing = tracked;
    return tracked;
  }
}
