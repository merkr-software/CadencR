// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { LSPClient } from "@codemirror/lsp-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CadencrWorkspace } from "./cadencr-workspace";
import { useLspClients } from "./useLspClients";
import { acquireLspClient, releaseLspClient, retryLspClient } from "./client-manager";

vi.mock("./client-manager", () => ({
  acquireLspClient: vi.fn(),
  releaseLspClient: vi.fn(),
  retryLspClient: vi.fn(),
  getLspStatus: vi.fn(() => ({ status: "ready", errorMessage: null })),
  getLspClient: vi.fn(),
  subscribeLspStatus: vi.fn(() => vi.fn()),
}));
vi.mock("./resolve-root", () => ({ resolveLspRoot: vi.fn(async () => "/workspace") }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function session() {
  const client = new LSPClient();
  return { client, workspace: new CadencrWorkspace(client) };
}

describe("LSP initial connection retry", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, true])(
    "retries an initial failure with another ready server: %s",
    async (withLinter) => {
      const typeChecker = session();
      const linter = session();
      let rejectTypeChecker = true;
      vi.mocked(acquireLspClient).mockImplementation(async (_root, id) => {
        if (id === "checker" && rejectTypeChecker) throw new Error("Initialization rejected");
        return id === "checker" ? typeChecker : linter;
      });
      const lspIds = withLinter ? ["checker", "linter"] : ["checker"];
      const { result, unmount } = renderHook(() =>
        useLspClients({
          workspaceRoot: "/workspace",
          absPath: "/workspace/example.ts",
          languageId: "typescript",
          lspIds,
        }),
      );
      await waitFor(() => expect(result.current.status).toBe("error"));
      expect(result.current.errorMessage).toBe("Initialization rejected");

      rejectTypeChecker = false;
      act(() => result.current.onRetry());
      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.errorMessage).toBeNull();
      expect(result.current.clients.map((entry) => entry.lspId)).toEqual(lspIds);
      expect(acquireLspClient).toHaveBeenCalledTimes(lspIds.length * 2);
      expect(retryLspClient).toHaveBeenCalledTimes(withLinter ? 1 : 0);
      unmount();
      expect(releaseLspClient).toHaveBeenCalledTimes(withLinter ? 3 : 1);
    },
  );
});
