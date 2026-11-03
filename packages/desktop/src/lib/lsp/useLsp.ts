/** Connect installed, backend-selected language servers to a CodeMirror editor. */
import { useCallback, useEffect, useMemo } from "react";
import { keymap, type EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { serverCompletion } from "@codemirror/lsp-client";
import { useEditorStore } from "@/stores/editor-store";
import { useLspResolution, type LspResolution } from "./useLspResolution";
import { pathToFileUri } from "./file-uri";
import { useLspClients, type ReadyLspClient } from "./useLspClients";
import { mergedDiagnostics } from "./merged-diagnostics";
import { lspModClickExtension } from "./mod-click";
import { lspModHoverExtension } from "./mod-hover";
import { jumpToDefinitionKeymap } from "./definition";
import { lspLanguageFeatures } from "./language-features";
import type { LspStatus } from "./lsp-status";
import type { EditorLanguageId } from "@/lib/editor-language";

export type { LspStatus } from "./lsp-status";

interface UseLspArgs {
  workspaceRoot: string | undefined;
  filePath: string;
  projectId: number;
  featureId: number;
  paneId: string;
  /** User-selected editor language, after resolving file/extension overrides. */
  editorLanguageId?: EditorLanguageId;
  /** Explicit Plain Text disables LSP; automatic Plain Text uses registry associations. */
  explicitPlainText?: boolean;
  /**
   * When false, acquire no client and return an empty extension array + an
   * idle status. Used by large-file read-only mode. Defaults to true.
   */
  enabled?: boolean;
}

export interface UseLspResult {
  /** CodeMirror extension to mount inside a Compartment. `[]` until ready. */
  extension: Extension;
  resolution?: LspResolution;
  /** Coarse state for status-bar / popover display. */
  status: LspStatus;
  /** Present iff `status === "error"`. */
  errorMessage?: string;
  /** Resolved LSP language id (e.g. `"typescript"`), or `null` if unsupported. */
  languageId: string | null;
  /** Type checker's resolved LSP root, or `null` while resolving. */
  resolvedRoot: string | null;
  /** Force a fresh connection attempt on every active client. */
  onRetry: () => void;
}

/** @public */
export function useLsp({
  workspaceRoot,
  filePath,
  projectId,
  featureId,
  paneId,
  editorLanguageId,
  explicitPlainText = false,
  enabled = true,
}: UseLspArgs): UseLspResult {
  const resolution = useLspResolution(
    {
      language_id: editorLanguageId === "plaintext" ? undefined : editorLanguageId,
      file_path: filePath,
      project_id: projectId,
    },
    enabled && !explicitPlainText,
  );
  const languageId = enabled && !explicitPlainText ? resolution.data?.language_id || null : null;

  const absPath = useMemo(() => {
    if (!workspaceRoot) return null;
    return filePath.startsWith("/") ? filePath : `${workspaceRoot.replace(/\/$/, "")}/${filePath}`;
  }, [workspaceRoot, filePath]);

  // Catalog warnings, candidates and suggestions may change independently of
  // the selected clients. Preserve their ordered identity across those updates.
  const lspIdsKey = JSON.stringify(resolution.data?.servers.map((server) => server.lsp_id) ?? []);
  const lspIds = useMemo(() => JSON.parse(lspIdsKey) as string[], [lspIdsKey]);

  const { clients, status, errorMessage, onRetry } = useLspClients({
    workspaceRoot,
    absPath,
    languageId,
    lspIds,
  });

  const typeChecker: ReadyLspClient | undefined = clients[0];

  // Register the displayFile handler on the type checker's workspace so
  // jumpToDefinition lands in the same pane the click came from.
  useEffect(() => {
    if (!typeChecker) return;
    const handler = async (absTarget: string): Promise<EditorView | null> => {
      useEditorStore.getState().openFile(featureId, paneId, absTarget);
      return null;
    };
    typeChecker.workspace.setDisplayFileHandler(handler);
    return () => {
      typeChecker.workspace.setDisplayFileHandler(null);
    };
  }, [typeChecker, featureId, paneId]);

  const resolvedRoot = typeChecker?.root ?? null;

  // Build the combined extension. Order matters: the merged-diagnostics field
  // is mounted once; the type checker's plugin is FIRST so `LSPPlugin.get`
  // (used by go-to-definition / hover / completion) resolves to it; linter
  // plugins follow (they only contribute diagnostics via their own bucket).
  const extension = useMemo<Extension>(() => {
    if (clients.length === 0 || !languageId || !absPath) return [];
    const uri = pathToFileUri(absPath);
    const plugins = clients.map((c) => c.client.plugin(uri, languageId));
    return [
      mergedDiagnostics(),
      ...plugins,
      serverCompletion(),
      lspLanguageFeatures,
      keymap.of([...jumpToDefinitionKeymap]),
      lspModClickExtension({ resolvedRoot, languageId: typeChecker?.lspId ?? languageId }),
      lspModHoverExtension(),
    ];
  }, [clients, languageId, absPath, resolvedRoot, typeChecker]);

  const handleRetry = useCallback(() => {
    void resolution.refetch();
    onRetry();
  }, [resolution.refetch, onRetry]);

  return useMemo<UseLspResult>(
    () => ({
      extension,
      status:
        resolution.isPending && enabled && !explicitPlainText
          ? "starting"
          : enabled && !explicitPlainText && (resolution.isError || resolution.data?.error)
            ? "error"
            : status,
      errorMessage:
        enabled && !explicitPlainText
          ? (resolution.error?.message ?? resolution.data?.error ?? errorMessage ?? undefined)
          : undefined,
      resolution: enabled && !explicitPlainText ? resolution.data : undefined,
      languageId,
      resolvedRoot,
      onRetry: handleRetry,
    }),
    [
      extension,
      status,
      errorMessage,
      languageId,
      resolvedRoot,
      handleRetry,
      resolution.data,
      resolution.error,
      resolution.isError,
      resolution.isPending,
      enabled,
      explicitPlainText,
    ],
  );
}
