// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLsp } from "./useLsp";
import { useLspResolution } from "./useLspResolution";

const mocks = vi.hoisted(() => ({ refetch: vi.fn(), reconnect: vi.fn() }));
vi.mock("./useLspResolution", () => ({ useLspResolution: vi.fn() }));
vi.mock("./useLspClients", () => ({
  useLspClients: () => ({ clients: [], status: "unsupported", onRetry: mocks.reconnect }),
}));

const args = {
  workspaceRoot: "/workspace",
  filePath: "demo.exotic",
  projectId: 3,
  featureId: 1,
  paneId: "root",
  editorLanguageId: "plaintext" as const,
};
const resolution = {
  language_id: "exotic",
  servers: [],
  candidates: [],
  primary: null,
  linters: [],
  primary_disabled: false,
  ignored: false,
  suggestions: [],
  error: null,
};

describe("editor LSP resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useLspResolution).mockReturnValue({
      data: resolution,
      refetch: mocks.refetch,
      isPending: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useLspResolution>);
  });

  it("resolves automatic plain text by filename independently from syntax grammars", () => {
    const { result } = renderHook(() => useLsp(args));
    expect(useLspResolution).toHaveBeenCalledWith(
      { language_id: undefined, file_path: "demo.exotic", project_id: 3 },
      true,
    );
    expect(result.current.languageId).toBe("exotic");
  });

  it("disables resolution and suggestions for an explicit Plain Text override", () => {
    const { result } = renderHook(() => useLsp({ ...args, explicitPlainText: true }));
    expect(useLspResolution).toHaveBeenCalledWith(expect.any(Object), false);
    expect(result.current.languageId).toBeNull();
    expect(result.current.resolution).toBeUndefined();
  });

  it("retries resolution after an HTTP failure as well as reconnecting clients", () => {
    vi.mocked(useLspResolution).mockReturnValue({
      data: undefined,
      refetch: mocks.refetch,
      isPending: false,
      isError: true,
      error: new Error("Catalog unavailable"),
    } as unknown as ReturnType<typeof useLspResolution>);
    const { result } = renderHook(() => useLsp(args));
    expect(result.current.status).toBe("error");
    act(() => result.current.onRetry());
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.reconnect).toHaveBeenCalledOnce();
  });
});
