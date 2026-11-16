import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { DEFAULT_SIDEBAR_CONFIG, type SidebarConfig } from "@/lib/sidebar-config";
import { nearestSidebarPreset } from "@/lib/sidebar-presets";
import { SidebarConfiguratorSteps } from "./SidebarConfiguratorSteps";

function formWith(config: SidebarConfig) {
  return {
    config,
    nearest: nearestSidebarPreset(config),
    setOption: vi.fn(),
    reset: vi.fn(),
    applyPreset: vi.fn(),
    restore: vi.fn(),
    isApplying: false,
    disabled: false,
  };
}

describe("SidebarConfiguratorSteps", () => {
  it("heads the presets as the base and the options as adjusting it", () => {
    render(
      <SidebarConfiguratorSteps form={formWith({ ...DEFAULT_SIDEBAR_CONFIG, todos: true })}>
        <p>Option groups</p>
      </SidebarConfiguratorSteps>,
    );
    const preset = screen.getByRole("region", { name: "Preset" });
    expect(preset).toHaveTextContent("The base every option starts from");
    expect(preset).toContainElement(screen.getByRole("radiogroup", { name: "Preset" }));
    const adjust = screen.getByRole("region", { name: "Adjust" });
    expect(adjust).toHaveTextContent("On top of Classic");
    expect(adjust).toHaveTextContent("Option groups");
  });
});
