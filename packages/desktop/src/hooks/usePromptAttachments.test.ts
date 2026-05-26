import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CadencrDesktopBridge } from "@/lib/desktop-bridge";
import { usePromptAttachments } from "./usePromptAttachments";

function bridge(): CadencrDesktopBridge {
  return {
    isElectron: true,
    runtimeConfig: vi.fn(),
    readFileBase64: vi.fn(),
    onFileDrop: vi.fn(() => () => undefined),
    revealInFinder: vi.fn(),
    openExternal: vi.fn(),
    pickDirectory: vi.fn(),
    showSaveDialog: vi.fn(),
    notifyPermission: vi.fn(),
    notify: vi.fn(),
    notifyTest: vi.fn(),
    onNotificationClicked: vi.fn(() => () => undefined),
    onNotificationFailed: vi.fn(() => () => undefined),
    onNotificationFallback: vi.fn(() => () => undefined),
    onCloseRequested: vi.fn(() => () => undefined),
    confirmClose: vi.fn(),
    requestQuit: vi.fn(),
    setZoom: vi.fn(),
    currentTheme: vi.fn(),
    onThemeChange: vi.fn(() => () => undefined),
    setBusy: vi.fn(() => Promise.resolve()),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    fetchChangelog: vi.fn(() => Promise.resolve(null)),
    installUpdate: vi.fn(() => Promise.resolve()),
    onUpdateEvent: vi.fn(() => () => undefined),
  };
}

describe("usePromptAttachments", () => {
  beforeEach(() => {
    // Wire a no-op bridge so the underlying `useImageAttachments` effect
    // can subscribe without throwing in the test environment.
    setDesktopBridgeOverrideForTests(bridge());
  });
  afterEach(() => clearDesktopBridgeOverrideForTests());

  it("derives the prompt drop target id from wsSessionId first", () => {
    const { result } = renderHook(() =>
      usePromptAttachments({ wsSessionId: "feature-7", sessionId: 5, featureId: 9 }),
    );
    expect(result.current.promptDropTargetId).toBe("ws:feature-7");
  });

  it("falls back to dbSessionId, then featureId, then a stable unknown id", () => {
    const { result: db } = renderHook(() => usePromptAttachments({ sessionId: 42, featureId: 9 }));
    expect(db.current.promptDropTargetId).toBe("db:42");

    const { result: feat } = renderHook(() => usePromptAttachments({ featureId: 9 }));
    expect(feat.current.promptDropTargetId).toBe("feature:9");

    const { result: none } = renderHook(() => usePromptAttachments({}));
    expect(none.current.promptDropTargetId).toBe("prompt:unknown");
  });

  it("exposes the underlying useImageAttachments API", () => {
    const { result } = renderHook(() => usePromptAttachments({ wsSessionId: "feature-1" }));
    expect(result.current.attachments).toEqual([]);
    expect(typeof result.current.addFiles).toBe("function");
    expect(typeof result.current.removeAttachment).toBe("function");
    expect(typeof result.current.clearAttachments).toBe("function");
    expect(typeof result.current.restoreAttachments).toBe("function");
    expect(result.current.dragHandlers).toEqual({
      onDragOver: expect.any(Function),
      onDrop: expect.any(Function),
    });
  });
});
