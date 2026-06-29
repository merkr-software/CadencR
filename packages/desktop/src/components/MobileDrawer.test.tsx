import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { MobileDrawer } from "./MobileDrawer";

describe("MobileDrawer", () => {
  it("dismisses via the backdrop", async () => {
    const onClose = vi.fn();
    const { user } = render(
      <MobileDrawer collapsed={false} onClose={onClose} closeLabel="Close menu">
        <div>drawer body</div>
      </MobileDrawer>,
    );

    await user.click(screen.getByRole("button", { name: "Close menu" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("slides the panel off-canvas and disables the backdrop when collapsed", () => {
    const { rerender } = render(
      <MobileDrawer collapsed={false} onClose={vi.fn()} closeLabel="Close menu">
        <div data-testid="body">drawer body</div>
      </MobileDrawer>,
    );

    const panel = screen.getByTestId("body").parentElement as HTMLElement;
    const backdrop = screen.getByRole("button", { name: "Close menu" });
    expect(panel.className).toContain("translate-x-0");
    expect(backdrop.className).toContain("opacity-100");

    rerender(
      <MobileDrawer collapsed onClose={vi.fn()} closeLabel="Close menu">
        <div data-testid="body">drawer body</div>
      </MobileDrawer>,
    );

    expect(panel.className).toContain("-translate-x-full");
    expect(backdrop.className).toContain("pointer-events-none");
  });
});
