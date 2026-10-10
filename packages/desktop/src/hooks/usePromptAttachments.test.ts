// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CadencrDesktopBridge } from "@/lib/desktop-bridge";
import { resetAttachmentDraftsForTest } from "@/lib/prompt-attachment-drafts";
import type { ImageAttachment } from "./useImageAttachments";
import { usePromptAttachments } from "./usePromptAttachments";

function attachment(id: string): ImageAttachment {
  return {
    id,
    fileName: `${id}.png`,
    base64: "AAAA",
    mimeType: "image/png",
    kind: "image",
    previewUrl: `blob:${id}`,
  };
}

function bridge(): CadencrDesktopBridge {
  return {
    isElectron: true,
    runtimeConfig: vi.fn(),
    readFileBase64: vi.fn(),
    onFileDrop: vi.fn(() => () => undefined),
    revealInFinder: vi.fn(),
    openExternal: vi.fn(),
    openExternalLink: vi.fn(),
    setLinkHoverContext: vi.fn(),
    onOpenLinkFromMenu: vi.fn(),
    pickDirectory: vi.fn(),
    pickImageFile: vi.fn(),
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
    setRemoteHostAwake: vi.fn(() => Promise.resolve()),
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
  afterEach(() => {
    clearDesktopBridgeOverrideForTests();
    resetAttachmentDraftsForTest();
  });

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

describe("usePromptAttachments draft persistence", () => {
  beforeEach(() => setDesktopBridgeOverrideForTests(bridge()));
  afterEach(() => {
    clearDesktopBridgeOverrideForTests();
    resetAttachmentDraftsForTest();
  });

  // The reported bug: attach an image, switch conversation, come back — the
  // image was gone and had to be attached again.
  it("restores a feature's unsent attachments after the prompt bar remounts", () => {
    const first = renderHook(() => usePromptAttachments({ featureId: 7 }));
    act(() => first.result.current.restoreAttachments([attachment("a")]));
    first.unmount();

    const second = renderHook(() => usePromptAttachments({ featureId: 7 }));

    expect(second.result.current.attachments).toEqual([attachment("a")]);
  });

  // The draft map is claimed on read, so a replayed setup finds it already
  // taken. Restoring unconditionally there would wipe the state the first setup
  // just populated — i.e. attachments would silently vanish in dev only.
  it("survives StrictMode's replayed effect without losing the draft", () => {
    const first = renderHook(() => usePromptAttachments({ featureId: 7 }), {
      wrapper: StrictMode,
    });
    act(() => first.result.current.restoreAttachments([attachment("a")]));
    first.unmount();

    const second = renderHook(() => usePromptAttachments({ featureId: 7 }), {
      wrapper: StrictMode,
    });

    expect(second.result.current.attachments).toEqual([attachment("a")]);
  });

  it("keeps each feature's attachments separate across a switch", () => {
    const view = renderHook(({ featureId }) => usePromptAttachments({ featureId }), {
      initialProps: { featureId: 7 },
    });
    act(() => view.result.current.restoreAttachments([attachment("a")]));

    // Switching to a feature with no draft must still clear the outgoing one —
    // skipping the commit for an empty draft would leave the previous
    // conversation's images sitting in this conversation's composer.
    view.rerender({ featureId: 9 });
    expect(view.result.current.attachments).toEqual([]);

    act(() => view.result.current.restoreAttachments([attachment("b")]));
    view.rerender({ featureId: 7 });
    expect(view.result.current.attachments).toEqual([attachment("a")]);

    view.rerender({ featureId: 9 });
    expect(view.result.current.attachments).toEqual([attachment("b")]);
  });

  // Scoping follows `usePromptDraft`, which is feature-scoped: a session-id
  // change (`/clear`, rewind, reconnect) must not orphan the draft.
  it("keeps the draft across a session-id change within one feature", () => {
    const view = renderHook(
      ({ wsSessionId }) => usePromptAttachments({ wsSessionId, featureId: 7 }),
      {
        initialProps: { wsSessionId: "ws-1" },
      },
    );
    act(() => view.result.current.restoreAttachments([attachment("a")]));

    view.rerender({ wsSessionId: "ws-2" });

    expect(view.result.current.attachments).toEqual([attachment("a")]);
  });

  it("drops the draft once the attachments are sent", () => {
    const first = renderHook(() => usePromptAttachments({ featureId: 7 }));
    act(() => first.result.current.restoreAttachments([attachment("a")]));
    act(() => first.result.current.clearAttachments({ revokeObjectUrls: false }));
    first.unmount();

    const second = renderHook(() => usePromptAttachments({ featureId: 7 }));

    expect(second.result.current.attachments).toEqual([]);
  });

  // Each draft can pin 10 files × 20 MB of base64 plus their preview blobs, so
  // the map is bounded; evicted previews are revoked because a stored draft is
  // by construction one no mounted prompt bar is showing.
  it("bounds the number of stored drafts and releases what it evicts", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    for (let featureId = 1; featureId <= 10; featureId += 1) {
      const view = renderHook(() => usePromptAttachments({ featureId }));
      act(() => view.result.current.restoreAttachments([attachment(`a${featureId}`)]));
      view.unmount();
    }

    // The two oldest were dropped, and their preview URLs released with them.
    expect(revoke).toHaveBeenCalledWith("blob:a1");
    expect(revoke).toHaveBeenCalledWith("blob:a2");
    const oldest = renderHook(() => usePromptAttachments({ featureId: 1 }));
    expect(oldest.result.current.attachments).toEqual([]);
    const newest = renderHook(() => usePromptAttachments({ featureId: 10 }));
    expect(newest.result.current.attachments).toEqual([attachment("a10")]);
    revoke.mockRestore();
  });

  it("scopes by drop target when no feature is known yet", () => {
    const first = renderHook(() => usePromptAttachments({ wsSessionId: "ws-1" }));
    act(() => first.result.current.restoreAttachments([attachment("a")]));
    first.unmount();

    const sameSession = renderHook(() => usePromptAttachments({ wsSessionId: "ws-1" }));
    expect(sameSession.result.current.attachments).toEqual([attachment("a")]);

    const otherSession = renderHook(() => usePromptAttachments({ wsSessionId: "ws-2" }));
    expect(otherSession.result.current.attachments).toEqual([]);
  });
});
