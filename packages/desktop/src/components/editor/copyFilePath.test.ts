// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyFilePath } from "./copyFilePath";

const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const writeTextMock = vi.fn().mockResolvedValue(undefined);

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

beforeEach(() => {
  writeTextMock.mockClear();
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
  if (!navigator.clipboard) {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });
  } else {
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeTextMock);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("copyFilePath", () => {
  it("copies the project-relative path and toasts success", async () => {
    copyFilePath("packages/desktop/src/components/editor/FeatureEditorTab.tsx");
    await Promise.resolve();
    expect(writeTextMock).toHaveBeenCalledWith(
      "packages/desktop/src/components/editor/FeatureEditorTab.tsx",
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Path copied");
  });

  it("does nothing but errors when there is no active file", () => {
    copyFilePath(null);
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith("No file path to copy");
  });

  it("refuses to copy the sentinel path of an untitled buffer", () => {
    copyFilePath("untitled://a1b2c3");
    expect(writeTextMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith("No file path to copy");
  });
});
