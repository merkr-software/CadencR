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
  /**
   * Resume the conversations whose background work (commands, agents,
   * monitors, a scheduled wake-up) the quit stops after their turn ended.
   * Follows `resumeAgents` when the user answered the quit dialog; a quit
   * with no agent working asks nothing and leaves that work stopped.
   */
  resumeBackgroundWork: boolean;
}

/** Every stop the user did not answer for: crashes, updates. */
export const RESUME_AGENTS: AppCloseChoice = { resumeAgents: true, resumeBackgroundWork: true };

/** A quit with no agent working: nothing to ask, background work stays stopped. */
export const QUIT_WITHOUT_ASKING: AppCloseChoice = {
  resumeAgents: true,
  resumeBackgroundWork: false,
};

/** The quit dialog's answer, which applies to background work too. */
export function dialogCloseChoice(resumeAgents: boolean): AppCloseChoice {
  return { resumeAgents, resumeBackgroundWork: resumeAgents };
}

/** Validate a choice the renderer sent; none means the default. */
export function parseAppCloseChoice(raw: unknown): AppCloseChoice {
  if (raw === undefined) return RESUME_AGENTS;
  if (
    typeof raw === "object" &&
    raw !== null &&
    "resumeAgents" in raw &&
    "resumeBackgroundWork" in raw
  ) {
    const { resumeAgents, resumeBackgroundWork } = raw;
    if (typeof resumeAgents === "boolean" && typeof resumeBackgroundWork === "boolean") {
      return { resumeAgents, resumeBackgroundWork };
    }
  }
  throw new Error(
    "Invalid close choice: expected { resumeAgents: boolean, resumeBackgroundWork: boolean }",
  );
}
