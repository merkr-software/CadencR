import { describe, it, expect } from "vitest";
import { act, render, screen } from "@/test-utils";
import { uiI18n } from "@/lib/i18n/ui";
import { CollapsibleBlock } from "./collapsible-block";

describe("CollapsibleBlock", () => {
  it("renders header and children", () => {
    render(
      <CollapsibleBlock
        totalCount={3}
        visibleCount={5}
        formatHiddenCount={(count) => `${count} items above`}
        header={<span>Header</span>}
      >
        {() => <div>All items</div>}
      </CollapsibleBlock>,
    );
    expect(screen.getByText("Header")).toBeInTheDocument();
    expect(screen.getByText("All items")).toBeInTheDocument();
  });

  it("shows toggle button when totalCount > visibleCount", () => {
    render(
      <CollapsibleBlock
        totalCount={10}
        visibleCount={3}
        formatHiddenCount={(count) => `${count} lines above`}
        header={<span>H</span>}
      >
        {() => <div>Content</div>}
      </CollapsibleBlock>,
    );
    expect(screen.getByRole("button", { name: /show all 10/i })).toBeInTheDocument();
  });

  it("does not show toggle when count is within visible range", () => {
    render(
      <CollapsibleBlock
        totalCount={3}
        visibleCount={5}
        formatHiddenCount={(count) => `${count} lines above`}
        header={<span>H</span>}
      >
        {() => <div>Content</div>}
      </CollapsibleBlock>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows truncation indicator when collapsed", () => {
    render(
      <CollapsibleBlock
        totalCount={10}
        visibleCount={3}
        formatHiddenCount={(count) => `${count} actions above`}
        header={<span>H</span>}
      >
        {() => <div>Content</div>}
      </CollapsibleBlock>,
    );
    expect(screen.getByText(/7 actions above/)).toBeInTheDocument();
  });

  it("expands to show all on button click", async () => {
    const { user } = render(
      <CollapsibleBlock
        totalCount={10}
        visibleCount={3}
        formatHiddenCount={(count) => `${count} lines above`}
        header={<span>H</span>}
      >
        {({ showAll }) => <div>{showAll ? "showing all" : "collapsed"}</div>}
      </CollapsibleBlock>,
    );
    expect(screen.getByText("collapsed")).toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(screen.getByText("showing all")).toBeInTheDocument();
  });

  it("updates the label without folding expanded output after a language change", async () => {
    const { user } = render(
      <CollapsibleBlock
        totalCount={10}
        visibleCount={3}
        formatHiddenCount={() => "Truncated output"}
        header={<span>Output</span>}
      >
        {({ showAll }) => <div>{showAll ? "Expanded output" : "Collapsed output"}</div>}
      </CollapsibleBlock>,
    );
    await user.click(screen.getByRole("button", { name: "Show all 10" }));
    const toggle = screen.getByRole("button", { name: "Show last 3" });

    uiI18n.addResourceBundle("fr", "ui", {
      conversation: { stream: { collapsibleBlock: { showLast: "Dernières lignes ({{count}})" } } },
    });
    try {
      await act(() => uiI18n.changeLanguage("fr"));
      expect(screen.getByRole("button", { name: "Dernières lignes (3)" })).toBe(toggle);
      expect(screen.getByText("Expanded output")).toBeVisible();
    } finally {
      await act(() => uiI18n.changeLanguage("en"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
  });
});
