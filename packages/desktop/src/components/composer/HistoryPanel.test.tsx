import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { usePromptStashStore } from "@/stores/prompt-stash-store";
import { HistoryPanel } from "./HistoryPanel";

describe("HistoryPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    usePromptStashStore.setState({ byProject: {} });
  });

  it("lists stashed drafts before recent prompts and filters by every word", async () => {
    usePromptStashStore.getState().push(1, "stashed refactor plan");
    const { user } = render(
      <HistoryPanel
        projectId={1}
        history={["fix the invoice bug", "add tests"]}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByRole("group", { name: "Stashed drafts" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Recent prompts" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Search prompt history" }), "invoice fix");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("fix the invoice bug");
  });

  it("restores the highlighted entry on Enter and consumes a stashed draft", async () => {
    usePromptStashStore.getState().push(1, "half-written idea");
    const onPick = vi.fn();
    const { user } = render(<HistoryPanel projectId={1} history={["older"]} onPick={onPick} />);
    await user.type(screen.getByRole("textbox", { name: "Search prompt history" }), "{Enter}");
    expect(onPick).toHaveBeenCalledWith("half-written idea");
    expect(usePromptStashStore.getState().byProject[1]).toEqual([]);
  });
});
