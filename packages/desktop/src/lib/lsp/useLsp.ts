/**
 * `useLsp` is the single React entry point for plugging an editor into the
 * LSP layer. It:
 *
 * 1. Maps the file extension to an LSP `languageId` (returns no extensions
 *    for unsupported files — cmd-click is a no-op there).
 * 2. Resolves the SET of language servers to run for the file from the
 *    project's editor-tooling settings (type checker + optional linter) via
 *    `resolveActiveServers`. For non-JS/TS languages this is the single
 *    default server, keyed by the language id.
 * 3. Acquires one refcounted client per server id (`useLspClients`), each
 *    rooted at its own markers.
 * 4. Registers a `displayFile` handler on the TYPE CHECKER's workspace so
 *    cross-file LSP navigation lands in the same `(featureId, paneId)`.
 * 5. Returns the COMBINED CodeMirror extension: one merged-diagnostics field
 *    (so several servers' diagnostics union instead of clobbering), the type
 *    checker's plugin FIRST (so go-to-definition / hover / completion target
 *    it), then each linter's plugin, plus the shared cmd-click/hover/keymaps.
 *
 * The extension array is `[]` while clients are being created, then a stable
 * array once ready; callers feed it into a `Compartment`. When a socket dies
 * and reconnects, the client identity changes and the extension gets a fresh
 * identity so the editor re-mounts onto the new client.
 */
import { useCallback, useEffect, useMemo } from "react";
import { keymap, type EditorView } from "@codemirror/view";
import { type Extension } from "@codemirror/state";
import { serverCompletion } from "@codemirror/lsp-client";
import { useEditorStore } from "@/stores/editor-store";
import { getLspLanguageId } from "./language-id";
import { pathToFileUri } from "./file-uri";
import { resolveActiveServers } from "./active-servers";
import { useProjectEditorTooling } from "./useProjectEditorTooling";
import { useLspClients, type ReadyLspClient } from "./useLspClients";
import { mergedDiagnostics } from "./merged-diagnostics";
import { lspModClickExtension } from "./mod-click";
import { lspModHoverExtension } from "./mod-hover";
import { jumpToDefinitionKeymap } from "./definition";
import { lspLanguageFeatures } from "./language-features";
import type { LspStatus } from "./lsp-status";

export type { LspStatus } from "./lsp-status";

interface UseLspArgs {
  workspaceRoot: string | undefined;
  filePath: string;
  projectId: number;
  featureId: number;
  paneId: string;
  /**
   * When false, acquire no client and return an empty extension array + an
   * idle status. Used by large-file read-only mode. Defaults to true.
   */
  enabled?: boolean;
}

export interface UseLspResult {
  /** CodeMirror extension to mount inside a Compartment. `[]` until ready. */
  extension: Extension;
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
  enabled = true,
}: UseLspArgs): UseLspResult {
  const tooling = useProjectEditorTooling(projectId);

  const languageId = useMemo(
    () => (enabled ? getLspLanguageId(filePath) : null),
    [enabled, filePath],
  );

  const absPath = useMemo(() => {
    if (!workspaceRoot) return null;
    return filePath.startsWith("/") ? filePath : `${workspaceRoot.replace(/\/$/, "")}/${filePath}`;
  }, [workspaceRoot, filePath]);

  // The set of server ids to run. `resolveActiveServers` returns null for
  // non-JS/TS languages — those use the single default server keyed by the
  // language id (preserving the original single-client behavior).
  const lspIds = useMemo<string[]>(() => {
    if (!languageId) return [];
    const active = resolveActiveServers(languageId, {
      typescriptServer: tooling.typescriptServer,
      linter: tooling.linter,
    });
    return active ?? [languageId];
  }, [languageId, tooling.typescriptServer, tooling.linter]);

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

  const handleRetry = useCallback(() => onRetry(), [onRetry]);

  return useMemo<UseLspResult>(
    () => ({
      extension,
      status,
      errorMessage: errorMessage ?? undefined,
      languageId,
      resolvedRoot,
      onRetry: handleRetry,
    }),
    [extension, status, errorMessage, languageId, resolvedRoot, handleRetry],
  );
}
