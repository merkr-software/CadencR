import { describe, expect, it } from "vitest";
import type { CommentThread, PrSummary } from "@/api/generated";
import {
  formatPrThreadsForAgent,
  isAutomatedReviewThread,
  isThreadUnresolved,
  reviewNavigationTargets,
  sortReviewThreadsForAction,
  summarizeReviewThreads,
  threadExternalHost,
  unresolvedThreadLinesByFile,
  unresolvedThreads,
} from "./pr-review-threads";
import { gitPathForAgent } from "./git-paths";

const asIs = (path: string): string => path;

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "thread-1",
    resolved: false,
    outdated: false,
    file: "src/app.ts",
    line: 12,
    side: "new",
    comments: [
      {
        author: { username: "alice", display_name: "Alice Ng", avatar_url: null },
        body_markdown: "Handle the empty case.",
        created_at: "2026-07-20T09:00:00Z",
        url: "https://forge.test/pr/1#c1",
      },
    ],
    ...overrides,
  };
}

const PR: PrSummary = {
  number: 17,
  title: "Add forge support",
  body_markdown: "",
  state: "open",
  url: "https://forge.test/pr/17",
  source_branch: "feature/forge",
  target_branch: "main",
  head_sha: "a".repeat(40),
  review_state: "pending",
  author: { username: "alice", display_name: null, avatar_url: null },
  updated_at: "2026-07-20T09:00:00Z",
  pr_label: "Pull request",
};

describe("isThreadUnresolved", () => {
  it("treats a thread the forge cannot resolve as still open", () => {
    // A plain PR comment carries no resolution state; dropping it would hide
    // review feedback that nobody has answered.
    expect(isThreadUnresolved(thread({ resolved: null }))).toBe(true);
    expect(isThreadUnresolved(thread({ resolved: undefined }))).toBe(true);
  });

  it("only excludes threads the forge explicitly resolved", () => {
    expect(isThreadUnresolved(thread({ resolved: true }))).toBe(false);
    expect(isThreadUnresolved(thread({ resolved: false }))).toBe(true);
  });

  it("keeps an outdated thread unresolved, so the PR tab and briefing still carry it", () => {
    // Only the diff overlay drops these; the words still need an answer.
    const stale = thread({ outdated: true });
    expect(isThreadUnresolved(stale)).toBe(true);
    expect(unresolvedThreads([stale])).toHaveLength(1);
    expect(formatPrThreadsForAgent([stale], PR, asIs)).toContain("outdated");
  });
});

describe("unresolvedThreadLinesByFile", () => {
  it("groups by file and keeps the two diff sides apart", () => {
    const lines = unresolvedThreadLinesByFile([
      thread({ id: "a", file: "src/app.ts", line: 12, side: "new" }),
      thread({ id: "b", file: "src/app.ts", line: 12, side: "old" }),
      thread({ id: "c", file: "src/app.ts", line: 12, side: "new" }),
      thread({ id: "d", file: "src/other.ts", line: 3, side: "new" }),
    ]);

    const app = lines.get("src/app.ts");
    expect(app).toHaveLength(2);
    expect(app?.find((entry) => entry.side === "new")?.threads.map((t) => t.id)).toEqual([
      "a",
      "c",
    ]);
    expect(app?.find((entry) => entry.side === "old")?.threads.map((t) => t.id)).toEqual(["b"]);
    expect(lines.get("src/other.ts")).toHaveLength(1);
  });

  it("defaults a missing side to the post-image, where forges draw the thread", () => {
    const lines = unresolvedThreadLinesByFile([thread({ side: null })]);
    expect(lines.get("src/app.ts")?.[0].side).toBe("new");
  });

  it("skips resolved threads and threads with nowhere to anchor", () => {
    const lines = unresolvedThreadLinesByFile([
      thread({ id: "resolved", resolved: true }),
      thread({ id: "no-file", file: null }),
      thread({ id: "no-line", line: null }),
    ]);
    expect(lines.size).toBe(0);
  });

  it("skips outdated threads, whose line points into a rewritten revision", () => {
    // The forge gives no current line for an outdated thread — the number is an
    // offset into old code, so anchoring it would blame whatever sits there now.
    const lines = unresolvedThreadLinesByFile([thread({ id: "stale", outdated: true })]);
    expect(lines.size).toBe(0);
  });
});

describe("review work queue", () => {
  it("sorts actionable human inline feedback before automation and review history", () => {
    const input = [
      thread({ id: "resolved", resolved: true }),
      thread({ id: "outdated", outdated: true }),
      thread({
        id: "bot",
        comments: [
          {
            author: { username: "quality-bot", display_name: "Quality Bot", avatar_url: null },
            body_markdown: "Automated suggestion",
            created_at: "2026-07-20T09:00:00Z",
            url: null,
          },
        ],
      }),
      thread({ id: "general", file: null, line: null }),
      thread({ id: "human" }),
    ];
    const ordered = unresolvedThreads(input);

    expect(ordered.map((item) => item.id)).toEqual(["human", "bot", "general", "outdated"]);
    expect(sortReviewThreadsForAction(input).map((item) => item.id)).toEqual([
      "human",
      "bot",
      "general",
      "outdated",
      "resolved",
    ]);
  });

  it("recognizes common bot identities without depending on a forge provider", () => {
    expect(
      isAutomatedReviewThread(
        thread({
          comments: [
            {
              author: { username: "renovate[bot]", display_name: "Renovate", avatar_url: null },
              body_markdown: "Update this dependency.",
              created_at: "2026-07-20T09:00:00Z",
              url: null,
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(isAutomatedReviewThread(thread())).toBe(false);
  });

  it("summarizes navigable, general, outdated, automated, and per-file work", () => {
    const summary = summarizeReviewThreads([
      thread({ id: "inline-a" }),
      thread({ id: "inline-b", line: 20 }),
      thread({ id: "general", file: null, line: null }),
      thread({ id: "outdated", outdated: true }),
      thread({
        id: "bot",
        file: "src/bot.ts",
        comments: [
          {
            author: { username: "review_bot", display_name: null, avatar_url: null },
            body_markdown: "Automated suggestion.",
            created_at: "2026-07-20T09:00:00Z",
            url: null,
          },
        ],
      }),
    ]);

    expect(summary).toMatchObject({
      total: 5,
      anchored: 3,
      general: 1,
      outdated: 1,
      automated: 1,
    });
    expect([...summary.byFile]).toEqual([
      ["src/app.ts", 2],
      ["src/bot.ts", 1],
    ]);
  });

  it("builds only safe current-diff navigation targets", () => {
    expect(
      reviewNavigationTargets([
        thread({ id: "current", side: null }),
        thread({ id: "old", side: "old", line: 8 }),
        thread({ id: "general", file: null, line: null }),
        thread({ id: "outdated", outdated: true }),
      ]),
    ).toEqual([
      { threadId: "current", filePath: "src/app.ts", lineNumber: 12, side: "new" },
      { threadId: "old", filePath: "src/app.ts", lineNumber: 8, side: "old" },
    ]);
  });

  it("derives provider-aware external action labels from the comment URL", () => {
    expect(threadExternalHost(thread())).toBe("forge.test");
    expect(
      threadExternalHost(
        thread({
          comments: [
            {
              author: { username: "alice", display_name: null, avatar_url: null },
              body_markdown: "Open this.",
              created_at: "2026-07-20T09:00:00Z",
              url: "https://www.gitlab.example/group/project/-/merge_requests/3#note_1",
            },
          ],
        }),
      ),
    ).toBe("gitlab.example");
  });
});

describe("formatPrThreadsForAgent", () => {
  it("names the reviewer behind every comment", () => {
    const message = formatPrThreadsForAgent([thread()], PR, asIs);

    expect(message).toContain("Pull request #17 — Add forge support");
    expect(message).toContain("### src/app.ts:12");
    expect(message).toContain("- **Alice Ng:** Handle the empty case.");
    expect(message).toContain("<https://forge.test/pr/1#c1>");
  });

  it("falls back to the username when the forge has no display name", () => {
    const anonymous = thread({
      comments: [
        {
          author: { username: "bob", display_name: null, avatar_url: null },
          body_markdown: "Rename this.",
          created_at: "2026-07-20T09:00:00Z",
          url: null,
        },
      ],
    });
    expect(formatPrThreadsForAgent([anonymous], PR, asIs)).toContain("- **bob:** Rename this.");
  });

  it("indents a multi-line body so it stays inside its bullet", () => {
    const multiline = thread({
      comments: [
        {
          author: { username: "alice", display_name: null, avatar_url: null },
          body_markdown: "First line.\n\nSecond line.",
          created_at: "2026-07-20T09:00:00Z",
          url: null,
        },
      ],
    });
    expect(formatPrThreadsForAgent([multiline], PR, asIs)).toContain(
      "- **alice:** First line.\n  \n  Second line.",
    );
  });

  it("labels the two anchors an agent would otherwise misread", () => {
    const message = formatPrThreadsForAgent(
      [thread({ side: "old", outdated: true }), thread({ id: "general", file: null, line: null })],
      PR,
      asIs,
    );
    expect(message).toContain("(on the removed side)");
    expect(message).toContain("outdated, the diff moved since");
    expect(message).toContain("### General discussion");
  });

  it("names files the way an agent in a monorepo subdirectory resolves them", () => {
    const mapping = { prefix: "packages/app", root: "/repo" };
    const message = formatPrThreadsForAgent(
      [
        thread({ file: "packages/app/src/app.ts" }),
        thread({ id: "root", file: "README.md", line: 3 }),
      ],
      PR,
      (path) => gitPathForAgent(path, mapping),
    );
    expect(message).toContain("### src/app.ts:12");
    expect(message).toContain("### /repo/README.md:3");
    expect(message).not.toContain("packages/app/src/app.ts");
  });

  it("returns nothing to send when every thread is resolved", () => {
    expect(unresolvedThreads([thread({ resolved: true })])).toHaveLength(0);
    expect(formatPrThreadsForAgent([thread({ resolved: true })], PR, asIs)).toBe("");
  });
});
