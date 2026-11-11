import type { PluginTabSummary } from "@/api/generated";
import type {
  PluginTabEvent,
  PluginTabKeyInput,
  PluginTabOwnShortcut,
  PluginTabShortcutBinding,
  PluginTabsBridge,
} from "@/shared/plugin-tab-host";
import { vi } from "vitest";

/** A valid, enabled, built custom tab; override what a test is about. */
export function pluginTabSummary(overrides: Partial<PluginTabSummary> = {}): PluginTabSummary {
  return {
    id: "graph",
    name: "Changed files graph",
    label: "Graph",
    version: "0.1.0",
    description: "Graph of the files this feature changed.",
    api_version: 1,
    entry: "dist/index.html",
    entry_present: true,
    icon_svg: null,
    dir: "/Users/me/.cadencr/plugins/tabs/graph",
    authoring_project_id: 3,
    permissions: ["git:read"],
    network: { allowed_origins: [], reasoning: null },
    configuration: [],
    commands: [],
    shortcuts: [],
    replaces: [],
    backend: null,
    access_level: "ui",
    permissions_hash: "abc",
    status: "valid",
    errors: [],
    warnings: [],
    enablement: { global: true, project: null, effective: true, consent_required: false },
    ...overrides,
  };
}

/** Switched off everywhere. */
export const OFF_ENABLEMENT: PluginTabSummary["enablement"] = {
  global: false,
  project: null,
  effective: false,
  consent_required: false,
};

/**
 * A native-code tab whose backend ships only for Linux, as the service lists
 * it on another platform.
 */
export function linuxOnlyBackendTab(overrides: Partial<PluginTabSummary> = {}): PluginTabSummary {
  return pluginTabSummary({
    backend: {
      binary: { "linux-x86_64": "bin/linux-x86_64/ports" },
      protocol: 1,
      reasoning: "Lists listening ports.",
    },
    backend_availability: "unavailable_on_platform",
    access_level: "backend",
    ...overrides,
  });
}

/** `desktopBridge.pluginTabs` with spies, plus a way to fire host events. */
export function createPluginTabsBridgeMock() {
  const listeners = new Set<(event: PluginTabEvent) => void>();
  const keyListeners = new Set<(input: PluginTabKeyInput) => void>();
  const bridge = {
    open: vi.fn(() => Promise.resolve()),
    setBounds: vi.fn(() => Promise.resolve()),
    setVisible: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    openDevTools: vi.fn(() => Promise.resolve()),
    focus: vi.fn(() => Promise.resolve()),
    setTheme: vi.fn(() => Promise.resolve()),
    setAppShortcuts: vi.fn((_bindings: readonly PluginTabShortcutBinding[]) => Promise.resolve()),
    setTabShortcuts: vi.fn((_instanceId: string, _shortcuts: readonly PluginTabOwnShortcut[]) =>
      Promise.resolve(),
    ),
    onEvent: vi.fn((listener: (event: PluginTabEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    onAppShortcut: vi.fn((listener: (input: PluginTabKeyInput) => void) => {
      keyListeners.add(listener);
      return () => keyListeners.delete(listener);
    }),
  } satisfies PluginTabsBridge;
  const emit = (event: PluginTabEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const pressAppShortcut = (input: PluginTabKeyInput): void => {
    for (const listener of keyListeners) listener(input);
  };
  return { bridge, emit, pressAppShortcut };
}
