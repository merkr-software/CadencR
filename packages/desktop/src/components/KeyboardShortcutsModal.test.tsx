import { describe, expect, it } from "vitest";
import { act, render, screen, fireEvent } from "@/test-utils";
import { uiI18n } from "@/lib/i18n/ui";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";

describe("KeyboardShortcutsModal", () => {
  it("renders real shortcuts from the registry — sidebar, plan approval, and git", () => {
    render(<KeyboardShortcutsModal open onOpenChange={() => {}} projectId={null} />);

    expect(screen.getByText("Open focused item")).toBeInTheDocument();
    expect(screen.getByText("Approve plan")).toBeInTheDocument();
    expect(screen.getByText("Request plan changes (feedback)")).toBeInTheDocument();
    expect(screen.getByText("Reject plan")).toBeInTheDocument();
    expect(screen.getByText("Git actions popover")).toBeInTheDocument();
  });

  it("does not render shortcuts that were removed from the codebase", () => {
    render(<KeyboardShortcutsModal open onOpenChange={() => {}} projectId={null} />);
    // The old, drifted modal listed several shortcuts that aren't real bindings.
    // The registry should only carry actual `useHotkeys` registrations.
    expect(screen.queryByText("Mark session agent done")).not.toBeInTheDocument();
    expect(screen.queryByText("Start / continue build")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent diff (current agent)")).not.toBeInTheDocument();
  });

  it("filters by description and by combo text via the search box", () => {
    render(<KeyboardShortcutsModal open onOpenChange={() => {}} projectId={null} />);
    const search = screen.getByLabelText("Search shortcuts");

    fireEvent.change(search, { target: { value: "zoom" } });
    expect(screen.getByText("Zoom in")).toBeInTheDocument();
    expect(screen.queryByText("Git actions popover")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "git" } });
    expect(screen.getByText("Git actions popover")).toBeInTheDocument();
    expect(screen.queryByText("Zoom in")).not.toBeInTheDocument();
  });

  it("refreshes localized labels and search results when the language changes", async () => {
    render(<KeyboardShortcutsModal open onOpenChange={() => {}} projectId={null} />);
    const search = screen.getByLabelText("Search shortcuts");
    fireEvent.change(search, { target: { value: "localized" } });
    expect(screen.getByText("No shortcuts match “localized”.")).toBeInTheDocument();

    const originalLanguage = uiI18n.language;
    uiI18n.addResourceBundle("de", "ui", {
      shortcuts: {
        descriptions: { "zoom-in": "Localized zoom action" },
        scopes: { global: { label: "Localized group" } },
      },
    });
    try {
      await act(async () => {
        await uiI18n.changeLanguage("de");
      });
      expect(screen.getByRole("heading", { name: "Localized group" })).toBeInTheDocument();
      expect(screen.getByText("Localized zoom action")).toBeInTheDocument();

      fireEvent.change(search, { target: { value: "ZOOM IN" } });
      expect(screen.getByText("Localized zoom action")).toBeInTheDocument();
    } finally {
      await act(async () => {
        await uiI18n.changeLanguage(originalLanguage);
      });
      uiI18n.removeResourceBundle("de", "ui");
    }
  });

  it("lists and searches every Git command from the central registry", () => {
    render(<KeyboardShortcutsModal open onOpenChange={() => {}} projectId={null} />);
    const search = screen.getByLabelText("Search shortcuts");

    fireEvent.change(search, { target: { value: "git" } });

    for (const label of [
      "Next Git item",
      "Previous Git item",
      "Open or expand Git item",
      "Collapse or go back in Git",
      "Scroll Git half-page down",
      "Scroll Git half-page up",
      "Toggle selected Git file viewed",
      "Stage selected Git file",
      "Unstage selected Git file (preserve worktree)",
      "Open selected Git file in Editor",
      "Show Git Uncommitted",
      "Show Git vs Target",
      "Show Git Commits",
      "Show Git Branches",
      "Show Git Stashes",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
