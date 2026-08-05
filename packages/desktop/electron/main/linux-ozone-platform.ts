import type { CommandLine } from "electron";

type OzoneCommandLine = Pick<CommandLine, "appendSwitch" | "hasSwitch">;

/**
 * Native Wayland currently mis-composites a scrolled WebContentsView: the
 * child surface drifts down by the page's scroll offset, revealing the host
 * renderer behind it. Keep Linux on Electron's supported X11 compatibility
 * path until native Wayland can render embedded browser surfaces correctly.
 *
 * An explicit CLI choice still wins so Wayland can be tested (and adopted
 * again) without another code change.
 */
export function configureLinuxOzonePlatform(
  commandLine: OzoneCommandLine,
  platform: NodeJS.Platform,
): void {
  if (platform !== "linux" || commandLine.hasSwitch("ozone-platform")) return;
  commandLine.appendSwitch("ozone-platform", "x11");
}
