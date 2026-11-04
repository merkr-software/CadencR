/**
 * Contract between the Electron host of custom (plugin) tabs and the renderer
 * broker — see docs/CUSTOM_TABS.md §5 and §7. Shared by the main process, the
 * main-window preload and the renderer; the guest preload
 * (`electron/preload/plugin-tab.ts`) repeats its three channel names as
 * literals (see `electron/main/plugin-tabs/plugin-tab-ids.ts`) because a
 * sandboxed preload cannot import a shared chunk.
 */

import type { BrowserBounds, BrowserShortcutBinding } from "./browser-types";

/** Manifest id rule (§3): a URL host label, `cadencr-tab://<id>/`. */
export const PLUGIN_TAB_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Opaque renderer-chosen instance id (e.g. `<featureId>:plugin:<id>`). */
export const PLUGIN_TAB_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

/** Upper bound for theme CSS pushed into every guest. */
export const MAX_PLUGIN_TAB_THEME_CSS_LENGTH = 256 * 1024;

/** Main → main-window preload: the broker's end of a port, with `{ instanceId }`. */
export const PLUGIN_TAB_RENDERER_PORT_CHANNEL = "plugin-tab:port";
/** Main → renderer lifecycle events (`PluginTabEvent`). */
export const PLUGIN_TAB_EVENT_CHANNEL = "plugin-tab:event";
/** Main → renderer: a Cadencr shortcut pressed in a focused guest (`PluginTabKeyInput`). */
export const PLUGIN_TAB_APP_SHORTCUT_CHANNEL = "plugin-tab:app-shortcut";

/**
 * `window.postMessage` type the main-window preload uses to hand the renderer
 * its end of an instance's `MessageChannel`. The renderer listens with
 * `window.addEventListener("message", …)`, accepts only `event.source ===
 * window` and `event.data.type === PLUGIN_TAB_PORT_MESSAGE_TYPE`, and takes
 * `event.ports[0]`. A new message for the same `instanceId` (guest reload or
 * recreation) replaces the previous port.
 */
export const PLUGIN_TAB_PORT_MESSAGE_TYPE = "cadencr-plugin-tab:port";

export interface PluginTabPortMessage {
  type: typeof PLUGIN_TAB_PORT_MESSAGE_TYPE;
  instanceId: string;
}

/**
 * Lifecycle of one guest view.
 * - `loaded`: the document finished loading; a fresh port follows.
 * - `load-failed`: the entry failed (network error or HTTP ≥ 400); `detail` says why.
 * - `crashed`: the guest process died; the view is gone until `reload`.
 * - `recycled`: destroyed to stay under the live-guest cap; it is recreated
 *   transparently on the next `open` / `setVisible(true)`.
 * - `shortcut`: one of the tab's own shortcuts was pressed while it had
 *   focus; `detail` is its id. The page is unaffected.
 */
export type PluginTabEventType =
  | "loaded"
  | "load-failed"
  | "crashed"
  | "recycled"
  | "shortcut"
  | "focused"
  | "blurred";

export interface PluginSurfaceDescriptor {
  kind: "tab" | "editor";
}

export interface PluginTabEvent {
  instanceId: string;
  type: PluginTabEventType;
  detail?: string;
}

/** Placeholder rect; the main process feeds it straight to the Browser view helpers. */
export type PluginTabBounds = BrowserBounds;

/** Theme pushed to every guest: CSS injected before first paint + view background. */
export interface PluginTabTheme {
  css: string;
  /** Any Electron-accepted color (`#rgb`, `#rrggbb`, `#aarrggbb`, `rgb()`, `hsl()`, named). */
  background: string;
}

/** A chord in shortcut tokens (`["mod", "shift", "k"]`), with an optional alternate. */
export type PluginTabShortcutBinding = BrowserShortcutBinding;

/** One of a tab's own `tab.json` shortcuts, delivered to its page as a `shortcut` event. */
export interface PluginTabOwnShortcut {
  id: string;
  keys: string[];
}

/** A key pressed in a guest, as Electron reports it (`Input`). */
export interface PluginTabKeyInput {
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

/** `desktopBridge.pluginTabs` — native guest views for custom tabs (desktop only). */
export interface PluginTabsBridge {
  /** Create (or recreate) the guest for `instanceId`; idempotent for the same plugin. */
  open: (instanceId: string, pluginId: string, surface?: PluginSurfaceDescriptor) => Promise<void>;
  /** Placeholder rect from `getBoundingClientRect` (zoomed CSS px). */
  setBounds: (instanceId: string, bounds: PluginTabBounds) => Promise<void>;
  setVisible: (instanceId: string, visible: boolean) => Promise<void>;
  /** Reload the guest; recreates a crashed or recycled one. */
  reload: (instanceId: string) => Promise<void>;
  close: (instanceId: string) => Promise<void>;
  openDevTools: (instanceId: string) => Promise<void>;
  /** Give the guest OS keyboard focus (e.g. when its tab is activated by click). */
  focus: (instanceId: string) => Promise<void>;
  setTheme: (theme: PluginTabTheme) => Promise<void>;
  /**
   * Cadencr's shortcuts as currently bound (`lib/plugin-tabs/tab-shortcuts.ts`):
   * taken from any focused guest and replayed in the renderer.
   */
  setAppShortcuts: (bindings: readonly PluginTabShortcutBinding[]) => Promise<void>;
  /** The instance's own active shortcuts (none collides with Cadencr's). */
  setTabShortcuts: (
    instanceId: string,
    shortcuts: readonly PluginTabOwnShortcut[],
  ) => Promise<void>;
  onEvent: (cb: (event: PluginTabEvent) => void) => () => void;
  /** A Cadencr shortcut pressed in a focused guest, for the renderer to run. */
  onAppShortcut: (cb: (input: PluginTabKeyInput) => void) => () => void;
}
