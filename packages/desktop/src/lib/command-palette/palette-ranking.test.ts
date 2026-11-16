import { describe, expect, it } from "vitest";
import type { ConversationIndexEntry } from "@/api/generated";
import { emptyStateSections, rankConversations, type RankContext } from "./palette-ranking";
import { queryTokens } from "./palette-score";

const NOW = Date.parse("2026-10-23T12:00:00Z");

function conversation(id: number, title: string, extra: Partial<ConversationIndexEntry> = {}) {
  return {
    id,
    project_id: 1,
    title,
    status: "active",
    is_pinned: false,
    created_at: "2026-10-01 10:00:00",
    last_activity_at: "2026-10-20 10:00:00",
    ...extra,
  } satisfies ConversationIndexEntry;
}

function context(extra: Partial<RankContext> = {}): RankContext {
  return {
    now: NOW,
    activeProjectId: 1,
    activeFeatureId: null,
    scope: "all",
    frecency: {},
    attention: new Map(),
    projectNames: new Map([
      [1, "cadencr"],
      [2, "pianr-main"],
    ]),
    ...extra,
  };
}

const titles = (ranked: { entries: { conversation: ConversationIndexEntry }[] }) =>
  ranked.entries.map((entry) => entry.conversation.title);

describe("rankConversations", () => {
  it("ranks an archived conversation below an active one of equal match", () => {
    const list = [
      conversation(1, "Fix sidebar issue", { status: "archived" }),
      conversation(2, "Fix sidebar layout"),
    ];
    expect(titles(rankConversations(queryTokens("sidebar"), list, context(), 10))).toEqual([
      "Fix sidebar layout",
      "Fix sidebar issue",
    ]);
  });

  it("still finds archived conversations", () => {
    const list = [conversation(1, "Polish Agent View UX", { status: "archived" })];
    expect(
      rankConversations(queryTokens("polish agent view"), list, context(), 10).entries,
    ).toHaveLength(1);
  });

  it("finds a conversation by project name, label and branch", () => {
    const list = [
      conversation(1, "Release", {
        project_id: 2,
        label: "FINISHING",
        worktree_branch: "feat/notes",
      }),
    ];
    for (const query of ["pianr", "finishing", "feat/notes"]) {
      expect(rankConversations(queryTokens(query), list, context(), 10).entries).toHaveLength(1);
    }
  });

  it("honours the scope", () => {
    const list = [
      conversation(1, "Deploy", { project_id: 2 }),
      conversation(2, "Deploy again", { status: "archived" }),
    ];
    expect(
      titles(rankConversations(queryTokens("deploy"), list, context({ scope: "project" }), 10)),
    ).toEqual(["Deploy again"]);
    expect(
      titles(rankConversations(queryTokens("deploy"), list, context({ scope: "active" }), 10)),
    ).toEqual(["Deploy"]);
  });

  it("lifts a conversation picked recently", () => {
    const list = [conversation(1, "Deploy staging"), conversation(2, "Deploy prod")];
    const picked = context({ frecency: { "conv:2": { count: 4, at: NOW } } });
    expect(titles(rankConversations(queryTokens("deploy"), list, picked, 10))[0]).toBe(
      "Deploy prod",
    );
  });
});

describe("emptyStateSections", () => {
  it("lists what needs the user, agents at work, then recent conversations without the open one", () => {
    const list = [
      conversation(1, "Open now", { last_activity_at: "2026-10-23 11:00:00" }),
      conversation(2, "Waiting"),
      conversation(3, "Working"),
      conversation(4, "Came from", { last_activity_at: "2026-10-23 10:00:00" }),
      conversation(5, "Old archived", { status: "archived" }),
    ];
    const sections = emptyStateSections(
      {
        conversations: list,
        // An unread mark can outlive its conversation's archiving.
        nextActions: [
          { featureId: 2, kind: "waiting" },
          { featureId: 5, kind: "review" },
        ],
        suggestions: [],
      },
      context({ activeFeatureId: 1, attention: new Map([[3, "working"]]) }),
    );
    expect(
      sections.map((section) => [section.id, section.entries.map((entry) => entry.key)]),
    ).toEqual([
      ["needs-you", ["conv:2"]],
      ["in-progress", ["conv:3"]],
      ["recent", ["conv:4"]],
    ]);
  });
});
