import type { AppCloseChoice } from "../../src/shared/app-close";

const INTENT_TIMEOUT_MS = 2_000;

/**
 * Tell the service, right before stopping it, whether the agent turns it is
 * about to cut off resume on its next start. It resumes them unless told
 * otherwise: the user quit and chose to stop them. A quit that fails after
 * that sets it back, so a later stop (an update) still resumes them.
 */
export async function sendShutdownIntent(
  baseUrl: string,
  authToken: string | null,
  { resumeAgents }: AppCloseChoice,
): Promise<void> {
  const failure = (detail: string): Error =>
    new Error(
      resumeAgents
        ? `Cadencr could not record that your agents should resume: ${detail}`
        : `Cadencr could not record that your agents should stay stopped: ${detail}`,
    );
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/restart-continuations/shutdown-intent`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-cadencr-token": authToken ?? "" },
      body: JSON.stringify({ resume_agents: resumeAgents }),
      signal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
    });
  } catch (error) {
    throw failure(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw failure(`the service returned ${response.status}`);
}
