/**
 * Resolve the SET of language servers that should run for a file, given the
 * file's LSP `languageId` and the project's editor-tooling settings.
 *
 * Phase 4 lets a project run several servers per file: one type checker plus an
 * optional linter. This module is the single place that maps
 * `(languageId, settings) -> lspId[]`; `useLsp` acquires one client per id and
 * the editor merges their diagnostics.
 *
 * Kept pure and synchronous (no catalog fetch) so the editor hot path stays
 * fast. The selectable servers only apply to the JS/TS family — the same
 * languages the backend catalog lists for `tsgo`/`biome`/`eslint`/`oxlint`. For
 * every other language we just use that language's default server. The
 * `JS_TS_LANGUAGE_IDS` set mirrors the backend catalog (see
 * `domain/lsp/catalog.rs`); keep them in sync when adding a language.
 */

/** Settings slice this resolver reads. Values are the raw setting strings. */
export interface EditorToolingSettings {
  /** `editor_typescript_server`: which TS type checker. */
  typescriptServer: string | null;
  /** `editor_linter`: `off` | `eslint` | `biome` | `oxlint`. */
  linter: string | null;
}

/** Default TS type checker when the setting is unset (matches the backend). */
export const DEFAULT_TS_SERVER = "typescript-language-server";

/**
 * LSP language ids served by the user-selectable JS/TS servers. Mirrors the
 * `language_ids` of `tsgo`/`biome`/`eslint`/`oxlint` in the backend catalog.
 */
const JS_TS_LANGUAGE_IDS: ReadonlySet<string> = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]);

/** Linter ids that serve the JS/TS family via LSP. `off` means no linter. */
const JS_TS_LINTER_IDS: ReadonlySet<string> = new Set(["eslint", "biome", "oxlint"]);

/**
 * The list of `lsp_id`s to run for `languageId`, in priority order. The FIRST
 * entry is always the type checker — `useLsp` mounts its plugin first so
 * go-to-definition / hover / completion target it (the `@codemirror/lsp-client`
 * `LSPPlugin.get(view)` resolves to the first mounted plugin). Any trailing
 * entries are linters whose diagnostics are merged in.
 *
 * For non-JS/TS languages this returns `null` — meaning "use the default
 * language server with no explicit id" (the existing single-client path).
 *
 * @public
 */
export function resolveActiveServers(
  languageId: string,
  settings: EditorToolingSettings,
): string[] | null {
  if (!JS_TS_LANGUAGE_IDS.has(languageId)) return null;

  const typeChecker = settings.typescriptServer === "tsgo" ? "tsgo" : DEFAULT_TS_SERVER;
  const ids = [typeChecker];

  const linter = settings.linter;
  if (linter != null && linter !== "off" && JS_TS_LINTER_IDS.has(linter)) {
    ids.push(linter);
  }
  return ids;
}
