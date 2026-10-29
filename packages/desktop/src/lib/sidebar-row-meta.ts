import type {
  AllocatedPort,
  Feature,
  FeatureWorktreeInfo,
  GitStats,
  PrStatusSnapshot,
} from "@/api/generated";
import type { SidebarConfig } from "@/lib/sidebar-config";
import { hasOpenTodos, type RowSummary } from "@/lib/sidebar-row-summary";

/** The display options a row's details read. */
export function rowMetaOptions(config: SidebarConfig) {
  return {
    branch: config.branch,
    label: config.label,
    diff: config.diff,
    pr: config.pr,
    activity: config.activity,
    ports: config.ports,
    provider: config.provider,
    todos: config.todos,
  };
}

export type RowMetaOptions = ReturnType<typeof rowMetaOptions>;

export interface RowMetaInput {
  feature: Feature;
  worktree: FeatureWorktreeInfo | undefined;
  prStatus: PrStatusSnapshot | undefined;
  gitStats: GitStats | undefined;
  shellCount: number;
  browserCount: number;
  downloadCount: number;
  ports: readonly AllocatedPort[];
  summary?: RowSummary;
}

/** Which of a row's details show: the options switched on, and this row's data. */
export interface RowMetaItems {
  branch: string | null;
  label: string | null;
  /** "Logo + model": the logo keeps its title-line slot, the model reads with the details. */
  model: string | null;
  stats: GitStats | null;
  pr: boolean;
  activity: boolean;
  ports: boolean;
  todos: RowSummary | null;
}

/** Whether the todo progress has something to say: open todos, or why they couldn't load. */
export function hasTodoChip(summary: RowSummary | undefined): summary is RowSummary {
  return summary != null && (summary.error != null || hasOpenTodos(summary.todos));
}

export function rowMetaItems(show: RowMetaOptions, input: RowMetaInput): RowMetaItems {
  const { feature, prStatus, gitStats } = input;
  return {
    branch: (show.branch && input.worktree?.worktree_branch) || null,
    label: show.label === "hidden" ? null : feature.label || null,
    model:
      show.provider === "logo_model" && feature.runtime_provider
        ? feature.model_session?.trim() || "Default"
        : null,
    stats:
      show.diff && gitStats != null && (gitStats.insertions > 0 || gitStats.deletions > 0)
        ? gitStats
        : null,
    // `FeaturePrIndicator` also renders for an error with no proposal — a forge
    // auth failure must not be the one thing that keeps the details from
    // mounting — unless the forge is not set up yet, which it leaves to the
    // Git tab. Any branch's proposal counts: one on another branch of the
    // conversation still leads the chip while the current branch has none.
    pr:
      show.pr &&
      (prStatus?.pr != null ||
        (prStatus?.other_prs?.length ?? 0) > 0 ||
        (prStatus?.error != null && !prStatus.setup_required)),
    activity:
      show.activity && (input.shellCount > 0 || input.browserCount > 0 || input.downloadCount > 0),
    ports: show.ports && input.ports.length > 0,
    todos: show.todos && hasTodoChip(input.summary) ? input.summary : null,
  };
}

/** Whether the code details (branch, diff, pull request) have anything to show. */
export function hasCodeItems(items: RowMetaItems): boolean {
  return items.branch != null || items.stats != null || items.pr;
}

/** Whether the activity details (label, todos, shells and tabs, ports, model) have anything to show. */
export function hasActivityItems(items: RowMetaItems): boolean {
  return (
    items.label != null ||
    items.model != null ||
    items.activity ||
    items.ports ||
    items.todos != null
  );
}

/** A fixed row splits its details over two lines: the code, then the activity around it. */
export type RowMetaPart = "code" | "activity";

/** The items of one part of the details; all of them without a part. */
export function rowMetaPart(items: RowMetaItems, part: RowMetaPart | undefined): RowMetaItems {
  if (part === "code") {
    return { ...items, label: null, model: null, activity: false, ports: false, todos: null };
  }
  if (part === "activity") return { ...items, branch: null, stats: null, pr: false };
  return items;
}
