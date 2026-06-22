import { afterEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@/test-utils";
import { InterfaceSection } from "./InterfaceSection";
import { useShortcutsHelpStore } from "@/stores/shortcuts-help-store";

afterEach(() => {
  useShortcutsHelpStore.setState({ open: false });
});

describe("InterfaceSection", () => {
  it("opens the keyboard shortcuts modal via the store when the button is clicked", async () => {
    const user = userEvent.setup();
    render(<InterfaceSection />);

    expect(useShortcutsHelpStore.getState().open).toBe(false);
    await user.click(screen.getByRole("button", { name: /view shortcuts/i }));
    expect(useShortcutsHelpStore.getState().open).toBe(true);
  });
});
