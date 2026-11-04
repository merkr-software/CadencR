import type { BrowserWindow } from "electron";

import {
  PLUGIN_TAB_APP_SHORTCUT_CHANNEL,
  PLUGIN_TAB_EVENT_CHANNEL,
  type PluginTabBounds,
  type PluginTabEvent,
  type PluginTabEventType,
  type PluginTabKeyInput,
  type PluginTabOwnShortcut,
  type PluginTabShortcutBinding,
  type PluginTabTheme,
  type PluginSurfaceDescriptor,
} from "../../../src/shared/plugin-tab-host";
import { rendererBoundsToWindow } from "../browser-manager-layout";
import { NativeViewAttachment } from "../browser-view-layout";
import { sendToWindow } from "../safe-send";
import type { PluginTabGuest, PluginTabGuestOptions } from "./plugin-tab-guest";
import { GUEST_THEME_CHANNEL } from "./plugin-tab-ids";
import { PluginTabPorts } from "./plugin-tab-ports";
import { PluginTabShortcuts } from "./plugin-tab-shortcuts";
import { PluginSurfaceWindowFocus } from "./plugin-surface-focus";

export const MAX_LIVE_PLUGIN_TAB_GUESTS = 6;
const NO_BOUNDS: PluginTabBounds = { x: 0, y: 0, width: 0, height: 0 };

interface PluginTabInstance {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly surface: PluginSurfaceDescriptor;
  focused: boolean;
  guest: PluginTabGuest | null;
  /** Set by a guest crash; only `reload` brings the instance back. */
  crashDetail: string | null;
  visible: boolean;
  /** Window DIP bounds of the renderer placeholder. */
  bounds: PluginTabBounds | null;
  /** Logical clock of the last time the instance was opened or shown (LRU key). */
  lastShown: number;
}

export interface PluginSurfaceManagerDeps {
  getMainWindow: () => BrowserWindow | null;
  createGuest: (options: PluginTabGuestOptions) => PluginTabGuest;
  defaultBackground: () => string;
  ports?: PluginTabPorts;
  shortcuts?: PluginTabShortcuts;
  maxLive?: number;
}

/**
 * Owns every custom-tab guest view (docs/CUSTOM_TABS.md §5): lifecycle, layout
 * over the renderer placeholder, suppression under React overlays, theme, the
 * per-load port bootstrap, focus hand-back and the live-guest cap.
 *
 * At most `maxLive` guests run at once; past that the least recently shown
 * *hidden* guest is destroyed (`recycled`) and transparently recreated the next
 * time it is opened or shown. Plugin `state` lives in the renderer broker, so
 * it survives recreation.
 */
export class PluginSurfaceManager {
  private readonly instances = new Map<string, PluginTabInstance>();
  private readonly views: NativeViewAttachment;
  private readonly ports: PluginTabPorts;
  private readonly shortcuts: PluginTabShortcuts;
  private readonly maxLive: number;
  private theme: PluginTabTheme | null = null;
  private clock = 0;
  private readonly windowFocus = new PluginSurfaceWindowFocus((active) => {
    for (const instance of this.instances.values()) {
      const wc = instance.guest?.webContents;
      this.focusChanged(instance, active && !!wc && !wc.isDestroyed() && wc.isFocused());
    }
  });

  constructor(private readonly deps: PluginSurfaceManagerDeps) {
    this.views = new NativeViewAttachment(deps.getMainWindow);
    this.ports = deps.ports ?? new PluginTabPorts();
    this.shortcuts = deps.shortcuts ?? new PluginTabShortcuts();
    this.maxLive = deps.maxLive ?? MAX_LIVE_PLUGIN_TAB_GUESTS;
  }

  open(
    instanceId: string,
    pluginId: string,
    surface: PluginSurfaceDescriptor = { kind: "tab" },
  ): void {
    const existing = this.instances.get(instanceId);
    if (existing && existing.surface.kind !== surface.kind)
      throw new Error("A surface identity cannot change kind");
    if (existing && existing.pluginId !== pluginId) this.close(instanceId);
    let instance = this.instances.get(instanceId);
    if (!instance) {
      instance = {
        instanceId,
        pluginId,
        surface,
        focused: false,
        guest: null,
        crashDetail: null,
        visible: false,
        bounds: null,
        lastShown: 0,
      };
      this.instances.set(instanceId, instance);
    }
    this.touch(instance);
    // A remounted tab must learn its guest is still down (it shows Reload).
    if (instance.crashDetail !== null) this.emit(instanceId, "crashed", instance.crashDetail);
    this.ensureLive(instance);
  }

  /** `bounds` are zoomed CSS px from the renderer; `zoomFactor` is its page zoom. */
  setBounds(instanceId: string, bounds: PluginTabBounds, zoomFactor?: number): void {
    // Layout sync may race a close; there is nothing left to place.
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    instance.bounds = rendererBoundsToWindow(this.deps.getMainWindow(), bounds, zoomFactor).bounds;
    this.place(instance);
  }

  setVisible(instanceId: string, visible: boolean): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    instance.visible = visible;
    if (visible) {
      this.touch(instance);
      this.ensureLive(instance);
    } else {
      this.focusChanged(instance, false);
      this.releaseFocus(instance.guest);
    }
    this.place(instance);
    if (!visible) this.enforceLimit();
  }

  reload(instanceId: string): void {
    const instance = this.require(instanceId);
    if (instance.guest) {
      instance.guest.webContents.reload();
      return;
    }
    instance.crashDetail = null;
    this.ensureLive(instance);
  }

  close(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    this.shortcuts.forget(instanceId);
    if (!instance) return;
    this.destroyGuest(instance);
    this.instances.delete(instanceId);
  }

  openDevTools(instanceId: string): void {
    this.requireGuest(this.require(instanceId)).webContents.openDevTools({ mode: "detach" });
  }

  focus(instanceId: string): void {
    const instance = this.require(instanceId);
    const guest = this.requireGuest(instance);
    if (instance.visible && this.views.isAttached(guest.view)) {
      guest.webContents.focus();
      this.focusChanged(instance, guest.webContents.isFocused());
    }
  }

  /** Detach every guest while a React overlay is open (see `NativeViewAttachment`). */
  setSuppressed(value: boolean): void {
    if (!this.views.setSuppressed(value)) return;
    for (const instance of this.instances.values()) {
      if (value) {
        this.focusChanged(instance, false);
        this.releaseFocus(instance.guest);
      }
      this.place(instance);
    }
  }

  setTheme(theme: PluginTabTheme): void {
    // The renderer re-pushes on every theme-store emit and placeholder mount;
    // an unchanged theme must not cost every guest an IPC and a full restyle.
    if (this.theme?.css === theme.css && this.theme.background === theme.background) return;
    this.theme = theme;
    for (const { guest } of this.instances.values()) {
      if (!guest || guest.webContents.isDestroyed()) continue;
      guest.view.setBackgroundColor(theme.background);
      guest.webContents.send(GUEST_THEME_CHANNEL, theme.css);
    }
  }

  /** CSS a guest preload injects before first paint. */
  themeCss(): string {
    return this.theme?.css ?? "";
  }

  isGuestWebContents(webContentsId: number): boolean {
    for (const { guest } of this.instances.values()) {
      if (guest && !guest.webContents.isDestroyed() && guest.webContents.id === webContentsId) {
        return true;
      }
    }
    return false;
  }

  /** Window closing or renderer reloading: no placeholder will ever claim these views. */
  destroyAll(): void {
    this.windowFocus.dispose();
    for (const instance of this.instances.values()) this.destroyGuest(instance);
    this.instances.clear();
    this.ports.releaseAll();
    this.views.detachAll();
    this.shortcuts.forgetAll();
  }

  private ensureLive(instance: PluginTabInstance): void {
    this.windowFocus.watch(this.liveWindow());
    if (instance.guest || instance.crashDetail !== null) return;
    this.spawn(instance);
    this.place(instance);
    // The guest just spawned is about to be shown (open → setVisible), so it
    // is never its own victim.
    this.enforceLimit(instance);
  }

  private spawn(instance: PluginTabInstance): void {
    let guest: PluginTabGuest | null = null;
    // Events of a destroyed or replaced guest must not touch the instance.
    const current = (): boolean =>
      guest !== null &&
      instance.guest === guest &&
      this.instances.get(instance.instanceId) === instance;
    guest = this.deps.createGuest({
      pluginId: instance.pluginId,
      background: this.theme?.background ?? this.deps.defaultBackground(),
      hooks: {
        loaded: () => {
          if (current() && guest) this.handleLoaded(instance, guest);
        },
        loadFailed: (detail) => {
          if (current()) this.emit(instance.instanceId, "load-failed", detail);
        },
        crashed: (detail) => {
          if (current()) this.handleCrash(instance, detail);
        },
        focusChanged: (focused) => {
          if (current()) this.focusChanged(instance, focused);
        },
        keyDown: (input) => current() && this.handleKey(instance, input),
      },
    });
    instance.guest = guest;
  }

  setAppShortcuts(bindings: readonly PluginTabShortcutBinding[]): void {
    this.shortcuts.setApp(bindings);
  }

  /** Kept across guest recreation; dropped when the instance closes. */
  setTabShortcuts(instanceId: string, shortcuts: readonly PluginTabOwnShortcut[]): void {
    this.shortcuts.setOwn(instanceId, shortcuts);
  }

  /**
   * Cadencr's shortcuts go to the renderer, which runs them as if pressed
   * there — OS focus comes back to it first, as most of them act outside
   * the tab; the tab's own go to its page as a `shortcut` event.
   */
  private handleKey(instance: PluginTabInstance, input: PluginTabKeyInput): boolean {
    const match = this.shortcuts.match(instance.instanceId, input, instance.surface.kind);
    if (!match) return false;
    if (match.kind === "tab") {
      this.emit(instance.instanceId, "shortcut", match.id);
      return true;
    }
    const win = this.liveWindow();
    win?.webContents.focus();
    sendToWindow(win, PLUGIN_TAB_APP_SHORTCUT_CHANNEL, input);
    return true;
  }

  private handleLoaded(instance: PluginTabInstance, guest: PluginTabGuest): void {
    const win = this.liveWindow();
    this.ports.bootstrap(instance.instanceId, guest.webContents, win?.webContents ?? null);
    this.emit(instance.instanceId, "loaded");
  }

  private handleCrash(instance: PluginTabInstance, detail: string): void {
    this.destroyGuest(instance);
    instance.crashDetail = detail;
    this.emit(instance.instanceId, "crashed", detail);
  }

  private enforceLimit(spared?: PluginTabInstance): void {
    const live = [...this.instances.values()].filter((instance) => instance.guest);
    const excess = live.length - this.maxLive;
    if (excess <= 0) return;
    const victims = live
      .filter((instance) => !instance.visible && instance !== spared)
      .sort((a, b) => a.lastShown - b.lastShown)
      .slice(0, excess);
    for (const victim of victims) {
      this.destroyGuest(victim);
      this.emit(victim.instanceId, "recycled");
    }
  }

  private destroyGuest(instance: PluginTabInstance): void {
    const guest = instance.guest;
    if (!guest) return;
    this.focusChanged(instance, false);
    instance.guest = null;
    this.ports.release(instance.instanceId);
    this.releaseFocus(guest);
    this.views.detach(guest.view);
    guest.destroy();
  }

  /**
   * Only the shown guest sits in the window's view tree: hidden ones are fully
   * detached (like a backgrounded Browser scope), so they leave the hit-test
   * chain and un-suppressing re-adds just the one on screen.
   */
  private place(instance: PluginTabInstance): void {
    const { guest, bounds } = instance;
    if (!guest) return;
    const placed = !!bounds && bounds.width > 0 && bounds.height > 0;
    this.views.layoutView(
      guest.view,
      placed && instance.visible,
      instance.visible,
      bounds ?? NO_BOUNDS,
    );
  }

  /**
   * A DOM `.focus()` in the renderer never takes OS focus back from a native
   * view, so hiding a focused guest would leave keystrokes on a dead responder
   * (macOS beeps). Only the main process can hand focus back.
   */
  private releaseFocus(guest: PluginTabGuest | null): void {
    if (!guest || guest.webContents.isDestroyed() || !guest.webContents.isFocused()) return;
    this.liveWindow()?.webContents.focus();
  }

  private focusChanged(instance: PluginTabInstance, focused: boolean): void {
    const active =
      focused && instance.visible && !!instance.guest && this.views.isAttached(instance.guest.view);
    if (instance.focused === active) return;
    instance.focused = active;
    this.emit(instance.instanceId, active ? "focused" : "blurred");
  }

  private touch(instance: PluginTabInstance): void {
    this.clock += 1;
    instance.lastShown = this.clock;
  }

  private emit(instanceId: string, type: PluginTabEventType, detail?: string): void {
    const event: PluginTabEvent =
      detail === undefined ? { instanceId, type } : { instanceId, type, detail };
    sendToWindow(this.liveWindow(), PLUGIN_TAB_EVENT_CHANNEL, event);
  }

  private liveWindow(): BrowserWindow | null {
    const win = this.deps.getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  }

  private require(instanceId: string): PluginTabInstance {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Unknown custom tab instance: ${instanceId}`);
    return instance;
  }

  private requireGuest(instance: PluginTabInstance): PluginTabGuest {
    if (!instance.guest) throw new Error("This custom tab is not running; reload it first.");
    return instance.guest;
  }
}
