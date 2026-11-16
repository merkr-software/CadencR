import { useMemo } from "react";
import type { TabContext } from "@cadencr/tab-sdk/protocol";

import { useGetFeature } from "@/api/generated";
import { buildTabContext } from "@/lib/plugin-tabs/tab-context";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";
import { useSessionStatusStore } from "@/stores/session-status-store";

/** The slice of `useSessionFeatureData` a tab context reads. */
export interface PluginTabContextData {
  projectPath: string;
  /** `undefined` while the project list loads. */
  projectName: string | undefined;
  /** Live worktree (Git-verified); `null` in the project root, `undefined` while unresolved. */
  worktreePath: string | null | undefined;
  gitBranch: string | undefined;
  defaultBranch: string | undefined;
  featureSettings: Record<string, string>;
  session?: {
    sessionDbId?: number | null;
    currentSelection?: { providerId: string } | null;
  };
}

/**
 * The feature page's `TabContext`, identity-stable while its values are: it
 * is derived from primitives only, so a streaming agent (which rebuilds the
 * session entry on every chunk) doesn't produce a new context — and the
 * broker additionally drops pushes whose JSON is unchanged.
 */
export function usePluginTabContext(
  featureId: number,
  projectId: number,
  data: PluginTabContextData,
  enabled: boolean,
): TabContext {
  const { data: feature } = useGetFeature(featureId, { query: { enabled } });
  const pr = usePrStatusStore(selectPrStatus(featureId))?.pr ?? null;
  const sessionId = data.session?.sessionDbId ?? null;
  const sessionStatus = useSessionStatusStore((state) =>
    sessionId === null ? null : (state.bySession[sessionId]?.status ?? null),
  );
  const projectName = data.projectName ?? "";
  const projectPath = data.projectPath;
  const featureName = feature?.title ?? "";
  const branch = data.gitBranch ?? null;
  const baseBranch = data.featureSettings.worktree_base_branch ?? data.defaultBranch ?? null;
  const worktreePath = data.worktreePath ?? null;
  const sessionProvider =
    data.session?.currentSelection?.providerId ?? feature?.runtime_provider ?? null;
  const prNumber = pr?.number ?? null;
  const prUrl = pr?.url ?? null;
  const prState = pr?.state ?? null;
  const prTitle = pr?.title ?? null;
  return useMemo(
    () =>
      buildTabContext({
        projectId,
        projectName,
        projectPath,
        featureId,
        featureName,
        branch,
        baseBranch,
        worktreePath,
        prNumber,
        prUrl,
        prState,
        prTitle,
        sessionId,
        sessionProvider,
        sessionStatus,
      }),
    [
      baseBranch,
      branch,
      featureId,
      featureName,
      prNumber,
      prState,
      prTitle,
      prUrl,
      projectId,
      projectName,
      projectPath,
      sessionId,
      sessionProvider,
      sessionStatus,
      worktreePath,
    ],
  );
}
