import { translateUi as t } from "../../src/shared/ui-i18n";
const INTENT_TIMEOUT_MS = 2_000;
const LIVE_QUIT_TIMEOUT_MS = 45_000;

/** Wait for a starting service to become eligible to run agents, with a bound on quit. */
export async function waitForStartupBeforeQuit(startup: Promise<void> | null): Promise<void> {
  if (!startup) return;
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      startup,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error(
                "Cadencr is still starting its service. Try quitting again when it is ready.",
              ),
            ),
          INTENT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * The Electron quit events can repeat while main is safely preparing to exit.
 * One attempt owns that work. A failure leaves the app open for a retry.
 */
export class VoluntaryQuit {
  private pending: Promise<void> | null = null;

  get inProgress(): boolean {
    return this.pending !== null;
  }

  run(quit: () => Promise<void>): Promise<void> {
    this.pending ??= Promise.resolve()
      .then(quit)
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  async prepare({ service, prepareBrowser, resumeBrowser }: QuitPreparation): Promise<void> {
    await prepareBrowser();
    try {
      await service?.prepareQuit();
    } catch (error: unknown) {
      resumeBrowser();
      throw error;
    }
  }
}

interface QuitService {
  prepareQuit(): Promise<void>;
}

interface QuitPreparation {
  service: QuitService | null;
  prepareBrowser: () => Promise<void>;
  resumeBrowser: () => void;
}

/** Wait for the running service to durably record and verify the agent stops. */
export async function stopLiveWorkForQuit(
  baseUrl: string,
  authToken: string | null,
): Promise<void> {
  const failure = (detail: string): Error =>
    new Error(t("system.shutdown.stopIntent", "Cadencr could not confirm that your agents stopped: {{detail}}", { detail }));
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/restart-continuations/prepare-desktop-quit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cadencr-token": authToken ?? "" },
      signal: AbortSignal.timeout(LIVE_QUIT_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw failure(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: unknown) =>
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : t("system.shutdown.responseStatus", "the service returned {{status}}", { status: response.status }),
      )
      .catch(() => t("system.shutdown.responseStatus", "the service returned {{status}}", { status: response.status }));
    throw failure(detail);
  }
}
