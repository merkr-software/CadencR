import type { AppCloseChoice, AppCloseRequest } from "../../src/shared/app-close";

const INTENT_TIMEOUT_MS = 2_000;

/**
 * What `before-quit` does: a quit the window has not settled is handed to it
 * so it can ask the user. A quit already answered (the quit dialog's, an
 * update's) has recorded its own intent: the service is just stopped. Every
 * other quit asked nobody (the window closed on macOS, then a Dock quit; a
 * quit from the splash): main records it as such before stopping the service.
 */
export type BeforeQuitStep = "ask-window" | "stop" | "stop-unasked" | "quit";

export function beforeQuitStep(state: {
  allowClose: boolean;
  hasWindow: boolean;
  quitAnswered: boolean;
  shutdownReady: boolean;
}): BeforeQuitStep {
  if (!state.allowClose && state.hasWindow) return "ask-window";
  if (state.shutdownReady) return "quit";
  return state.quitAnswered ? "stop" : "stop-unasked";
}

/**
 * The quit intent being recorded. A quit that arrives meanwhile (a second
 * Cmd+Q, the Dock) waits for that same recording before stopping the
 * service, and stops nothing when it failed: the first quit reports that.
 */
export class QuitIntentRecording {
  private pending: Promise<void> = Promise.resolve();

  track(recording: Promise<void>): Promise<void> {
    this.pending = recording;
    return recording;
  }

  /** Whether the recording in progress (or the last one) went through. */
  succeeded(): Promise<boolean> {
    return this.pending.then(
      () => true,
      () => false,
    );
  }

  /**
   * Stop the service for a quit at `step`, once what it waits for settled:
   * its own recording when nobody was asked, else the one in progress (which
   * stops nothing when it failed).
   */
  async stopWhenReady(
    step: BeforeQuitStep,
    recordUnasked: () => Promise<void>,
    stop: () => Promise<void>,
  ): Promise<void> {
    if (step === "stop-unasked") await recordUnasked();
    else if (!(await this.succeeded())) return;
    await stop();
  }
}

interface IntentRecorder {
  setShutdownIntent: (choice: AppCloseChoice) => Promise<void>;
}

/**
 * Record a close choice that keeps agents, or only their background work,
 * stopped. Returns whether one was recorded. Only a quit stops the service: a
 * window that closes leaves it running, and a later stop (an update) must
 * still resume everything. A failure blocks the quit only for an answer the
 * user gave in the quit dialog; otherwise `reportIgnored` shows it and the
 * quit goes on.
 */
export async function recordQuitIntent(
  recorder: IntentRecorder | null,
  request: AppCloseRequest,
  choice: AppCloseChoice,
  reportIgnored: (message: string) => void,
): Promise<boolean> {
  if (!request.quitting || !recorder) return false;
  if (choice.resumeAgents && choice.resumeBackgroundWork) return false;
  try {
    await recorder.setShutdownIntent(choice);
  } catch (error: unknown) {
    if (!choice.resumeAgents) throw error;
    reportIgnored(error instanceof Error ? error.message : String(error));
    return false;
  }
  return true;
}

/**
 * Tell the service, right before stopping it, whether the agent turns and
 * background work it is about to cut off resume on its next start. It resumes
 * them unless told otherwise: the user quit and chose to stop them, or quit
 * with no agent working (background work then stays stopped). A quit that
 * fails after that sets it back, so a later stop (an update) still resumes them.
 */
export async function sendShutdownIntent(
  baseUrl: string,
  authToken: string | null,
  { resumeAgents, resumeBackgroundWork }: AppCloseChoice,
): Promise<void> {
  const failure = (detail: string): Error =>
    new Error(
      resumeAgents && resumeBackgroundWork
        ? `Cadencr could not record that your agents should resume: ${detail}`
        : `Cadencr could not record that your agents should stay stopped: ${detail}`,
    );
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/restart-continuations/shutdown-intent`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-cadencr-token": authToken ?? "" },
      body: JSON.stringify({
        resume_agents: resumeAgents,
        resume_background_work: resumeBackgroundWork,
      }),
      signal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
    });
  } catch (error) {
    throw failure(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw failure(`the service returned ${response.status}`);
}
