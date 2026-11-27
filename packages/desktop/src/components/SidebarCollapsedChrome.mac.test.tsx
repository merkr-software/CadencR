import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { SidebarCollapsedChrome } from "./SidebarCollapsedChrome";

const mocks = vi.hoisted(() => ({ anchor: vi.fn() }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => true }));
vi.mock("@/lib/mac-window-controls", () => ({ HAS_MAC_WINDOW_CONTROLS: true }));
vi.mock("@/hooks/useTrafficLightsAnchor", () => ({ useTrafficLightsAnchor: mocks.anchor }));
vi.mock("@/components/PhoneMenuAttentionDot", () => ({ PhoneMenuAttentionDot: () => null }));
vi.mock("@tanstack/react-router", () => ({ Link: () => null }));

describe("SidebarCollapsedChrome in a narrow macOS window (phone layout)", () => {
  it("starts the menu button past the traffic lights and centers them on its row", () => {
    render(<SidebarCollapsedChrome visible onExpand={vi.fn()} />);
    const button = screen.getByRole("button", { name: /open menu/i });
    expect(button).toHaveClass("ml-[68px]");
    expect(button).not.toHaveClass("ml-1");
    expect(mocks.anchor).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it("hands the lights back while the drawer is open (chrome hidden)", () => {
    render(<SidebarCollapsedChrome visible={false} onExpand={vi.fn()} />);
    expect(mocks.anchor).toHaveBeenLastCalledWith(expect.anything(), false);
  });
});
