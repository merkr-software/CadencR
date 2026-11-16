import { describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent } from "@/test-utils";
import { GitTabToggle } from "./GitTabToggle";

function spinnerOn(tabName: string): Element | null {
  return screen.getByRole("tab", { name: tabName }).querySelector(".animate-spin");
}

describe("GitTabToggle", () => {
  it("renders the first-rank views with the target branch interpolated", () => {
    render(<GitTabToggle value="uncommitted" onChange={vi.fn()} targetBranch="main" />);
    expect(screen.getByRole("tab", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "vs main" })).toBeInTheDocument();
  });

  it("falls back to 'vs target' when no branch is supplied", () => {
    render(<GitTabToggle value="uncommitted" onChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "vs target" })).toBeInTheDocument();
  });

  it("marks the active tab via aria-selected", () => {
    render(<GitTabToggle value="vs-target" onChange={vi.fn()} targetBranch="develop" />);
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "vs develop" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("calls onChange with the matching value when a tab is clicked", () => {
    const onChange = vi.fn();
    render(<GitTabToggle value="uncommitted" onChange={onChange} targetBranch="main" />);
    fireEvent.click(screen.getByRole("tab", { name: "vs main" }));
    expect(onChange).toHaveBeenCalledWith("vs-target");
  });

  it("keeps the icon-only second-rank views named for assistive tech", () => {
    const onChange = vi.fn();
    render(<GitTabToggle value="graph" onChange={onChange} targetBranch="main" />);
    const graphTab = screen.getByRole("tab", { name: "Commits" });
    expect(graphTab).toHaveAttribute("aria-selected", "true");
    fireEvent.click(graphTab);
    // Clicking the already-active tab still reports its value to the parent.
    expect(onChange).toHaveBeenCalledWith("graph");
    expect(screen.getByRole("tab", { name: "Branches" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Stashes" })).toBeInTheDocument();
  });

  it("names the proposal tab by number once one exists", () => {
    const onChange = vi.fn();
    render(
      <GitTabToggle
        value="uncommitted"
        onChange={onChange}
        prLabel="Merge request"
        prNumber={128}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Merge request #128" }));
    expect(onChange).toHaveBeenCalledWith("pr");
  });

  it("counts the conversation's other open proposals beside its own", () => {
    render(
      <GitTabToggle
        value="uncommitted"
        onChange={vi.fn()}
        prNumber={128}
        prOtherCount={2}
        prOtherTone="danger"
      />,
    );
    const others = screen
      .getByRole("tab", { name: "Pull request #128" })
      .querySelector("[data-pr-tab-others]")!;
    expect(others).toHaveTextContent("+2");
    expect(others.className).toContain("--acc-red");
  });

  it("falls back to the backend's proposal noun when there is no proposal yet", () => {
    render(<GitTabToggle value="uncommitted" onChange={vi.fn()} prLabel="MR" />);
    expect(screen.getByRole("tab", { name: "MR" })).toBeInTheDocument();
  });

  it("badges the working-tree change count, and conflicts ahead of it", () => {
    const { rerender } = render(
      <GitTabToggle value="uncommitted" onChange={vi.fn()} uncommittedCount={8} />,
    );
    expect(screen.getByTitle("8 uncommitted changes")).toHaveTextContent("8");

    rerender(
      <GitTabToggle
        value="uncommitted"
        onChange={vi.fn()}
        uncommittedCount={8}
        conflictCount={2}
      />,
    );
    // An unmerged path stops everything else, so it takes the slot from the
    // change total rather than sitting beside it.
    expect(screen.getByTitle("2 conflicted files")).toHaveTextContent("2");
    expect(screen.queryByTitle("8 uncommitted changes")).not.toBeInTheDocument();
  });

  it("announces the badge's state, which aria-label would otherwise hide", () => {
    // `aria-label` replaces the whole subtree, so a reader who cannot see the
    // red pill has to get the conflict count from the tab's own name.
    const { rerender } = render(
      <GitTabToggle value="uncommitted" onChange={vi.fn()} uncommittedCount={8} />,
    );
    expect(screen.getByRole("tab", { name: "Changes, 8 uncommitted changes" })).toBeInTheDocument();

    rerender(
      <GitTabToggle
        value="uncommitted"
        onChange={vi.fn()}
        uncommittedCount={8}
        conflictCount={2}
      />,
    );
    expect(screen.getByRole("tab", { name: "Changes, 2 conflicted files" })).toBeInTheDocument();
  });

  it("keeps the proposal noun in the accessible name once the label is just a number", () => {
    render(
      <GitTabToggle value="uncommitted" onChange={vi.fn()} prLabel="Merge request" prNumber={9} />,
    );
    // Visibly "#9" to save room in the strip; "#9" alone is not a name.
    expect(screen.getByRole("tab", { name: "Merge request #9" })).toHaveTextContent("#9");
  });

  it("moves the spinner to the newly pending tab instead of stranding it", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <GitTabToggle value="uncommitted" onChange={vi.fn()} pendingValue="pr" prNumber={7} />,
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(spinnerOn("Pull request #7")).not.toBeNull();

      // Switching targets mid-save used to leave the spinner on the tab you had
      // just left for a further full delay, pointing at the wrong save.
      rerender(
        <GitTabToggle value="uncommitted" onChange={vi.fn()} pendingValue="graph" prNumber={7} />,
      );
      expect(spinnerOn("Pull request #7")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(spinnerOn("Commits")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals the tab's keyboard shortcut on hover", () => {
    render(<GitTabToggle value="uncommitted" onChange={vi.fn()} prLabel="Pull request" />);

    fireEvent.mouseEnter(screen.getByRole("tab", { name: "Pull request" }).parentElement!);

    const tip = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
    expect(tip).toHaveTextContent("Pull request status, checks, and comments");
    // ⌘P — the binding registered for `git-show-pull-request`.
    expect(tip).toHaveTextContent("P");
  });

  it("marks only the tab whose save is in flight, leaving the rest clickable", () => {
    const onChange = vi.fn();
    render(
      <GitTabToggle
        value="uncommitted"
        onChange={onChange}
        targetBranch="main"
        pendingValue="pr"
      />,
    );

    // A persisted preference must never read as "the whole strip stopped
    // responding" — the other views stay live while one save lands.
    fireEvent.click(screen.getByRole("tab", { name: "vs main" }));
    expect(onChange).toHaveBeenCalledWith("vs-target");
    expect(screen.getByRole("tab", { name: "Changes" })).toBeEnabled();
  });

  it("does not flash a spinner over the icon of a save that lands immediately", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <GitTabToggle value="uncommitted" onChange={vi.fn()} pendingValue="pr" prNumber={7} />,
      );
      // The spinner takes the icon's slot. A save against the local database
      // resolves in a couple of frames, so showing it on click swapped the
      // glyph out and back fast enough to read as the icon blinking.
      expect(spinnerOn("Pull request #7")).toBeNull();

      rerender(<GitTabToggle value="pr" onChange={vi.fn()} pendingValue={null} prNumber={7} />);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(spinnerOn("Pull request #7")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still marks a save that is genuinely taking time", () => {
    vi.useFakeTimers();
    try {
      render(
        <GitTabToggle value="uncommitted" onChange={vi.fn()} pendingValue="pr" prNumber={7} />,
      );
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(spinnerOn("Pull request #7")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
