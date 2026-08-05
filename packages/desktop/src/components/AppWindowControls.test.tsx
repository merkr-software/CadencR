import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import { AppWindowControls } from "./AppWindowControls";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";

describe("AppWindowControls", () => {
  afterEach(() => {
    clearDesktopBridgeOverrideForTests();
    delete document.documentElement.dataset.windowControls;
  });

  it("renders only when the desktop shell owns custom window controls", () => {
    setDesktopBridgeOverrideForTests({ isElectron: false, usesCustomWindowControls: false });

    render(<AppWindowControls />);

    expect(screen.queryByRole("button", { name: "Minimize window" })).not.toBeInTheDocument();
  });

  it("marks the document for header safe-area padding", () => {
    setDesktopBridgeOverrideForTests({ isElectron: true, usesCustomWindowControls: true });

    render(<AppWindowControls />);

    expect(document.documentElement.dataset.windowControls).toBe("linux");
    expect(screen.getByRole("button", { name: "Minimize window" })).toBeInTheDocument();
  });

  it("dispatches native window actions", () => {
    const windowMinimize = vi.fn(() => Promise.resolve());
    const windowToggleMaximize = vi.fn(() => Promise.resolve());
    const windowClose = vi.fn(() => Promise.resolve());
    setDesktopBridgeOverrideForTests({
      isElectron: true,
      usesCustomWindowControls: true,
      windowMinimize,
      windowToggleMaximize,
      windowClose,
    });

    render(<AppWindowControls />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle maximize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));

    expect(windowMinimize).toHaveBeenCalledTimes(1);
    expect(windowToggleMaximize).toHaveBeenCalledTimes(1);
    expect(windowClose).toHaveBeenCalledTimes(1);
  });
});
