import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import { SidebarLensMenu } from "./SidebarLensMenu";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/hooks/useSidebarSettings", () => ({ useSetSidebarOption: () => vi.fn() }));
vi.mock("@/hooks/useSidebarViews", () => ({
  useSidebarViews: () => ({ views: [], activeView: null, showView: vi.fn() }),
}));

function trigger(): HTMLElement {
  return screen.getByRole("button", { name: /Projects/ });
}

describe("SidebarLensMenu", () => {
  it("leaves a press to the header's drag and opens on click", () => {
    render(<SidebarLensMenu />);
    const button = trigger();
    fireEvent.pointerDown(button, { button: 0, pointerType: "mouse" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("opens from the keyboard", () => {
    render(<SidebarLensMenu />);
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
