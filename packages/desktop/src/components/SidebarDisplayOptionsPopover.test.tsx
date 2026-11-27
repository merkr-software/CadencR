import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import { useSidebarPreviewStore } from "@/stores/sidebar-preview-store";
import {
  SidebarDisplayOptionsButton,
  SidebarDisplayOptionsHost,
} from "./SidebarDisplayOptionsPopover";

const layout = vi.hoisted(() => ({ phone: false }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => layout.phone }));
// The form is covered by its own tests.
vi.mock("@/components/SidebarDisplayOptions", () => ({
  SidebarDisplayOptionsForm: () => <div data-testid="options-form" />,
}));

function renderHost() {
  return render(
    <SidebarDisplayOptionsHost collapsed={false}>
      <SidebarDisplayOptionsButton section="projects" />
    </SidebarDisplayOptionsHost>,
  );
}

beforeEach(() => {
  layout.phone = false;
});
afterEach(() => {
  act(() => useSidebarPreviewStore.getState().closeOptions());
});

describe("SidebarDisplayOptionsHost", () => {
  it("opens the options in a bottom sheet on a phone, and gives the focus back on close", async () => {
    layout.phone = true;
    const { user } = renderHost();
    const button = screen.getByRole("button", { name: "Display options" });
    await user.click(button);
    const form = await screen.findByTestId("options-form");
    expect(form.closest("[data-phone-sheet]")).not.toBeNull();
    expect(screen.getByRole("dialog", { name: "Display options" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(useSidebarPreviewStore.getState().optionsOpen).toBe(false);
    await waitFor(() => expect(button).toHaveFocus());
  });

  it("keeps the popover beside the sidebar on the desktop layout", async () => {
    const { user } = renderHost();
    await user.click(screen.getByRole("button", { name: "Display options" }));
    const form = await screen.findByTestId("options-form");
    expect(form.closest("[data-phone-sheet]")).toBeNull();
  });
});
