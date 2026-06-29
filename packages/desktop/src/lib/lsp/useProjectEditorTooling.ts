/**
 * Resolve a project's editor-tooling settings with the global (workspace)
 * default as fallback. The four Phase-4 keys (`editor_typescript_server`,
 * `editor_linter`, `editor_formatter`, `editor_format_on_save`) are per-project
 * but inherit the workspace value when unset on the project.
 *
 * Returned object is memoized on its primitive fields so consumers' `useMemo`
 * / `React.memo` stay stable (frontend-performance rule).
 */
import { useMemo } from "react";
import { useGetProjectSettings } from "@/api/generated";
import { settingsArrayToMap, useGetWorkspaceSettings } from "@/api/settings";
import type { EditorToolingSettings } from "./active-servers";

export interface ProjectEditorTooling extends EditorToolingSettings {
  /** Always resolved (project → global → default), never null. */
  typescriptServer: string;
  /** Always resolved, never null. */
  linter: string;
  /** `editor_formatter`: `off` | `biome` | `oxfmt` | `prettier`. */
  formatter: string;
  /** `editor_format_on_save`: whether to format the buffer on save. */
  formatOnSave: boolean;
}

const KEYS = {
  typescriptServer: "editor_typescript_server",
  linter: "editor_linter",
  formatter: "editor_formatter",
  formatOnSave: "editor_format_on_save",
} as const;

/** First defined of project value, then global value, then `fallback`. */
function resolve(
  project: Record<string, string>,
  global: string | null,
  key: string,
  fallback: string,
): string {
  return project[key] ?? global ?? fallback;
}

/** @public */
export function useProjectEditorTooling(projectId: number | undefined): ProjectEditorTooling {
  const { data: projectSettings } = useGetProjectSettings(projectId ?? 0, {
    query: { enabled: projectId != null },
  });
  // Global defaults in one cached GET — fetching each key separately fired four
  // requests per editor mount, which floods the remote rate limit (see
  // ws-reconnect).
  const { data: workspaceSettings } = useGetWorkspaceSettings();

  const projectMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of projectSettings ?? []) {
      if (s.value != null) map[s.key] = s.value;
    }
    return map;
  }, [projectSettings]);

  const globalMap = useMemo(() => settingsArrayToMap(workspaceSettings), [workspaceSettings]);

  const typescriptServer = resolve(
    projectMap,
    globalMap[KEYS.typescriptServer] ?? null,
    KEYS.typescriptServer,
    "typescript-language-server",
  );
  const linter = resolve(projectMap, globalMap[KEYS.linter] ?? null, KEYS.linter, "off");
  const formatter = resolve(projectMap, globalMap[KEYS.formatter] ?? null, KEYS.formatter, "off");
  const formatOnSave =
    resolve(projectMap, globalMap[KEYS.formatOnSave] ?? null, KEYS.formatOnSave, "false") ===
    "true";

  return useMemo<ProjectEditorTooling>(
    () => ({ typescriptServer, linter, formatter, formatOnSave }),
    [typescriptServer, linter, formatter, formatOnSave],
  );
}
