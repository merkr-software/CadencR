import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import type { PrStatusSnapshot } from "@/api/generated";
import { threadPrs } from "@/lib/thread-prs";
import { FeaturePrIndicator, prIndicatorTone, prStatusLabel } from "./PrStatusIndicators";

function snapshot(
  overrides: Partial<PrStatusSnapshot> = {},
  prOverrides: Partial<NonNullable<PrStatusSnapshot["pr"]>> = {},
): PrStatusSnapshot {
  return {
    setup_required: false,
    feature_id: 20,
    fetched_at: 1,
    error: null,
    ci: { state: "passing", checks: [] },
    pr: {
      author: { username: "reviewer" },
      body_markdown: "",
      head_sha: "abc",
      number: 20,
      pr_label: "Pull request",
      review_state: "approved",
      source_branch: "feature",
      state: "open",
      target_branch: "main",
      title: "Status colors",
      updated_at: "2026-07-24T00:00:00Z",
      url: "https://example.test/pr/20",
      ...prOverrides,
    },
    ...overrides,
  };
}

describe("prIndicatorTone", () => {
  it("uses green only for merged pull requests", () => {
    expect(prIndicatorTone(snapshot({}, { state: "merged" }))).toBe("merged");
  });

  it("uses orange for review and merge blockers", () => {
    expect(prIndicatorTone(snapshot({}, { review_state: "changes_requested" }))).toBe("blocked");
    expect(prIndicatorTone(snapshot({}, { review_state: "pending" }))).toBe("blocked");
    expect(prIndicatorTone(snapshot({}, { state: "draft" }))).toBe("blocked");
    expect(prIndicatorTone(snapshot({ ci: { state: "running", checks: [] } }))).toBe("blocked");
  });

  it("uses red for failed checks and blue when no blocker is reported", () => {
    expect(prIndicatorTone(snapshot({ ci: { state: "failing", checks: [] } }))).toBe("danger");
    expect(prIndicatorTone(snapshot())).toBe("ready");
    expect(prIndicatorTone(snapshot({ ci: { state: "none", checks: [] } }))).toBe("ready");
  });

  it("lets a failing check outrank a review blocker, since the chip is the only slot", () => {
    // Awaiting review is the most common state to be in while checks fail; if
    // orange won, red CI would be invisible in the sidebar.
    expect(
      prIndicatorTone(
        snapshot({ ci: { state: "failing", checks: [] } }, { review_state: "pending" }),
      ),
    ).toBe("danger");
    expect(
      prIndicatorTone(
        snapshot({ ci: { state: "failing", checks: [] } }, { review_state: "changes_requested" }),
      ),
    ).toBe("danger");
    expect(prIndicatorTone(snapshot({ error: "Bad credentials" }))).toBe("danger");
  });

  it("uses yellow when the checks are green but reviewers are still waiting", () => {
    expect(prIndicatorTone(snapshot({ unresolved_threads: 2 }))).toBe("unresolved");
    // Outranks the review-state blockers: green checks plus open threads is a
    // different call to action than "nobody has looked yet".
    expect(
      prIndicatorTone(snapshot({ unresolved_threads: 1 }, { review_state: "changes_requested" })),
    ).toBe("unresolved");
  });

  it("treats an unknown thread count as unknown rather than zero", () => {
    // The poller only looks the count up for green PRs, so `undefined` must not
    // read as "nothing left to answer" and flip the chip to ready-blue early.
    expect(prIndicatorTone(snapshot({ unresolved_threads: undefined }))).toBe("ready");
    expect(prIndicatorTone(snapshot({ unresolved_threads: 0 }))).toBe("ready");
  });

  it("keeps failing checks and drafts ahead of unresolved threads", () => {
    expect(
      prIndicatorTone(snapshot({ ci: { state: "failing", checks: [] }, unresolved_threads: 3 })),
    ).toBe("danger");
    expect(prIndicatorTone(snapshot({ unresolved_threads: 3 }, { state: "draft" }))).toBe(
      "blocked",
    );
  });

  it("names the outstanding threads in the chip tooltip", () => {
    const label = (overrides?: Partial<PrStatusSnapshot>): string =>
      prStatusLabel(threadPrs(snapshot(overrides))[0]!);
    expect(label({ unresolved_threads: 2 })).toContain("2 unresolved threads");
    expect(label({ unresolved_threads: 1 })).toContain("1 unresolved thread");
    expect(label()).not.toContain("unresolved");
  });
});

describe("FeaturePrIndicator", () => {
  it("renders a right-side viewport-safe tooltip for the sidebar chip", () => {
    render(<FeaturePrIndicator snapshot={snapshot()} />);
    const chip = screen.getByLabelText("Pull request #20 · approved · checks passing");
    fireEvent.mouseEnter(chip.parentElement!);
    const tip = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
    const positioner = tip.parentElement!;
    expect(tip).toHaveTextContent("Pull request #20 · approved · checks passing");
    expect(positioner.style.position).toBe("fixed");
    expect(tip.className).toContain("max-w-[calc(100vw-1rem)]");
    expect(positioner.parentElement).toBe(document.body);
  });

  it("stays flat once the checks have settled", () => {
    render(<FeaturePrIndicator snapshot={snapshot()} />);

    expect(screen.getByLabelText(/^Pull request #20/).className).not.toContain(
      "pr-chip-checks-running",
    );
  });

  it("breathes only while checks are still running", () => {
    render(<FeaturePrIndicator snapshot={snapshot({ ci: { state: "running", checks: [] } })} />);

    expect(screen.getByLabelText(/^Pull request #20/).className).toContain(
      "pr-chip-checks-running",
    );
  });

  it("keeps a host error visible when no proposal was found", () => {
    render(<FeaturePrIndicator snapshot={snapshot({ pr: null, error: "Bad credentials" })} />);

    expect(screen.getByLabelText("Forge status error: Bad credentials")).toBeInTheDocument();
  });

  it("stays silent about a forge the user never connected", () => {
    // The reason is written for the PR pane's onboarding prompt. Painting it as
    // a red dot here would mark every row on a fresh install as broken.
    const { container } = render(
      <FeaturePrIndicator
        snapshot={snapshot({
          pr: null,
          setup_required: true,
          error: "Add an API token for github.com to load pull requests, checks, and comments.",
        })}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("counts the conversation's other open proposals and names them in the tooltip", () => {
    const base = snapshot();
    const other = (number: number, state: "open" | "merged", ci: "failing" | "passing") => ({
      branch: `fix/${number}`,
      pr: { ...base.pr!, number, state, source_branch: `fix/${number}` },
      ci: { state: ci, checks: [] },
    });
    render(
      <FeaturePrIndicator
        snapshot={{
          ...base,
          other_prs: [other(21, "open", "failing"), other(19, "merged", "passing")],
        }}
      />,
    );

    const chip = screen.getByLabelText(/^Pull request #20/);
    // Only the open one counts; the merged one is history.
    expect(chip.querySelector("[data-feature-pr-others]")).toHaveTextContent("+1");
    expect(chip.querySelector("[data-feature-pr-others]")!.className).toContain("--acc-red");
    expect(chip).toHaveAccessibleName(
      "Pull request #20 · approved · checks passing; fix/21: Pull request #21 · approved · checks failing",
    );
  });

  it("shows another branch's proposal when the current branch has none", () => {
    const base = snapshot();
    render(
      <FeaturePrIndicator
        snapshot={{
          ...base,
          pr: null,
          ci: null,
          other_prs: [{ branch: "fix/21", pr: { ...base.pr!, number: 21 }, ci: null }],
        }}
      />,
    );
    expect(screen.getByLabelText(/^fix\/21: Pull request #21/)).toBeInTheDocument();
  });

  function twoProposals(): PrStatusSnapshot {
    const base = snapshot();
    return {
      ...base,
      other_prs: [
        {
          branch: "fix/flaky-retry",
          pr: { ...base.pr!, number: 21 },
          ci: { state: "failing", checks: [] },
        },
      ],
    };
  }

  it("gives every proposal its own tooltip line", async () => {
    render(<FeaturePrIndicator snapshot={twoProposals()} />);

    fireEvent.mouseEnter(document.querySelector("[data-feature-pr]")!.parentElement!);

    const lines = await screen.findAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toHaveTextContent("#21");
    // The tail is what tells two branches of one conversation apart.
    expect(lines[1]).toHaveTextContent("flaky-retry");
    expect(lines[1]).not.toHaveTextContent("fix/");
    expect(lines[1]).toHaveTextContent("checks failing");
  });

  it("opens the proposal it shows, without the row navigating first", () => {
    const onOpen = vi.fn();
    const rowPointerDown = vi.fn();
    const base = snapshot();
    render(
      <div onPointerDown={rowPointerDown}>
        <FeaturePrIndicator
          snapshot={{ ...base, pr: null, ci: null, other_prs: twoProposals().other_prs }}
          onOpen={onOpen}
        />
      </div>,
    );
    const button = screen.getByRole("button", { name: /^Open Pull request #21 in the Git tab/ });

    fireEvent.pointerDown(button);
    fireEvent.click(button);

    expect(rowPointerDown).not.toHaveBeenCalled();
    // Another branch's proposal is named by number; the current one is `null`.
    expect(onOpen).toHaveBeenCalledWith(21);
  });

  it("opens the current branch's proposal as the current one", () => {
    const onOpen = vi.fn();
    render(<FeaturePrIndicator snapshot={twoProposals()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /^Open Pull request #\d+ in the Git tab/ }));
    expect(onOpen).toHaveBeenCalledWith(null);
  });
});
