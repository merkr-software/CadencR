import { translateUi } from "@/lib/i18n/ui";
import type {
  AllocatedPort,
  CiState,
  Feature,
  FeatureWorktreeInfo,
  GitStats,
  PrStatusSnapshot,
  ReviewState,
} from "@/api/generated";
import { PROVIDER_IDS } from "@/lib/providers";
import type { AttentionState } from "@/lib/sidebar-attention";
import { sampleLogoUrl, type SampleLogo } from "@/lib/sidebar-sample-logos";

/**
 * The made-up workspace the display options preview renders: a few projects
 * and conversations that between them hit every case an option changes
 * (each status, a pending permission and question, worktrees, labels, diff,
 * pull requests, ports, shells, a child conversation, idle ones old enough to
 * fold, a long title), and between them every next action "For me" names
 * (approve, answer, check an error, fix CI, review a reply, merge). Ids are
 * negative so they can never meet a real one.
 */

export interface SampleProject {
  id: number;
  name: string;
  color: string;
  logo: SampleLogo;
  /** Starts folded, so its badges show. */
  collapsed?: boolean;
}

export interface SampleConversation {
  feature: Feature;
  state: AttentionState;
  /** Where a replay starts it from, so it reaches `state` live. */
  before: AttentionState;
  worktree?: FeatureWorktreeInfo;
  gitStats?: GitStats;
  prStatus?: PrStatusSnapshot;
  runningSubagentCount: number;
  shellCount: number;
  browserCount: number;
  ports: readonly AllocatedPort[];
}

export const SAMPLE_PROJECTS: readonly SampleProject[] = [
  { id: -1, name: "web-app", color: "3b82f6", logo: "webApp" },
  { id: -2, name: "billing-api", color: "f97316", logo: "billingApi" },
  { id: -3, name: "design-system", color: "10b981", logo: "designSystem", collapsed: true },
];

/** The conversation the preview shows as open. */
export const SAMPLE_ACTIVE_FEATURE_ID = -14;
/** The request a replay stages as the newest one, whose popover may open by itself. */
export const SAMPLE_NEWEST_REQUEST_FEATURE_ID = -11;

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

interface SampleSpec extends Omit<
  SampleConversation,
  "feature" | "runningSubagentCount" | "shellCount" | "browserCount" | "ports"
> {
  id: number;
  projectId: number;
  title: string;
  minutesAgo: number;
  feature?: Partial<Feature>;
  runningSubagentCount?: number;
  shellCount?: number;
  browserCount?: number;
  ports?: readonly AllocatedPort[];
}

const SPECS: readonly SampleSpec[] = [
  {
    id: -11,
    projectId: -1,
    get title() {
      return translateUi("sidebar.samples.checkoutTest", "Fix flaky checkout test");
    },
    minutesAgo: 2,
    state: "waiting",
    before: "working",
    feature: { label: "bug", runtime_provider: PROVIDER_IDS.CLAUDE_CODE, model_session: "opus" },
    worktree: worktree(-11, "web-app", "fix/checkout-flake"),
    gitStats: { insertions: 42, deletions: 7, files_changed: 3 },
  },
  {
    id: -12,
    projectId: -1,
    get title() {
      return translateUi("sidebar.samples.darkMode", "Add a dark mode toggle");
    },
    minutesAgo: 1,
    state: "working",
    before: "working",
    feature: { runtime_provider: PROVIDER_IDS.CODEX_CLI, model_session: "gpt-5" },
    worktree: worktree(-12, "web-app", "feat/dark-mode"),
    gitStats: { insertions: 318, deletions: 54, files_changed: 12 },
    prStatus: pullRequest(-12, 128, "feat/dark-mode", { state: "open", ci: "running" }),
    runningSubagentCount: 2,
    shellCount: 1,
    browserCount: 1,
    ports: [{ pid: 4242, port: 5173, process: "vite", source: "terminal" }],
  },
  {
    id: -13,
    projectId: -1,
    get title() {
      return translateUi("sidebar.samples.colorTokens", "Audit the color tokens");
    },
    minutesAgo: 6,
    state: "unread",
    before: "working",
    feature: { spawned_by_feature_id: -12, runtime_provider: PROVIDER_IDS.CODEX_CLI },
  },
  {
    id: -14,
    projectId: -1,
    get title() {
      return translateUi(
        "sidebar.samples.sessionMiddleware",
        "Refactor the session middleware: split auth checks from rate limiting, add tests",
      );
    },
    minutesAgo: 90,
    state: "idle",
    before: "idle",
    feature: {
      is_pinned: true,
      runtime_provider: PROVIDER_IDS.CLAUDE_CODE,
      model_session: "sonnet",
    },
    worktree: worktree(-14, "web-app", "refactor/session-middleware"),
    prStatus: pullRequest(-14, 121, "refactor/session-middleware", {
      state: "merged",
      ci: "passing",
      review: "approved",
    }),
  },
  {
    id: -15,
    projectId: -1,
    get title() {
      return translateUi("sidebar.samples.offlineMode", "Spike: offline mode");
    },
    minutesAgo: 12 * DAY_MINUTES,
    state: "idle",
    before: "idle",
    feature: { runtime_provider: PROVIDER_IDS.CODEX_CLI },
  },
  {
    id: -21,
    projectId: -2,
    get title() {
      return translateUi("sidebar.samples.billingWebhooks", "Migrate billing webhooks");
    },
    minutesAgo: 14,
    state: "failed",
    before: "working",
    feature: { is_pinned: true, label: "infra", runtime_provider: PROVIDER_IDS.CLAUDE_CODE },
    worktree: worktree(-21, "billing-api", "feat/webhooks-v2"),
    gitStats: { insertions: 96, deletions: 31, files_changed: 5 },
  },
  {
    id: -22,
    projectId: -2,
    get title() {
      return translateUi("sidebar.samples.releaseNotes", "Write the 2.4 release notes");
    },
    minutesAgo: 25,
    state: "unread",
    before: "working",
    feature: { runtime_provider: PROVIDER_IDS.CODEX_CLI },
    // A failing check outranks the unread reply: For me asks to fix CI.
    worktree: worktree(-22, "billing-api", "docs/release-2.4"),
    prStatus: pullRequest(-22, 57, "docs/release-2.4", { state: "open", ci: "failing" }),
  },
  {
    id: -23,
    projectId: -2,
    get title() {
      return translateUi("sidebar.samples.stripeSdk", "Bump the Stripe SDK");
    },
    minutesAgo: 5 * DAY_MINUTES,
    state: "idle",
    before: "idle",
    feature: { runtime_provider: PROVIDER_IDS.OPENCODE },
    // Approved with green checks: For me asks to merge it.
    worktree: worktree(-23, "billing-api", "chore/stripe-sdk-14"),
    prStatus: pullRequest(-23, 54, "chore/stripe-sdk-14", {
      state: "open",
      ci: "passing",
      review: "approved",
    }),
  },
  {
    id: -24,
    projectId: -2,
    get title() {
      return translateUi("sidebar.samples.graphqlGateway", "Spike: GraphQL gateway");
    },
    minutesAgo: 20 * DAY_MINUTES,
    state: "idle",
    before: "idle",
    feature: { runtime_provider: PROVIDER_IDS.CLAUDE_CODE },
  },
  {
    id: -31,
    projectId: -3,
    get title() {
      return translateUi("sidebar.samples.spacingScale", "Tokenize the spacing scale");
    },
    minutesAgo: 9,
    state: "waiting",
    before: "idle",
    feature: { runtime_provider: PROVIDER_IDS.CLAUDE_CODE },
  },
  {
    id: -32,
    projectId: -3,
    get title() {
      return translateUi("sidebar.samples.storybookUpgrade", "Upgrade Storybook");
    },
    minutesAgo: 3,
    state: "working",
    before: "working",
    feature: { runtime_provider: PROVIDER_IDS.OPENCODE },
  },
  {
    id: -33,
    projectId: -3,
    get title() {
      return translateUi("sidebar.samples.iconAudit", "Icon audit");
    },
    minutesAgo: 2 * DAY_MINUTES,
    state: "idle",
    before: "idle",
    feature: { runtime_provider: PROVIDER_IDS.CODEX_CLI },
  },
];

/** The sample conversations, their times counted back from `now`. */
export function buildSampleConversations(now: number): readonly SampleConversation[] {
  return SPECS.map(({ id, projectId, title, minutesAgo, feature, ...rest }) => {
    const iso = new Date(now - minutesAgo * MINUTE_MS).toISOString();
    return {
      ...rest,
      runningSubagentCount: rest.runningSubagentCount ?? 0,
      shellCount: rest.shellCount ?? 0,
      browserCount: rest.browserCount ?? 0,
      ports: rest.ports ?? [],
      feature: {
        id,
        project_id: projectId,
        title,
        created_at: iso,
        last_activity_at: iso,
        is_pinned: false,
        status: "active",
        type: "ws-session",
        ...feature,
      },
    };
  });
}

export const SAMPLE_PROJECT_COLORS: ReadonlyMap<number, string> = new Map(
  SAMPLE_PROJECTS.map((project) => [project.id, project.color]),
);

export const SAMPLE_PROJECT_ICONS: ReadonlyMap<number, string> = new Map(
  SAMPLE_PROJECTS.map((project) => [project.id, sampleLogoUrl(project.logo, project.color)]),
);

function worktree(featureId: number, project: string, branch: string): FeatureWorktreeInfo {
  return {
    feature_id: featureId,
    worktree_branch: branch,
    worktree_path: `~/.cadencr/worktrees/${project}/${branch.replace("/", "-")}`,
    branch_exists: true,
    directory_exists: true,
    is_default_branch: false,
    is_main_worktree: false,
    live: true,
  };
}

function pullRequest(
  featureId: number,
  number: number,
  branch: string,
  {
    state,
    ci,
    review = "pending",
  }: { state: "open" | "merged"; ci: CiState; review?: ReviewState },
): PrStatusSnapshot {
  return {
    feature_id: featureId,
    fetched_at: 0,
    setup_required: false,
    ci: { state: ci, checks: [] },
    pr: {
      number,
      state,
      title: branch,
      source_branch: branch,
      target_branch: "main",
      review_state: review,
      get pr_label() {
        return translateUi("sidebar.samples.pullRequest", "Pull request");
      },
      author: { username: "you" },
      body_markdown: "",
      head_sha: "",
      updated_at: "",
      url: "",
    },
  };
}
