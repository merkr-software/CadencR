import { describe, it, expect, beforeEach } from "vitest";
import { act, render, screen } from "@/test-utils";
import { InternetStatusIndicator } from "@/components/InternetStatusIndicator";
import { uiI18n } from "@/lib/i18n/ui";

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

  it("retranslates the open offline popover and its trigger", async () => {
    setNavigatorOnline(false);
    const { user } = render(<InternetStatusIndicator />);
    const trigger = screen.getByRole("button", { name: "No internet connection" });
    await user.hover(trigger);
    uiI18n.addResourceBundle("fr", "ui", {
      conversation: {
        connection: {
          noInternet: "Hors ligne",
          noInternetDetail: "Le travail local peut continuer.",
        },
      },
    });
    try {
      await act(() => uiI18n.changeLanguage("fr"));
      expect(screen.getByRole("button", { name: "Hors ligne" })).toBe(trigger);
      expect(screen.getByText("Le travail local peut continuer.")).toBeVisible();
      await act(() => uiI18n.changeLanguage("en"));
      expect(screen.getByRole("button", { name: "No internet connection" })).toBe(trigger);
      expect(
        screen.getByText("Cloud models may be unavailable while local work can continue."),
      ).toBeVisible();
    } finally {
      await act(() => uiI18n.changeLanguage("en"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
  });
});
