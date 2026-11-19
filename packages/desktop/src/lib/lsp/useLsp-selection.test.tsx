// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
import { LSPClient } from "@codemirror/lsp-client";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { diagnosticCount } from "@codemirror/lint";
import { expect, it, vi } from "vitest";
import { useLsp } from "./useLsp";
import { useLspResolution, type LspResolution } from "./useLspResolution";
import { CadencrWorkspace } from "./cadencr-workspace";
import { acquireLspClient, releaseLspClient } from "./client-manager";
import { setServerDiagnostics } from "./merged-diagnostics";

vi.mock("@/hooks/useOpenEditorFile", () => ({ useOpenEditorFile: () => vi.fn() }));
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

it.each(["server removal", "explicit Plain Text", "disabled"] as const)(
  "clears rendered diagnostics when %s reconfigures the editor to zero clients",
  async (reason) => {
    const client = new LSPClient({ workspace: (owner) => new CadencrWorkspace(owner) });
    const workspace = client.workspace;
    if (!(workspace instanceof CadencrWorkspace)) throw new Error("Expected app workspace");
    vi.mocked(acquireLspClient).mockResolvedValue({ client, workspace });
    mockResolution(resolution(["primary"]));
    const { result, rerender, unmount } = renderHook(
      ({ enabled, explicitPlainText }) =>
        useLsp({
          workspaceRoot: "/workspace",
          filePath: "file.custom",
          projectId: 3,
          featureId: 1,
          paneId: "root",
          enabled,
          explicitPlainText,
        }),
      { initialProps: { enabled: true, explicitPlainText: false } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const compartment = new Compartment();
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      doc: "invalidCount",
      extensions: [compartment.of(result.current.extension)],
    });
    const diagnostic = { from: 0, to: 12, severity: "error" as const, message: "invalidCount" };
    try {
      view.dispatch({
        effects: setServerDiagnostics.of({ lspId: "primary", diagnostics: [diagnostic] }),
      });
      expect(diagnosticCount(view.state)).toBe(1);
      expect(parent.querySelectorAll(".cm-lintRange-error")).toHaveLength(1);

      if (reason === "server removal") mockResolution(resolution([]));
      rerender({
        enabled: reason !== "disabled",
        explicitPlainText: reason === "explicit Plain Text",
      });
      await waitFor(() => expect(result.current.status).toBe("unsupported"));
      view.dispatch({ effects: compartment.reconfigure(result.current.extension) });

      expect(diagnosticCount(view.state)).toBe(0);
      expect(parent.querySelectorAll(".cm-lintRange-error")).toHaveLength(0);
      // A response already queued by the removed client must not restore its underline.
      view.dispatch({
        effects: setServerDiagnostics.of({ lspId: "primary", diagnostics: [diagnostic] }),
      });
      expect(diagnosticCount(view.state)).toBe(0);
      expect(parent.querySelectorAll(".cm-lintRange-error")).toHaveLength(0);

      mockResolution(resolution(["primary"]));
      rerender({ enabled: true, explicitPlainText: false });
      await waitFor(() => expect(result.current.status).toBe("ready"));
      view.dispatch({ effects: compartment.reconfigure(result.current.extension) });
      view.dispatch({
        effects: setServerDiagnostics.of({ lspId: "primary", diagnostics: [diagnostic] }),
      });
      expect(diagnosticCount(view.state)).toBe(1);
      expect(parent.querySelectorAll(".cm-lintRange-error")).toHaveLength(1);
    } finally {
      view.destroy();
      parent.remove();
      unmount();
      client.disconnect();
    }
  },
);
