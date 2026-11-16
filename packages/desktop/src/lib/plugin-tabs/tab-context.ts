import type { TabContext } from "@cadencr/tab-sdk/protocol";

/** Flat inputs of a `TabContext`: primitives only, so callers can memoize on them. */
export interface TabContextFields {
  projectId: number;
  projectName: string;
  projectPath: string;
  featureId: number;
  featureName: string;
  branch: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prState: string | null;
  prTitle: string | null;
  sessionId: number | null;
  sessionProvider: string | null;
  sessionStatus: string | null;
}

/** The context a guest receives (§7) — information, never authority (§1.3). */
export function buildTabContext(fields: TabContextFields): TabContext {
  const hasSession =
    fields.sessionId !== null || fields.sessionProvider !== null || fields.sessionStatus !== null;
  return {
    project: { id: fields.projectId, name: fields.projectName, path: fields.projectPath },
    feature: {
      id: fields.featureId,
      name: fields.featureName,
      branch: fields.branch,
      baseBranch: fields.baseBranch,
      worktreePath: fields.worktreePath,
    },
    pullRequest:
      fields.prNumber !== null && fields.prUrl !== null
        ? {
            number: fields.prNumber,
            url: fields.prUrl,
            state: fields.prState ?? "unknown",
            title: fields.prTitle,
          }
        : null,
    session: hasSession
      ? { id: fields.sessionId, provider: fields.sessionProvider, status: fields.sessionStatus }
      : null,
  };
}
