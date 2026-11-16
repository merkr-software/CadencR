// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const setTheme = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/desktop-bridge", () => ({ desktopBridge: { pluginTabs: { setTheme } } }));
vi.mock("./theme-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./theme-snapshot")>()),
  // The canvas compositing needs a real 2D context.
  opaqueBackground: () => "#101010",
}));

import {
  currentPluginTabTheme,
  ensurePluginTabThemeSync,
  subscribePluginTabTheme,
} from "./theme-sync";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plugin tab theme sync", () => {
  it("pushes the theme at once and on every change, without animation frames", async () => {
    // A hidden window never runs requestAnimationFrame: the sync must not need it.
    const frame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", frame);
    document.documentElement.dataset.theme = "cadencr-dark";
    ensurePluginTabThemeSync();
    expect(setTheme).toHaveBeenCalledTimes(1);
    expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({ background: "#101010" }));
    expect(currentPluginTabTheme().id).toBe("cadencr-dark");

    const listener = vi.fn();
    const unsubscribe = subscribePluginTabTheme(listener);
    document.documentElement.dataset.theme = "cadencr-light";
    await vi.waitFor(() => expect(setTheme).toHaveBeenCalledTimes(2));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: "cadencr-light" }));
    expect(frame).not.toHaveBeenCalled();

    // A mutation that leaves the snapshot unchanged pushes nothing.
    document.head.append(document.createElement("meta"));
    document.documentElement.dataset.theme = "cadencr-light";
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setTheme).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
