import { relativeToProject } from "@/lib/relative-path";
import {
  chooseCheckoutFeature,
  resolveCliPathOwner,
  type CliFeatureCandidate,
  type CliProjectRoot,
  type CliWorktreeRoot,
} from "./resolve-cli-path";

/** A conversation's recorded worktree, as `/api/git/feature-worktrees` lists it. */
export interface CliRecordedWorktree {
  featureId: number;
  path: string;
  live: boolean;
  isMainWorktree: boolean;
}

/** What `cadencr open` needs to read; injected so the planning stays testable. */
export interface CliOpenSources {
  projects: () => Promise<readonly (CliProjectRoot & { name: string })[]>;
  worktrees: (projectId: number) => Promise<readonly CliRecordedWorktree[]>;
  /** The project's conversations that are not archived. */
  activeFeatures: (projectId: number) => Promise<readonly CliFeatureCandidate[]>;
  lastOpenedFeatureId: () => number | null;
}

export interface CliOpenRequest {
  path: string;
  pathKind: "file" | "directory";
  line?: number;
}

export type CliOpenPlan =
  | { kind: "not-in-project" }
  | { kind: "project"; projectId: number; notice?: string }
  | {
      kind: "feature";
      projectId: number;
      featureId: number;
      file: { relativePath: string; line?: number } | null;
    };

async function worktreeRoots(
  projects: readonly CliProjectRoot[],
  sources: CliOpenSources,
): Promise<{ live: CliWorktreeRoot[]; ownWorktreeFeatureIds: Set<number> }> {
  const lists = await Promise.all(
    projects.map(async (project) =>
      (await sources.worktrees(project.id)).map((worktree) => ({ project, worktree })),
    ),
  );
  const live: CliWorktreeRoot[] = [];
  const ownWorktreeFeatureIds = new Set<number>();
  for (const { project, worktree } of lists.flat()) {
    if (worktree.isMainWorktree) continue;
    ownWorktreeFeatureIds.add(worktree.featureId);
    if (worktree.live) {
      live.push({ projectId: project.id, featureId: worktree.featureId, path: worktree.path });
    }
  }
  return { live, ownWorktreeFeatureIds };
}

/**
 * Where `cadencr open <path>` lands: a conversation's worktree when the path is
 * in one, else the project's checkout. A folder opens the project (or that
 * conversation); a file opens in the conversation working there.
 */
export async function planCliOpen(
  request: CliOpenRequest,
  sources: CliOpenSources,
): Promise<CliOpenPlan> {
  const projects = await sources.projects();
  // Listing a project's worktrees runs git: ask only the projects whose
  // checkout holds the path (their nested worktrees included), and every
  // project only for a path outside them all (a worktree kept elsewhere).
  const containing = projects.filter(
    (project) => relativeToProject(request.path, project.path) !== null,
  );
  const { live, ownWorktreeFeatureIds } = await worktreeRoots(
    containing.length > 0 ? containing : projects,
    sources,
  );
  const owner = resolveCliPathOwner(request.path, projects, live);
  if (!owner) return { kind: "not-in-project" };
  const file =
    request.pathKind === "file" ? { relativePath: owner.relativePath, line: request.line } : null;
  const features = await sources.activeFeatures(owner.projectId);
  if (owner.featureId !== null) {
    if (features.some((feature) => feature.id === owner.featureId)) {
      return { kind: "feature", projectId: owner.projectId, featureId: owner.featureId, file };
    }
    return {
      kind: "project",
      projectId: owner.projectId,
      notice: "That worktree belongs to an archived conversation. Restore it to open its files.",
    };
  }
  if (!file) return { kind: "project", projectId: owner.projectId };
  const featureId = chooseCheckoutFeature(
    features,
    ownWorktreeFeatureIds,
    sources.lastOpenedFeatureId(),
  );
  if (featureId === null) {
    const project = projects.find((candidate) => candidate.id === owner.projectId);
    return {
      kind: "project",
      projectId: owner.projectId,
      notice: `Start a conversation in ${project?.name ?? "this project"} that works in its folder to open its files.`,
    };
  }
  return { kind: "feature", projectId: owner.projectId, featureId, file };
}
