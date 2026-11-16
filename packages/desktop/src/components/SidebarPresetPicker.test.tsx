import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { DEFAULT_SIDEBAR_CONFIG, type SidebarConfig } from "@/lib/sidebar-config";
import { nearestSidebarPreset } from "@/lib/sidebar-presets";
import { SidebarPresetPicker } from "./SidebarPresetPicker";

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: toastMock }));

function formWith(config: SidebarConfig) {
  return { config, nearest: nearestSidebarPreset(config), applyPreset: vi.fn(), restore: vi.fn() };
}

describe("SidebarPresetPicker", () => {
  it("checks the preset the options match and describes it", () => {
    render(<SidebarPresetPicker form={formWith(DEFAULT_SIDEBAR_CONFIG)} />);
    expect(screen.getByRole("radio", { name: /Classic/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Focus/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("names a customized sidebar's preset and how far it moved, with the way back", async () => {
    const form = formWith({ ...DEFAULT_SIDEBAR_CONFIG, density: "spacious" });
    const { user } = render(<SidebarPresetPicker form={form} />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-checked", "false");
    }
    expect(screen.getByRole("radio", { name: /Classic/ })).toHaveAttribute(
      "data-preset-state",
      "base",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Custom · Classic with 1 change");

    await user.click(screen.getByRole("button", { name: /Back to Classic/ }));
    expect(form.applyPreset).toHaveBeenCalledWith("classic");
  });

  it("offers to undo a preset applied over customized options", async () => {
    const custom = { ...DEFAULT_SIDEBAR_CONFIG, density: "spacious" } as const;
    const form = formWith(custom);
    const { user } = render(<SidebarPresetPicker form={form} />);
    await user.click(screen.getByRole("radio", { name: /Focus/ }));
    expect(form.applyPreset).toHaveBeenCalledWith("focus");

    const [, options] = toastMock.mock.calls.at(-1) as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    expect(form.restore).toHaveBeenCalledWith(custom);
  });

  it("switches between presets without a toast and ignores the current one", async () => {
    toastMock.mockClear();
    const form = formWith(DEFAULT_SIDEBAR_CONFIG);
    const { user } = render(<SidebarPresetPicker form={form} />);
    await user.click(screen.getByRole("radio", { name: /Classic/ }));
    expect(form.applyPreset).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: /Supervise/ }));
    expect(form.applyPreset).toHaveBeenCalledWith("supervise");
    expect(toastMock).not.toHaveBeenCalled();
  });
});
