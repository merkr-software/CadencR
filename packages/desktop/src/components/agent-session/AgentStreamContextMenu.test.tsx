import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentStreamContextMenu from "./AgentStreamContextMenu";

const copyAs = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const useMessageBranchActions = vi.hoisted(() =>
  vi.fn(() => ({ canBranch: false, rewind: vi.fn(), fork: vi.fn() })),
);

vi.mock("@/lib/markdown-export", () => ({ copyAs }));
vi.mock("@/lib/email-export", () => ({
  rangeToEmailHtml: () => '<h2 style="color:rgb(80, 60, 180)">Selected heading</h2>',
}));
vi.mock("./use-message-branch-actions", () => ({
  useMessageBranchActions,
}));
const useIsTouchDevice = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/hooks/useIsTouchDevice", () => ({ useIsTouchDevice }));

function select(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

describe("AgentStreamContextMenu", () => {
  beforeEach(() => {
    copyAs.mockClear();
    useMessageBranchActions.mockClear();
    useIsTouchDevice.mockReturnValue(false);
    window.getSelection()?.removeAllRanges();
  });

  it("copies a rendered selection as rich email HTML", async () => {
    const { user } = render(
      <AgentStreamContextMenu block={{ id: "text-1", type: "text", content: "# Source" }}>
        <h2>Selected heading</h2>
      </AgentStreamContextMenu>,
    );
    const heading = screen.getByRole("heading", { name: "Selected heading" });
    select(heading);

    fireEvent.mouseDown(heading, { button: 2 });
    fireEvent.contextMenu(heading);
    await user.click(await screen.findByRole("menuitem", { name: /Copy as/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Email$/i }));

    expect(copyAs).toHaveBeenCalledWith(
      "email",
      "Selected heading",
      expect.stringContaining("<h2"),
    );
  });

  it("keeps generated replies copy-only without running branching hooks", async () => {
    const { user } = render(
      <AgentStreamContextMenu
        block={{ id: "reply-1", type: "text", content: "Reply source" }}
        branchingEnabled={false}
      >
        <p>Rendered reply</p>
      </AgentStreamContextMenu>,
    );
    const reply = screen.getByText("Rendered reply");

    fireEvent.mouseDown(reply, { button: 2 });
    fireEvent.contextMenu(reply);

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(useMessageBranchActions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: /Copy as/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Email$/i }));
    expect(copyAs).toHaveBeenCalledWith("email", "Reply source", expect.stringContaining("<h2"));
  });

  it("leaves touch long-press to native text selection", () => {
    useIsTouchDevice.mockReturnValue(true);
    render(
      <AgentStreamContextMenu block={{ id: "text-1", type: "text", content: "Body" }}>
        <p>Rendered body</p>
      </AgentStreamContextMenu>,
    );
    const body = screen.getByText("Rendered body");

    // An unhandled contextmenu (Android long-press) keeps its native default.
    expect(fireEvent.contextMenu(body)).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
