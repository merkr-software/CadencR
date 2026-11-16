import { describe, expect, it } from "vitest";
import type { TabKind } from "@/stores/feature-layout-schema";
import { createNavigationHistory, type NavigationEntry } from "./navigation-history";

const page = (href: string): NavigationEntry => ({ kind: "page", href });
const session = (featureId: number, tab: TabKind = "agent"): NavigationEntry => ({
  kind: "session",
  sessionId: `ws-${featureId}`,
  search: { cwd: "/repo", featureId, projectId: 1 },
  tab,
});

describe("navigation history", () => {
  it("walks back and forward across conversations and their focused tab", () => {
    const history = createNavigationHistory();
    history.record(session(1));
    history.record(session(2));
    const here = session(2, "browser");
    history.record(here);

    expect(history.go(-1, here)).toEqual(session(2));
    history.record(session(2));
    expect(history.go(-1, session(2))).toEqual(session(1));
    history.record(session(1));
    expect(history.go(1, session(1))).toEqual(session(2));
    history.record(session(2));
    expect(history.go(1, session(2))).toEqual(here);
  });

  it("returns null at either end", () => {
    const history = createNavigationHistory();
    history.record(page("/settings"));
    expect(history.go(-1, page("/settings"))).toBeNull();
    expect(history.go(1, page("/settings"))).toBeNull();
  });

  it("does not stack the same spot twice", () => {
    const history = createNavigationHistory();
    history.record(session(1));
    history.record(page("/settings"));
    history.record(page("/settings"));
    expect(history.go(-1, page("/settings"))).toEqual(session(1));
  });

  it("refreshes a spot whose search changed without stacking it again", () => {
    const history = createNavigationHistory();
    const moved: NavigationEntry = {
      kind: "session",
      sessionId: "ws-1",
      search: { cwd: "/repo/worktree", featureId: 1, projectId: 1 },
      tab: "agent",
    };
    history.record(session(1));
    history.record(moved);
    history.record(page("/settings"));

    expect(history.go(-1, page("/settings"))).toEqual(moved);
    history.arrive(moved);
    expect(history.go(-1, moved)).toBeNull();
  });

  it("drops forward entries when the user goes somewhere new after going back", () => {
    const history = createNavigationHistory();
    history.record(session(1));
    history.record(session(2));
    history.go(-1, session(2));
    history.record(session(1));
    history.record(session(3));
    expect(history.go(1, session(3))).toBeNull();
    expect(history.go(-1, session(3))).toEqual(session(1));
  });

  it("records a spot the user has not settled on yet before going back", () => {
    const history = createNavigationHistory();
    history.record(session(1));
    expect(history.go(-1, session(2))).toEqual(session(1));
    expect(history.go(1, session(1))).toEqual(session(2));
  });

  it("records a spot the user opens right after a jump landed", () => {
    const history = createNavigationHistory();
    history.record(session(1));
    history.record(session(2));
    history.record(session(3));
    history.go(-1, session(3));
    history.arrive(session(2));
    // ws-4 is opened and left before it settles.
    expect(history.go(-1, session(4))).toEqual(session(2));
    history.arrive(session(2));
    expect(history.go(1, session(2))).toEqual(session(4));
  });

  it("keeps stepping back while a previous jump is still landing", () => {
    const history = createNavigationHistory();
    history.record(session(1));
    history.record(session(2));
    history.record(session(3));
    expect(history.go(-1, session(3))).toEqual(session(2));
    // The router has not reached ws-2 yet: the in-between spot is not recorded.
    expect(history.go(-1, session(3))).toEqual(session(1));
    history.record(session(1));
    expect(history.go(1, session(1))).toEqual(session(2));
  });
});
