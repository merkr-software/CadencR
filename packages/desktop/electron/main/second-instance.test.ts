import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, argv: string[]) => void>();
  return {
    listeners,
    app: {
      on: vi.fn((name: string, listener: (event: unknown, argv: string[]) => void) => {
        listeners.set(name, listener);
      }),
      focus: vi.fn(),
    },
  };
});
vi.mock("electron", () => ({ app: electron.app }));

import { registerSecondInstance } from "./second-instance";

function fakeWindow(): BrowserWindow {
  return {
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn(),
  } as unknown as BrowserWindow;
}

function launch(options: { main?: BrowserWindow | null; splash?: BrowserWindow | null } = {}) {
  const reopenWindow = vi.fn();
  const handleCliArgv = vi.fn(() => Promise.resolve(true));
  registerSecondInstance({
    getMainWindow: () => options.main ?? null,
    getSplashWindow: () => options.splash ?? null,
    reopenWindow,
    handleCliArgv,
  });
  electron.listeners.get("second-instance")?.({}, ["cadencr", "--cadencr-request={}"]);
  return { reopenWindow, handleCliArgv };
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.listeners.clear();
});

describe("registerSecondInstance", () => {
  it("focuses the open window and hands it the request", () => {
    const main = fakeWindow();
    const { reopenWindow, handleCliArgv } = launch({ main });
    expect(main.focus).toHaveBeenCalled();
    expect(reopenWindow).not.toHaveBeenCalled();
    expect(handleCliArgv).toHaveBeenCalledWith(["cadencr", "--cadencr-request={}"]);
  });

  it("focuses the splash while the app is still starting", () => {
    const splash = fakeWindow();
    const { reopenWindow } = launch({ splash });
    expect(splash.focus).toHaveBeenCalled();
    expect(reopenWindow).not.toHaveBeenCalled();
  });

  it("reopens a window when the app runs without one (macOS)", () => {
    const { reopenWindow, handleCliArgv } = launch();
    expect(reopenWindow).toHaveBeenCalledOnce();
    expect(handleCliArgv).toHaveBeenCalled();
  });
});
