import { CadencrError, isCadencrError, type CadencrClient } from "@cadencr/tab-sdk";

export type Feed = "pulls" | "runs";

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  updated_at: string;
  user: { login: string } | null;
}

export interface WorkflowRun {
  id: number;
  name: string | null;
  display_title: string;
  html_url: string;
  head_branch: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  updated_at: string;
}

export type FeedItems =
  | { feed: "pulls"; items: PullRequest[] }
  | { feed: "runs"; items: WorkflowRun[] };

export interface FeedResult {
  data: FeedItems;
  /** Whether the request carried the configured token. */
  authenticated: boolean;
  /** `x-ratelimit-remaining`, when GitHub sent it. */
  rateLimitRemaining: string | null;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** `owner/name`. `.` and `..` are refused: interpolated into the URL they would
 *  walk out of `/repos/` to another endpoint, with the user's token. */
export function isRepository(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const segments = value.split("/");
  return (
    segments.length === 2 &&
    segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..")
  );
}

const BASE_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

/**
 * `{{secret:token}}` is replaced by the Cadencr service right before the
 * request leaves the machine: this page never sees the token. When no token
 * is configured the service refuses the placeholder with
 * `PLUGIN_TAB_SECRET_UNKNOWN`, and we ask again anonymously.
 */
const AUTH_HEADERS = { ...BASE_HEADERS, Authorization: "Bearer {{secret:token}}" };

function feedUrl(repository: string, feed: Feed): string {
  const [owner = "", name = ""] = repository.split("/");
  const repo = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return feed === "pulls"
    ? `${repo}/pulls?state=open&per_page=20`
    : `${repo}/actions/runs?per_page=20`;
}

/** Set once the service reports no token: later polls go straight to the
 *  anonymous request instead of paying a refused round trip each time. */
let tokenMissing = false;

async function fetchWithOptionalToken(client: CadencrClient, url: string, probeToken: boolean) {
  if (probeToken) tokenMissing = false;
  if (!tokenMissing) {
    try {
      return {
        response: await client.net.fetch(url, { headers: AUTH_HEADERS }),
        authenticated: true,
      };
    } catch (error) {
      if (!isCadencrError(error) || error.code !== "PLUGIN_TAB_SECRET_UNKNOWN") throw error;
      tokenMissing = true;
    }
  }
  return {
    response: await client.net.fetch(url, { headers: BASE_HEADERS }),
    authenticated: false,
  };
}

/**
 * One feed of `repository`. `probeToken` tries the token again even if it was
 * missing last time: pass it when the user may just have set one (first load,
 * manual refresh, tab shown again), not on timed polls.
 */
export async function loadFeed(
  client: CadencrClient,
  repository: string,
  feed: Feed,
  probeToken: boolean,
): Promise<FeedResult> {
  const { response, authenticated } = await fetchWithOptionalToken(
    client,
    feedUrl(repository, feed),
    probeToken,
  );
  if (!response.ok) {
    // GitHub explains failures in `{ message }` (404 for a private repository
    // read anonymously, 403 when the rate limit is spent).
    const body = await response.json<{ message?: string }>().catch(() => ({ message: undefined }));
    throw new CadencrError(
      "GITHUB_ERROR",
      `GitHub answered ${response.status}${body.message ? `: ${body.message}` : ""}`,
      { status: response.status },
    );
  }
  const data: FeedItems =
    feed === "pulls"
      ? { feed, items: await response.json<PullRequest[]>() }
      : { feed, items: (await response.json<{ workflow_runs: WorkflowRun[] }>()).workflow_runs };
  return {
    data,
    authenticated,
    rateLimitRemaining: response.headers["x-ratelimit-remaining"] ?? null,
  };
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

export function relativeTime(iso: string, now = Date.now()): string {
  const delta = new Date(iso).getTime() - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return RELATIVE.format(Math.round(delta / ms), unit);
  }
  return "just now";
}
