import { describe, it, expect, beforeEach } from "vitest";
import { act, render, screen } from "@/test-utils";
import { InternetStatusIndicator } from "@/components/InternetStatusIndicator";

function setNavigatorOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

describe("InternetStatusIndicator", () => {
  beforeEach(() => {
    setNavigatorOnline(true);
  });

  it("is hidden when the machine is online", () => {
    render(<InternetStatusIndicator />);
    expect(screen.queryByLabelText("No internet connection")).not.toBeInTheDocument();
  });

  it("appears immediately when the machine is offline", () => {
    setNavigatorOnline(false);
    render(<InternetStatusIndicator />);
    expect(screen.getByLabelText("No internet connection")).toBeInTheDocument();
  });

  it("updates from browser online and offline events", () => {
    render(<InternetStatusIndicator />);
    expect(screen.queryByLabelText("No internet connection")).not.toBeInTheDocument();

    act(() => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByLabelText("No internet connection")).toBeInTheDocument();

    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByLabelText("No internet connection")).not.toBeInTheDocument();
  });

  it("shows explanatory popover copy on hover", async () => {
    setNavigatorOnline(false);
    const { user } = render(<InternetStatusIndicator />);

    await user.hover(screen.getByLabelText("No internet connection"));

    expect(
      screen.getByText("Cloud models may be unavailable while local work can continue."),
    ).toBeInTheDocument();
  });
});
