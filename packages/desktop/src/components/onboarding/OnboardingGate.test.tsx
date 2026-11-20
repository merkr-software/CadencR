import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readTelemetry } from "@/api/telemetry";
import { OnboardingGate } from "./OnboardingGate";

const SETTINGS_PATH = "/home/user/.cadencr/settings/settings.json";
const context = vi.hoisted(() => ({ error: null as unknown, retry: vi.fn() }));

vi.mock("@/lib/remote/device-token", () => ({ isBrowserRemote: () => false }));
vi.mock("@/hooks/useTelemetryActivity", () => ({ useTelemetryActivity: () => null }));
vi.mock("@/api/telemetry", async (original) => ({
  ...(await original<typeof import("@/api/telemetry")>()),
  readTelemetry: vi.fn(),
}));
vi.mock("@/hooks/useOnboardingStatus", () => ({
  useOnboardingStatus: () => ({
    step: "welcome",
    isCompleted: false,
    isLoading: false,
    isFetching: false,
    isPersisting: false,
    error: context.error,
    retry: context.retry,
    setStep: vi.fn(),
    complete: vi.fn(),
  }),
}));
vi.mock("./OnboardingOverlay", () => ({ OnboardingOverlay: () => <p>Onboarding overlay</p> }));

function unreadableSettingsError(): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError("Request failed with status code 422", "ERR_BAD_REQUEST", undefined, null, {
    status: 422,
    statusText: "Unprocessable Entity",
    headers,
    config: { headers },
    data: {
      code: "SETTINGS_READ_FAILED",
      error: `Cadencr could not read the settings file ${SETTINGS_PATH}: Is a directory (os error 21)`,
    },
  });
}

function renderGate(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OnboardingGate>
        <p>App content</p>
      </OnboardingGate>
    </QueryClientProvider>,
  );
}

describe("OnboardingGate with an unreadable settings file", () => {
  beforeEach(() => {
    window.location.hash = "";
    context.retry.mockClear();
    context.error = unreadableSettingsError();
    // The privacy preferences never load: the unreadable settings come first.
    vi.mocked(readTelemetry).mockReturnValue(new Promise(() => {}));
  });

  // Found in QA: an unreadable settings.json read as "onboarding not done", so
  // the app re-ran onboarding and its "Skip" could not save.
  it("names the file and the cause instead of restarting onboarding", async () => {
    renderGate();

    expect(await screen.findByText("Cadencr can't read your settings")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(SETTINGS_PATH);
    expect(screen.getByRole("alert")).toHaveTextContent("Is a directory");
    expect(screen.queryByText("Onboarding overlay")).toBeNull();
    expect(screen.queryByText("App content")).toBeNull();
  });

  it("retries the read and opens Settings on request", async () => {
    const user = userEvent.setup();
    renderGate();

    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(context.retry).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(window.location.hash).toBe("#/settings");
    expect(await screen.findByText("App content")).toBeVisible();
  });
});
