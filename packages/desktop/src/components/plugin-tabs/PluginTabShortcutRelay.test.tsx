import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGlobalShortcutById, useShortcut } from "@/hooks/useShortcut";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { render, waitFor } from "@/test-utils";

import { createPluginTabsBridgeMock } from "./plugin-tab-fixtures";
import { PluginTabShortcutRelay } from "./PluginTabShortcutRelay";

let mock: ReturnType<typeof createPluginTabsBridgeMock>;

beforeEach(() => {
  mock = createPluginTabsBridgeMock();
  setDesktopBridgeOverrideForTests({ isElectron: true, pluginTabs: mock.bridge });
});

afterEach(() => {
  clearDesktopBridgeOverrideForTests();
});

const MOD = /mac/i.test(navigator.platform) ? { meta: true } : { control: true };

function key(letter: string, code: string, extra: object = {}) {
  return {
    key: letter,
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...MOD,
    ...extra,
  };
}

function Handlers({ palette, agent }: { palette: () => void; agent: () => void }) {
  useGlobalShortcutById("command-palette", palette);
  useShortcut("pane-agent", agent);
  return null;
}

describe("PluginTabShortcutRelay", () => {
  it("publishes Cadencr's shortcut keys, without ids or descriptions", async () => {
    render(<PluginTabShortcutRelay />);
    await waitFor(() => expect(mock.bridge.setAppShortcuts).toHaveBeenCalled());
    const bindings = mock.bridge.setAppShortcuts.mock.calls[0]?.[0] ?? [];
    expect(bindings).toContainEqual({ keys: ["mod", "k"] });
    const fields = new Set(bindings.flatMap((binding) => Object.keys(binding)));
    expect([...fields].every((field) => field === "keys" || field === "altKeys")).toBe(true);
  });

  it("runs a shortcut pressed in a focused tab through the usual handlers, on any layout", () => {
    const palette = vi.fn();
    const agent = vi.fn();
    render(
      <>
        <PluginTabShortcutRelay />
        <Handlers palette={palette} agent={agent} />
      </>,
    );
    act(() => mock.pressAppShortcut(key("k", "KeyK")));
    expect(palette).toHaveBeenCalledTimes(1);
    // AZERTY: the key labelled A is where QWERTY has Q.
    act(() => mock.pressAppShortcut(key("a", "KeyQ", { shift: true })));
    expect(agent).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside the desktop app", () => {
    setDesktopBridgeOverrideForTests({ isElectron: false, pluginTabs: mock.bridge });
    render(<PluginTabShortcutRelay />);
    expect(mock.bridge.setAppShortcuts).not.toHaveBeenCalled();
    expect(mock.bridge.onAppShortcut).not.toHaveBeenCalled();
  });
});
