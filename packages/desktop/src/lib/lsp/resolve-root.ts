/**
 * Monorepo-aware LSP root resolution.
 *
 * In a monorepo the language server should root at the nearest ancestor
 * config for the *opened file* (e.g. the package's `tsconfig.json`), not the
 * feature working dir. This module asks the backend to walk up from a file to
 * the nearest directory containing one of the catalog's `root_markers` for the
 * file's language, and caches the answer per containing directory — a
 * directory's resolved root is stable for the session, so we never ask twice
 * for files in the same folder.
 *
 * On any failure we fall back to the feature `workspaceRoot` so LSP still
 * comes up (single-package repos resolve here too, unchanged behavior). The
 * failure is logged but not toasted: a missed monorepo root degrades to the
 * feature root, which is correct for the common case and not worth nagging
 * about — the visible status indicator still reflects the eventual client
 * state.
 */
import { lspRoot } from "@/api/generated";

/** Cache keyed by `${workspaceRoot}::${languageId}::${lspId}::${containingDir}`. */
const rootCache = new Map<string, string>();

function dirOf(absPath: string): string {
  const idx = absPath.lastIndexOf("/");
  return idx <= 0 ? "/" : absPath.slice(0, idx);
}

function cacheKey(workspaceRoot: string, languageId: string, lspId: string, dir: string): string {
  return `${workspaceRoot}::${languageId}::${lspId}::${dir}`;
}

/**
 * Resolve the LSP root for `absFilePath`. Returns the nearest ancestor
 * directory containing a root marker, falling back to `workspaceRoot`. Result
 * is cached per containing directory.
 *
 * `lspId` selects which server's root markers to use — different servers in the
 * same language may root differently. When omitted, the language default's
 * markers are used.
 *
 * @public
 */
export async function resolveLspRoot(
  workspaceRoot: string,
  languageId: string,
  absFilePath: string,
  lspId?: string,
): Promise<string> {
  const dir = dirOf(absFilePath);
  const key = cacheKey(workspaceRoot, languageId, lspId ?? "", dir);
  const cached = rootCache.get(key);
  if (cached) return cached;
  try {
    const { root } = await lspRoot({
      workspace_root: workspaceRoot,
      file_path: absFilePath,
      language_id: languageId,
      lsp_id: lspId ?? null,
    });
    const resolved = root || workspaceRoot;
    rootCache.set(key, resolved);
    return resolved;
  } catch (err) {
    // Degrade to the feature root rather than block LSP entirely. The
    // status indicator reflects the real client state once it connects.
    console.warn("[lsp] root resolution failed; using feature root:", err);
    rootCache.set(key, workspaceRoot);
    return workspaceRoot;
  }
}

/** Test-only: drop the per-directory root cache. */
/** @public */
export function __resetLspRootCacheForTest(): void {
  rootCache.clear();
}
