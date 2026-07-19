import { describe, expect, it, vi } from "vitest";
import { configureLinuxOzonePlatform } from "./linux-ozone-platform";

function commandLine(hasOzonePlatform = false) {
  return {
    appendSwitch: vi.fn<(name: string, value?: string) => void>(),
    hasSwitch: vi.fn<(name: string) => boolean>(() => hasOzonePlatform),
  };
}

describe("configureLinuxOzonePlatform", () => {
  it("uses X11 compatibility mode on Linux for stable embedded browser scrolling", () => {
    const target = commandLine();

    configureLinuxOzonePlatform(target, "linux");

    expect(target.appendSwitch).toHaveBeenCalledWith("ozone-platform", "x11");
  });

  it("preserves an explicit Linux Ozone platform override", () => {
    const target = commandLine(true);

    configureLinuxOzonePlatform(target, "linux");

    expect(target.hasSwitch).toHaveBeenCalledWith("ozone-platform");
    expect(target.appendSwitch).not.toHaveBeenCalled();
  });

  it("does not change the Ozone platform on macOS", () => {
    const target = commandLine();

    configureLinuxOzonePlatform(target, "darwin");

    expect(target.appendSwitch).not.toHaveBeenCalled();
  });
});
