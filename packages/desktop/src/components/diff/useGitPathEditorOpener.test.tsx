import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/test-utils";

const mocks = vi.hoisted(() => ({
  getGitPathPrefix: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/api/generated", () => ({
  getGetGitPathPrefixQueryOptions: (params: { feature_id: number }) => ({
    queryKey: ["/api/git/path-prefix", params],
    queryFn: () => mocks.getGitPathPrefix(params),
  }),
}));

import { useGitPathEditorOpener } from "./useGitPathEditorOpener";

function renderOpener(open: (path: string, line?: number, column?: number) => void) {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useGitPathEditorOpener(4, open), { wrapper }).result;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGitPathEditorOpener", () => {
  it("opens a monorepo Git path at its editor path", async () => {
    mocks.getGitPathPrefix.mockResolvedValue({ prefix: "packages/app" });
    const open = vi.fn();
    const opener = renderOpener(open);

    opener.current?.("packages/app/src/a.ts", 12, 3);

    await waitFor(() => expect(open).toHaveBeenCalledWith("src/a.ts", 12, 3));
    expect(mocks.getGitPathPrefix).toHaveBeenCalledWith({ feature_id: 4 });
  });

  it("keeps paths unchanged for a project at the repository root", async () => {
    mocks.getGitPathPrefix.mockResolvedValue({ prefix: "" });
    const open = vi.fn();
    renderOpener(open).current?.("src/a.ts");
    await waitFor(() => expect(open).toHaveBeenCalledWith("src/a.ts", undefined, undefined));
  });

  it("explains a file outside the project's folder instead of opening it", async () => {
    mocks.getGitPathPrefix.mockResolvedValue({ prefix: "packages/app" });
    const open = vi.fn();
    renderOpener(open).current?.("README.md");
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "README.md is outside this project's folder",
        expect.anything(),
      ),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("surfaces a failed prefix lookup", async () => {
    mocks.getGitPathPrefix.mockRejectedValue(new Error("no git root"));
    const open = vi.fn();
    renderOpener(open).current?.("src/a.ts");
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Could not open src/a.ts", {
        description: "no git root",
      }),
    );
    expect(open).not.toHaveBeenCalled();
  });
});
