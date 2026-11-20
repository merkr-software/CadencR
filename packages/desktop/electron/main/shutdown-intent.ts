import type { AppCloseChoice, AppCloseRequest } from "../../src/shared/app-close";

const INTENT_TIMEOUT_MS = 2_000;

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
