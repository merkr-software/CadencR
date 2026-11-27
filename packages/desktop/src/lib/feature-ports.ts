import { translateUi } from "@/lib/i18n/ui";
import { PortSource, type AllocatedPort } from "@/api/generated";

/**
 * Servers are reported by port only, and nothing in the process table says
 * whether one speaks TLS — `http` is the right guess for a local dev server.
 */
export function portUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** Where the port came from, phrased for a tooltip or list row. */
export function portSourceLabel(port: AllocatedPort): string {
  switch (port.source) {
    case PortSource.terminal:
      return translateUi("sidebar.ports.terminal", "started in a terminal");
    case PortSource.agent:
      return translateUi("sidebar.ports.agent", "started by the agent");
    // The process no longer descends from a terminal or agent — typically a
    // server the agent left running after its session ended.
    case PortSource.workspace:
      return translateUi("sidebar.ports.worktree", "running in this worktree");
  }
}
