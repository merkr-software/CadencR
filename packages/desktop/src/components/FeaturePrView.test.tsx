import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import type { CommentThread, PrStatusSnapshot } from "@/api/generated";
import type { PrReviewThreads } from "@/hooks/usePrReviewThreads";
import { usePrStatusStore } from "@/stores/usePrStatusStore";
import { useViewedPrStore } from "@/stores/viewed-pr-store";
import { FeaturePrView } from "./FeaturePrView";

const navigateMock = vi.hoisted(() => vi.fn());
const hydrateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("@/stores/pr-status-hydration", () => ({ hydratePrStatuses: hydrateMock }));

function snapshot(): PrStatusSnapshot {
  return {
    setup_required: false,
    feature_id: 42,
    fetched_at: 1,
    error: null,
    ci: { state: "passing", checks: [] },
    pr: {
      author: { username: "reviewer" },
      body_markdown: "",
      head_sha: "abc",
      number: 42,
      pr_label: "Pull request",
      review_state: "approved",
      source_branch: "feature/x",
      state: "open",
      target_branch: "main",
      title: "Pinned band",
      updated_at: "2026-07-24T00:00:00Z",
      url: "https://example.test/pr/42",
    },
  };
}

const REVIEWS: PrReviewThreads = {
  threads: [],
  unresolved: [],
  unresolvedCount: 0,
  unresolvedLinesByFile: new Map(),
  navigationTargets: [],
  summary: {
    total: 0,
    anchored: 0,
    general: 0,
    outdated: 0,
    automated: 0,
    byFile: new Map(),
  },
  isLoading: false,
  isRefreshing: false,
  errorMessage: undefined,
  retry: () => undefined,
};

describe("FeaturePrView pinned band", () => {
  beforeEach(() => {
    usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
    usePrStatusStore.getState().setStatus(snapshot());
  });

  it("forwards a wheel gesture over the pinned band to the thread scroller", () => {
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);
    const band = screen.getByRole("heading", { name: "Pinned band" }).closest("div.shrink-0")!;
    const scroller = band.nextElementSibling as HTMLElement;

    fireEvent.wheel(band, { deltaY: 180 });

    expect(scroller.scrollTop).toBe(180);
  });

  it("scales a line-mode wheel delta, which would otherwise scroll ~3px", () => {
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);
    const band = screen.getByRole("heading", { name: "Pinned band" }).closest("div.shrink-0")!;
    const scroller = band.nextElementSibling as HTMLElement;

    fireEvent.wheel(band, { deltaY: 3, deltaMode: 1 });

    expect(scroller.scrollTop).toBe(48);
  });

  it.each([180, -180])("keeps a wheel delta of %i over a check out of the comments", (deltaY) => {
    usePrStatusStore.getState().setStatus({
      ...snapshot(),
      fetched_at: 2,
      ci: { state: "failing", checks: [{ name: "build", state: "failing" }] },
    });
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);
    const band = screen.getByRole("heading", { name: "Pinned band" }).closest("div.shrink-0")!;
    const scroller = band.nextElementSibling as HTMLElement;
    scroller.scrollTop = 240;

    // Even a short check list must own its gesture. Wheel events on a row
    // used to bubble into the pinned band's manual forwarding handler.
    fireEvent.wheel(screen.getByText("build"), { deltaY });

    expect(scroller.scrollTop).toBe(240);
  });
});

describe("FeaturePrView unresolved chip", () => {
  beforeEach(() => {
    usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
    usePrStatusStore.getState().setStatus(snapshot());
  });

  it("toggles the filter off again, rather than pressing itself and sticking", () => {
    // "unresolved" is the default filter, so a one-way chip rendered pressed on
    // the first frame and its click was a no-op — a toggle that cannot be
    // un-pressed is a control that lies about being one.
    render(<FeaturePrView featureId={42} reviews={{ ...REVIEWS, unresolvedCount: 3 }} />);
    const chip = screen.getByRole("button", { name: /3 unresolved/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(chip);

    expect(screen.getByRole("button", { name: /3 unresolved/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("FeaturePrView refresh", () => {
  beforeEach(() => {
    hydrateMock.mockClear();
    usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
    usePrStatusStore.getState().setStatus(snapshot());
  });

  it("refreshes the status the band actually shows, not just the threads", () => {
    // The band displays checks, state, verdict and "updated N ago" — all from
    // the status store. Refetching only the comments left every one of them
    // stale, so the button did nothing a user could see.
    const retry = vi.fn();
    render(<FeaturePrView featureId={42} reviews={{ ...REVIEWS, retry }} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh from the forge" }));

    expect(retry).toHaveBeenCalledOnce();
    expect(hydrateMock).toHaveBeenCalledOnce();
  });
});

describe("FeaturePrView forge onboarding", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
  });

  function renderUnconnected(error: string | null): void {
    usePrStatusStore.getState().setStatus({
      ...snapshot(),
      pr: undefined,
      ci: undefined,
      setup_required: true,
      error,
    });
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);
  }

  it("sends the user to the forge card instead of the top of Git settings", () => {
    // The Git section opens on merge strategy, so landing there leaves the
    // remote-connections card several scrolls below the fold.
    renderUnconnected("Add an API token for github.com to load pull requests.");

    fireEvent.click(screen.getByRole("button", { name: "Connect a provider" }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: "/settings",
      search: { section: "git-remotes" },
    });
  });

  it("explains which host needs what, using the reason the backend gave", () => {
    renderUnconnected(
      "Choose which provider git.acme.test runs so Cadencr knows which API to call.",
    );

    expect(screen.getByText(/git\.acme\.test/)).toBeVisible();
  });

  it("still offers the button when the backend sent no reason", () => {
    renderUnconnected(null);

    expect(screen.getByRole("button", { name: "Connect a provider" })).toBeVisible();
    expect(screen.getByText(/can't reach the forge behind this remote/)).toBeVisible();
  });

  it("leaves a transient failure as an error, with nothing to connect", () => {
    // A rate limit is not an onboarding problem: offering "connect a provider"
    // for an already-connected forge sends the user to fix what isn't broken.
    usePrStatusStore.getState().setStatus({
      ...snapshot(),
      pr: undefined,
      ci: undefined,
      setup_required: false,
      error: "API rate limit exceeded",
    });
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);

    expect(screen.getByRole("alert")).toHaveTextContent("API rate limit exceeded");
    expect(screen.queryByRole("button", { name: "Connect a provider" })).toBeNull();
  });
});

function unresolvedThread(id: string): CommentThread {
  return {
    id,
    resolved: false,
    outdated: false,
    file: `src/${id}.ts`,
    line: 4,
    side: "new",
    comments: [
      {
        author: { username: "reviewer", display_name: null, avatar_url: null },
        body_markdown: `Please fix ${id}`,
        created_at: "2026-07-24T00:00:00Z",
        url: null,
      },
    ],
  };
}

function reviewsWith(threads: CommentThread[]): PrReviewThreads {
  return {
    ...REVIEWS,
    threads,
    unresolved: threads,
    unresolvedCount: threads.length,
    summary: { ...REVIEWS.summary, total: threads.length, anchored: threads.length },
  };
}

describe("FeaturePrView select-all", () => {
  const threads = [unresolvedThread("one"), unresolvedThread("two")];

  beforeEach(() => {
    usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
    usePrStatusStore.getState().setStatus(snapshot());
  });

  function renderWith(selected: string[], onAll = vi.fn()) {
    render(
      <FeaturePrView
        featureId={42}
        reviews={reviewsWith(threads)}
        selectedThreadIds={new Set(selected)}
        onThreadSelectedChange={vi.fn()}
        onAllThreadsSelectedChange={onAll}
      />,
    );
    return screen.getByRole("checkbox", { name: /pick all 2 unresolved threads for the agent/i });
  }

  it("takes every unresolved thread from an empty selection", () => {
    const onAll = vi.fn();
    fireEvent.click(renderWith([], onAll));
    expect(onAll).toHaveBeenCalledWith(true);
  });

  it("reads as partial while some threads are checked", () => {
    // Tri-state: after ticking a few by hand, a plain unchecked box would read
    // as "nothing picked". The running count lives in the send bar.
    expect(renderWith(["one"])).toHaveAttribute("data-state", "indeterminate");
  });

  it("clears the selection when every thread is already checked", () => {
    const onAll = vi.fn();
    const checkbox = renderWith(["one", "two"], onAll);

    expect(checkbox).toHaveAttribute("data-state", "checked");
    fireEvent.click(checkbox);
    expect(onAll).toHaveBeenCalledWith(false);
  });

  it("stays out of the way when nothing can be selected", () => {
    render(
      <FeaturePrView
        featureId={42}
        reviews={REVIEWS}
        onThreadSelectedChange={vi.fn()}
        onAllThreadsSelectedChange={vi.fn()}
      />,
    );
    // No name filter: an empty unresolved list must render no checkbox at all,
    // and matching on the old label would have passed for the wrong reason.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("keeps the checkbox mounted across a selection change, so focus survives", () => {
    // Virtuoso's Header used to be rebuilt whenever the selection changed. A
    // fresh function identity is a new component type to React, so the whole
    // header subtree remounted and the checkbox lost focus on every tick —
    // ticking two boxes in a row from the keyboard was impossible.
    const name = /pick all 2 unresolved threads for the agent/i;
    const { rerender } = render(
      <FeaturePrView
        featureId={42}
        reviews={reviewsWith(threads)}
        selectedThreadIds={new Set<string>()}
        onThreadSelectedChange={vi.fn()}
        onAllThreadsSelectedChange={vi.fn()}
      />,
    );
    const before = screen.getByRole("checkbox", { name });
    before.focus();
    expect(document.activeElement).toBe(before);

    rerender(
      <FeaturePrView
        featureId={42}
        reviews={reviewsWith(threads)}
        selectedThreadIds={new Set(["one"])}
        onThreadSelectedChange={vi.fn()}
        onAllThreadsSelectedChange={vi.fn()}
      />,
    );

    const after = screen.getByRole("checkbox", { name });
    expect(after).toBe(before);
    expect(document.activeElement).toBe(after);
    expect(after).toHaveAttribute("data-state", "indeterminate");
  });
});

describe("FeaturePrView proposal tabs", () => {
  function withOtherPr(overrides: Partial<PrStatusSnapshot> = {}): PrStatusSnapshot {
    const base = snapshot();
    return {
      ...base,
      other_prs: [
        {
          branch: "dependabot/actions/setup-node-7",
          pr: { ...base.pr!, number: 7, title: "Bump setup-node", source_branch: "x" },
          ci: { state: "failing", checks: [{ name: "lint", state: "failing" }] },
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
    useViewedPrStore.setState({ byFeature: {} });
  });

  it("shows no tabs while the conversation has a single proposal", () => {
    usePrStatusStore.getState().setStatus(snapshot());
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("swaps the pane to another branch's proposal instead of opening its host", () => {
    usePrStatusStore.getState().setStatus(withOtherPr());
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["#42x", "#7setup-node-7"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.click(tabs[1]!);

    expect(screen.getByRole("heading", { name: "Bump setup-node" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /#7/ })).toHaveAttribute("aria-selected", "true");
    // Its own checks, not the current proposal's.
    expect(screen.getByText("1 of 1 failing")).toBeInTheDocument();
    expect(useViewedPrStore.getState().byFeature[42]).toBe(7);
  });

  it("moves between proposals with the arrow keys", () => {
    usePrStatusStore.getState().setStatus(withOtherPr());
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);

    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "Bump setup-node" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "Pinned band" })).toBeInTheDocument();
  });

  it("keeps the current branch's tab when it has no proposal yet", () => {
    usePrStatusStore.getState().setStatus(withOtherPr({ pr: null, ci: null }));
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);

    expect(screen.getByText("No open pull request")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /#7/ }));
    expect(screen.getByRole("heading", { name: "Bump setup-node" })).toBeInTheDocument();
  });

  it("falls back to the current proposal once the picked one is gone", () => {
    useViewedPrStore.getState().setViewedPr(42, 99);
    usePrStatusStore.getState().setStatus(withOtherPr());
    render(<FeaturePrView featureId={42} reviews={REVIEWS} />);
    expect(screen.getByRole("heading", { name: "Pinned band" })).toBeInTheDocument();
  });
});
