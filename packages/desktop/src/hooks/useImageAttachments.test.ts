import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CadencrDesktopBridge, FileDropPayload } from "@/lib/desktop-bridge";
import { useImageAttachments } from "./useImageAttachments";
import { toast } from "sonner";

const dropSubscribers: Array<(payload: FileDropPayload) => void> = [];
const mockOnFileDrop = vi.fn((cb: (payload: FileDropPayload) => void) => {
  dropSubscribers.push(cb);
  return () => undefined;
});

function bridge(): CadencrDesktopBridge {
  return {
    isElectron: true,
    runtimeConfig: vi.fn(),
    readFileBase64: vi.fn(),
    onFileDrop: mockOnFileDrop,
    revealInFinder: vi.fn(),
    openExternal: vi.fn(),
    openExternalLink: vi.fn(),
    setLinkHoverContext: vi.fn(),
    onOpenLinkFromMenu: vi.fn(),
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
    setRemoteHostAwake: vi.fn(() => Promise.resolve()),
    onPowerSuspend: vi.fn(() => () => undefined),
    onPowerResume: vi.fn(() => () => undefined),
    checkForUpdates: vi.fn(() => Promise.resolve()),
    fetchChangelog: vi.fn(() => Promise.resolve(null)),
    installUpdate: vi.fn(() => Promise.resolve()),
    onUpdateEvent: vi.fn(() => () => undefined),
  };
}

// Helper to create a mock File that triggers FileReader.load
function createMockFile(name: string, type: string, size = 100): File {
  const blob = new Blob(["x".repeat(size)], { type });
  return new File([blob], name, { type });
}

describe("useImageAttachments", () => {
  const readFileBase64 = vi.fn(async () => "abc123");
  beforeEach(() => {
    mockOnFileDrop.mockClear();
    dropSubscribers.length = 0;
    readFileBase64.mockReset();
    readFileBase64.mockResolvedValue("abc123");
    setDesktopBridgeOverrideForTests({ ...bridge(), readFileBase64 });
    vi.mocked(toast.error).mockReset?.();
    vi.spyOn(toast, "error").mockImplementation(() => "" as never);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    vi.stubGlobal(
      "FileReader",
      class {
        addEventListener(event: string, cb: (e: { target: { result: string } }) => void) {
          if (event === "load") {
            setTimeout(() => cb({ target: { result: "data:image/png;base64,abc123" } }), 0);
          }
        }
        readAsDataURL() {}
      },
    );

    let counter = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      () => `mock-uuid-${++counter}` as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  it("starts with empty attachments", () => {
    const { result } = renderHook(() => useImageAttachments());
    expect(result.current.attachments).toEqual([]);
    expect(result.current.isDragging).toBe(false);
  });

  it("adds a valid image file", async () => {
    const { result } = renderHook(() => useImageAttachments());
    const file = createMockFile("test.png", "image/png");

    act(() => {
      result.current.addFiles([file]);
    });

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(1);
    });

    expect(result.current.attachments[0].mimeType).toBe("image/png");
    expect(result.current.attachments[0].base64).toBe("abc123");
  });

  it("accepts provider-compatible PDFs for Claude", async () => {
    const { result } = renderHook(() => useImageAttachments(undefined, "claude_code"));
    const file = createMockFile("doc.pdf", "application/pdf");

    act(() => {
      result.current.addFiles([file]);
    });

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(1);
    });

    expect(result.current.attachments[0]).toEqual(
      expect.objectContaining({
        fileName: "doc.pdf",
        kind: "document",
        mimeType: "application/pdf",
      }),
    );
  });

  it("accepts PDFs for Codex as app-server document file references", async () => {
    const { result } = renderHook(() => useImageAttachments(undefined, "codex_cli"));
    const file = createMockFile("doc.pdf", "application/pdf");

    act(() => {
      result.current.addFiles([file]);
    });

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(1);
    });
    expect(result.current.attachments[0]).toEqual(
      expect.objectContaining({
        fileName: "doc.pdf",
        kind: "document",
        mimeType: "application/pdf",
      }),
    );
  });

  it("accepts OpenCode audio drops as ACP audio attachments", async () => {
    const { result } = renderHook(() => useImageAttachments("ws:first", "opencode"));
    const callback = dropSubscribers[0];

    act(() => {
      callback({
        type: "drop",
        files: [{ handle: "h-1", name: "clip.wav" }],
        targetPromptId: "ws:first",
      });
    });

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(1);
    });

    expect(result.current.attachments[0]).toEqual(
      expect.objectContaining({ fileName: "clip.wav", kind: "audio", mimeType: "audio/wav" }),
    );
  });

  it("removes an attachment by id", async () => {
    const { result } = renderHook(() => useImageAttachments());
    const file = createMockFile("test.png", "image/png");

    act(() => {
      result.current.addFiles([file]);
    });

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(1);
    });

    const id = result.current.attachments[0].id;
    act(() => {
      result.current.removeAttachment(id);
    });

    expect(result.current.attachments).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("clears all attachments", async () => {
    const { result } = renderHook(() => useImageAttachments());
    const files = [createMockFile("a.png", "image/png"), createMockFile("b.jpg", "image/jpeg")];

    act(() => {
      result.current.addFiles(files);
    });

    await waitFor(() => {
      expect(result.current.attachments).toHaveLength(2);
    });

    act(() => {
      result.current.clearAttachments();
    });

    expect(result.current.attachments).toHaveLength(0);
  });

  it("registers desktop file-drop listener on mount", () => {
    renderHook(() => useImageAttachments());
    expect(mockOnFileDrop).toHaveBeenCalled();
  });

  it("routes a desktop drop to only the matching prompt id", async () => {
    const { result: first } = renderHook(() => useImageAttachments("ws:first"));
    const { result: second } = renderHook(() => useImageAttachments("ws:second"));

    const firstCallback = dropSubscribers[0];
    const secondCallback = dropSubscribers[1];

    const payload = {
      type: "drop" as const,
      files: [{ handle: "h-1", name: "one.png" }],
      targetPromptId: "ws:first",
    };

    act(() => {
      firstCallback(payload);
      secondCallback(payload);
    });

    await waitFor(() => {
      expect(first.current.attachments).toHaveLength(1);
    });

    expect(second.current.attachments).toHaveLength(0);
  });

  it("ignores ambiguous desktop drops without a prompt target", async () => {
    const { result } = renderHook(() => useImageAttachments("ws:first"));
    const callback = dropSubscribers[0];

    act(() => {
      callback({ type: "drop", files: [{ handle: "h-1", name: "one.png" }] });
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.attachments).toHaveLength(0);
  });

  it("dedupes the missing-target toast across mounted hooks", () => {
    renderHook(() => useImageAttachments("ws:first"));
    renderHook(() => useImageAttachments("ws:second"));

    const payload = { type: "drop" as const, files: [{ handle: "h-1", name: "one.png" }] };
    act(() => {
      dropSubscribers[0](payload);
      dropSubscribers[1](payload);
    });

    // Each subscriber still calls toast.error, but it must share a stable id so
    // sonner collapses them to a single visible toast — assert the id is set.
    expect(toast.error).toHaveBeenCalledWith(
      "Drop the image on an agent to attach it.",
      expect.objectContaining({ id: "image-drop-missing-target" }),
    );
  });

  it("does not toast for empty drops (e.g. text drags)", () => {
    renderHook(() => useImageAttachments("ws:first"));

    act(() => {
      dropSubscribers[0]({ type: "drop", files: [] });
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  afterEach(() => clearDesktopBridgeOverrideForTests());
});
