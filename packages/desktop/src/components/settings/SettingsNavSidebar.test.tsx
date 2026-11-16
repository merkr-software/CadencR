import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, within } from "@/test-utils";
import { SettingsNavSidebar } from "./SettingsNavSidebar";
import type { SettingsPageId } from "./settings-catalog";

function Harness({
  activePageId = "general",
  onNavigate,
  initialQuery = "",
}: {
  activePageId?: SettingsPageId | null;
  onNavigate: (section: string) => void;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <SettingsNavSidebar
      activePageId={activePageId}
      query={query}
      onQueryChange={setQuery}
      onNavigate={onNavigate}
    />
  );
}

function search(value: string): void {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), {
    target: { value },
  });
}

describe("SettingsNavSidebar", () => {
  it("lists every page under its group and marks the open one", () => {
    render(<Harness activePageId="git" onNavigate={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Settings pages" });
    const tools = within(nav).getByRole("group", { name: "Tools" });
    expect(within(tools).getByRole("button", { name: "Git" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("button", { name: "General" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("opens a page by its id", () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    expect(onNavigate).toHaveBeenCalledWith("providers");
  });

  it("narrows the rail to matching settings and opens one at its anchor", () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    search("vim");
    const results = screen.getByRole("navigation", { name: "Search results" });
    expect(within(results).getByRole("button", { name: "Editor" })).toBeInTheDocument();
    expect(within(results).queryByRole("button", { name: "Git" })).toBeNull();
    fireEvent.click(within(results).getByRole("button", { name: "Vim mode" }));
    expect(onNavigate).toHaveBeenCalledWith("editing");
  });

  it("matches the words people use, not only labels", () => {
    render(<Harness onNavigate={vi.fn()} />);
    search("github token");
    expect(screen.getByRole("button", { name: "Remote connections" })).toBeInTheDocument();
  });

  it("opens the first result on Enter", () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    search("blame");
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search settings" }), {
      key: "Enter",
    });
    expect(onNavigate).toHaveBeenCalledWith("editing");
  });

  it("says so when nothing matches, and clears from the field", () => {
    render(<Harness onNavigate={vi.fn()} initialQuery="zzzz" />);
    expect(screen.getByRole("status")).toHaveTextContent("No settings match “zzzz”.");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("navigation", { name: "Settings pages" })).toBeInTheDocument();
  });

  it("walks the results with the arrow keys", () => {
    render(<Harness onNavigate={vi.fn()} />);
    search("mode");
    const field = screen.getByRole("searchbox", { name: "Search settings" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    const items = within(screen.getByRole("navigation", { name: "Search results" })).getAllByRole(
      "button",
    );
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1] as HTMLElement, { key: "ArrowUp" });
    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowUp" });
    expect(field).toHaveFocus();
  });
});
