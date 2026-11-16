import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./dialog";

describe("Dialog", () => {
  it("opens dialog on trigger click", async () => {
    const { user } = render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Test Dialog</DialogTitle>
          </DialogHeader>
          <p>Dialog content</p>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByText("Dialog content")).not.toBeInTheDocument();
    await user.click(screen.getByText("Open"));
    expect(screen.getByText("Dialog content")).toBeInTheDocument();
  });

  it("renders open dialog when open=true", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>My Dialog</DialogTitle>
          <p>Open by default</p>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByText("Open by default")).toBeInTheDocument();
  });

  it("calls onOpenChange when closed", async () => {
    const onOpenChange = vi.fn();
    const { user } = render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Dialog</DialogTitle>
          <p>Content</p>
        </DialogContent>
      </Dialog>,
    );
    // Press Escape to close
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sets aria-describedby to undefined by default", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>No Description</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toHaveAttribute("aria-describedby");
  });

  it("does not render content when closed", () => {
    render(
      <Dialog open={false}>
        <DialogContent>
          <DialogTitle>Dialog</DialogTitle>
          <p>Hidden content</p>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByText("Hidden content")).not.toBeInTheDocument();
  });

  it("caps every dialog to the visible viewport, unless it brings its own cap", () => {
    const { rerender } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Capped</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    // Without a cap a tall dialog ran off a phone screen, footer and all.
    expect(screen.getByRole("dialog")).toHaveClass("max-h-(--dialog-max-h)", "overflow-y-auto");

    rerender(
      <Dialog open>
        <DialogContent className="max-h-[min(85vh,var(--dialog-max-h))] overflow-hidden p-0">
          <DialogTitle>Own cap</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("max-h-[min(85vh,var(--dialog-max-h))]", "overflow-hidden", "p-0");
    // `not.toHaveClass` with several names only fails when all are present.
    for (const replaced of ["max-h-(--dialog-max-h)", "overflow-y-auto", "p-6"]) {
      expect(dialog).not.toHaveClass(replaced);
    }
  });
});
