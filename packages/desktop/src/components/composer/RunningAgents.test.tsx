import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { SubagentRun } from "@/api/generated";
import { SubagentCards } from "@/components/agent-session/subagent-cards";
import { SubagentLinkContext } from "@/components/agent-session/subagent-reveal";
import { act, render, screen } from "@/test-utils";
import { ComposerContextProvider, type ComposerContextValue } from "./ComposerContext";
import { RunningAgents } from "./RunningAgents";
import { LIST_AFTER_MS } from "./useSettledOffScreen";

const runs: { current: SubagentRun[] } = { current: [] };
vi.mock("@/hooks/useFeatureSubagents", () => ({
  useRunningSubagents: () => runs.current,
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

function run(overrides: Partial<SubagentRun>): SubagentRun {
  return {
    toolUseId: "toolu_1",
    sessionId: 9,
    status: "running",
    background: false,
    modelResolved: true,
    startedAt: "2026-10-31T10:00:00Z",
    ...overrides,
  };
}

/** Reports a card on screen as soon as it is observed, as a scroller would. */
class ShowingObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  root = null;
  observe = (target: Element): void => {
    this.callback(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  };
  unobserve = (): void => {};
  disconnect = (): void => {};
}

/** The list over a transcript whose revealer answers `reveal`. */
function renderList(reveal: (toolUseId: string) => boolean) {
  const cards = new SubagentCards();
  const scroller = document.createElement("div");
  cards.attach({ reveal, getScroller: () => scroller });
  const composer = { featureId: 1, sessionId: 9 } as unknown as ComposerContextValue;
  const view = render(
    <SubagentLinkContext.Provider value={{ cards, startJump: (run) => run() }}>
      <ComposerContextProvider value={composer}>
        <RunningAgents />
      </ComposerContextProvider>
    </SubagentLinkContext.Provider>,
  );
  // An agent out of view joins the list once it has stayed out for a moment.
  settle();
  /** A card scrolled into view. Returns its unmount (the card leaving). */
  const showCard = (toolUseId: string): (() => void) => {
    let untrack = (): void => {};
    act(() => {
      untrack = cards.track(document.createElement("section"), toolUseId);
    });
    return () => act(untrack);
  };
  return { ...view, showCard };
}

function settle(ms: number = LIST_AFTER_MS): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("RunningAgents", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", ShowingObserver);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(toast.info).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is absent while no sub-agent runs", () => {
    runs.current = [];
    renderList(vi.fn(() => true));
    expect(screen.queryByRole("region", { name: "Running agents" })).not.toBeInTheDocument();
  });

  it("lists each running sub-agent with its task, and flags background ones", () => {
    runs.current = [
      run({ toolUseId: "a", agentType: "Explore", description: "Map the router" }),
      run({
        toolUseId: "b",
        agentName: "reviewer",
        description: "Review the diff",
        background: true,
      }),
    ];
    renderList(vi.fn(() => true));
    const section = screen.getByRole("region", { name: "Running agents" });
    expect(section).toHaveTextContent("Running agents · 2");
    expect(
      screen.getByRole("button", { name: "Show Explore: Map the router in the conversation" }),
    ).toHaveTextContent("Map the router");
    expect(
      screen.getByRole("button", { name: "Show reviewer: Review the diff in the conversation" }),
    ).toHaveTextContent("background");
  });

  it("scrolls the transcript to the agent's card on click, and says so when it is not loaded", async () => {
    runs.current = [run({ toolUseId: "toolu_far", agentType: "Explore" })];
    const reveal = vi.fn(() => false);
    const { user } = renderList(reveal);
    await user.click(screen.getByRole("button", { name: "Show Explore in the conversation" }));
    expect(reveal).toHaveBeenCalledWith("toolu_far");
    expect(toast.info).toHaveBeenCalledWith(
      "That agent's card is not in the loaded conversation yet.",
    );
  });

  it("asks the transcript for the agent's card, quietly when it is there", async () => {
    runs.current = [run({ toolUseId: "toolu_near", agentType: "Explore" })];
    const reveal = vi.fn(() => true);
    const { user } = renderList(reveal);
    await user.click(screen.getByRole("button", { name: "Show Explore in the conversation" }));
    expect(reveal).toHaveBeenCalledWith("toolu_near");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("leaves out an agent whose card shows in the conversation, and goes when all do", () => {
    runs.current = [
      run({ toolUseId: "near", agentType: "Explore", description: "Map the router" }),
      run({ toolUseId: "far", agentType: "Plan", description: "Draft the steps" }),
    ];
    const { showCard } = renderList(vi.fn(() => true));
    showCard("near");
    expect(screen.getByRole("region", { name: "Running agents" })).toHaveTextContent(
      "Running agents · 1",
    );
    expect(screen.queryByRole("button", { name: /Map the router/ })).not.toBeInTheDocument();
    showCard("far");
    expect(screen.queryByRole("region", { name: "Running agents" })).not.toBeInTheDocument();
  });

  it("does not list an agent whose card dips out of view for less than the delay", () => {
    runs.current = [run({ toolUseId: "a", agentType: "Explore", description: "Map the router" })];
    const { showCard } = renderList(vi.fn(() => true));
    const hide = showCard("a");
    expect(screen.queryByRole("region", { name: "Running agents" })).not.toBeInTheDocument();
    // A card dipping out for a frame (a glide, a remount) moves nothing.
    hide();
    settle(LIST_AFTER_MS - 1);
    expect(screen.queryByRole("region", { name: "Running agents" })).not.toBeInTheDocument();
    showCard("a");
    settle();
    expect(screen.queryByRole("region", { name: "Running agents" })).not.toBeInTheDocument();
  });

  it("lists an agent whose card stays out of view after the delay", () => {
    runs.current = [run({ toolUseId: "a", agentType: "Explore", description: "Map the router" })];
    const { showCard } = renderList(vi.fn(() => true));
    const hide = showCard("a");
    hide();
    settle(LIST_AFTER_MS - 1);
    expect(screen.queryByRole("region", { name: "Running agents" })).not.toBeInTheDocument();
    settle(1);
    expect(screen.getByRole("region", { name: "Running agents" })).toHaveTextContent(
      "Running agents · 1",
    );
    showCard("a");
    expect(screen.queryByRole("region", { name: "Running agents" })).not.toBeInTheDocument();
  });

  it("keeps a listed agent while another agent's card comes and goes", () => {
    runs.current = [
      run({ toolUseId: "far", agentType: "Plan", description: "Draft the steps" }),
      run({ toolUseId: "near", agentType: "Explore", description: "Map the router" }),
    ];
    const { showCard } = renderList(vi.fn(() => true));
    const hideNear = showCard("near");
    expect(screen.getByRole("region", { name: "Running agents" })).toHaveTextContent(
      "Running agents · 1",
    );
    hideNear();
    settle(LIST_AFTER_MS / 2);
    expect(screen.getByRole("button", { name: /Draft the steps/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Map the router/ })).not.toBeInTheDocument();
    settle(LIST_AFTER_MS / 2);
    expect(screen.getByRole("region", { name: "Running agents" })).toHaveTextContent(
      "Running agents · 2",
    );
  });
});
