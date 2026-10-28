/**
 * Why the renderer is asked to confirm a close. Quitting stops the service and
 * every agent with it; closing the last window on macOS does not: the app,
 * and its agents, keep running in the Dock.
 */
export interface AppCloseRequest {
  quitting: boolean;
}

/** What a quit does with the agents still working. */
export interface AppCloseChoice {
  /** Resume them on the next start (the default), or leave them stopped. */
  resumeAgents: boolean;
}

export const RESUME_AGENTS: AppCloseChoice = { resumeAgents: true };

/** Validate a choice the renderer sent; none means the default. */
export function parseAppCloseChoice(raw: unknown): AppCloseChoice {
  if (raw === undefined) return RESUME_AGENTS;
  if (typeof raw === "object" && raw !== null && "resumeAgents" in raw) {
    const { resumeAgents } = raw;
    if (typeof resumeAgents === "boolean") return { resumeAgents };
  }
  throw new Error("Invalid close choice: expected { resumeAgents: boolean }");
}
