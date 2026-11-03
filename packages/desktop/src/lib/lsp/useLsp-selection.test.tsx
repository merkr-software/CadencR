// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
import { LSPClient } from "@codemirror/lsp-client";
import { expect, it, vi } from "vitest";
import { useLsp } from "./useLsp";
import { useLspResolution, type LspResolution } from "./useLspResolution";
import { CadencrWorkspace } from "./cadencr-workspace";
import { acquireLspClient, releaseLspClient } from "./client-manager";

vi.mock("./useLspResolution", () => ({ useLspResolution: vi.fn() }));
vi.mock("./client-manager", () => ({
  acquireLspClient: vi.fn(),
  releaseLspClient: vi.fn(),
  retryLspClient: vi.fn(),
  getLspStatus: vi.fn(() => ({ status: "ready", errorMessage: null })),
  getLspClient: vi.fn(),
  subscribeLspStatus: vi.fn(() => vi.fn()),
}));
vi.mock("./resolve-root", () => ({ resolveLspRoot: vi.fn(async () => "/workspace") }));

function resolution(ids: string[], warning: string | null = null): LspResolution {
  const servers = ids.map((lsp_id) => ({
    lsp_id,
    name: lsp_id,
    description: "",
    language_ids: ["custom"],
    languages: [],
    role: "general" as const,
    status: "managed" as const,
  }));
  return {
    language_id: "custom",
    servers,
    candidates: servers,
    primary: ids[0] ?? null,
    linters: ids.slice(1),
    primary_disabled: false,
    ignored: false,
    suggestions: [],
    error: null,
    catalog_warning: warning,
  };
}
function mockResolution(data: LspResolution) {
  vi.mocked(useLspResolution).mockReturnValue({
    data,
    refetch: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useLspResolution>);
}

it("keeps clients and extensions mounted when only resolution metadata changes", async () => {
  const client = new LSPClient();
  vi.mocked(acquireLspClient).mockResolvedValue({
    client,
    workspace: new CadencrWorkspace(client),
  });
  mockResolution(resolution(["primary", "linter"]));
  const { result, rerender, unmount } = renderHook(() =>
    useLsp({
      workspaceRoot: "/workspace",
      filePath: "file.custom",
      projectId: 3,
      featureId: 1,
      paneId: "root",
      editorLanguageId: "plaintext",
    }),
  );
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(acquireLspClient).toHaveBeenCalledTimes(2);
  const extension = result.current.extension;

  mockResolution({
    ...resolution(["primary", "linter"], "Catalog temporarily unavailable"),
    suggestions: [{ lsp_id: "alternative", version: "1.0.0", reason: "compatible" }],
  });
  rerender();
  expect(acquireLspClient).toHaveBeenCalledTimes(2);
  expect(releaseLspClient).not.toHaveBeenCalled();
  expect(result.current.extension).toBe(extension);

  mockResolution(resolution(["linter", "primary"]));
  rerender();
  await waitFor(() => expect(acquireLspClient).toHaveBeenCalledTimes(4));
  expect(releaseLspClient).toHaveBeenCalledTimes(2);
  mockResolution(resolution(["replacement"]));
  rerender();
  await waitFor(() => expect(acquireLspClient).toHaveBeenCalledTimes(5));
  expect(releaseLspClient).toHaveBeenCalledTimes(4);
  unmount();
});
