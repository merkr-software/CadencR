import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AxiosError, AxiosHeaders, type AxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TELEMETRY_QUERY_KEY, type TelemetryState } from "@/api/telemetry";
import { LanguageProvider } from "@/lib/i18n/LanguageProvider";
import { invalidateSettingsDerivedQueries } from "@/lib/settingsInvalidation";
import { OnboardingGate } from "./OnboardingGate";
import { LanguageUpgradeSuggestion } from "./LanguageUpgradeSuggestion";

const request = vi.hoisted(() => vi.fn<(config: AxiosRequestConfig) => Promise<unknown>>());
const languagePreference = vi.hoisted(() => ({ value: "en-US" }));
let history: ReturnType<typeof createHashHistory> | undefined;
vi.mock("@/api/client", () => ({
  customInstance: (config: AxiosRequestConfig) =>
    config.url === "/api/workspace/settings/ui_language"
      ? Promise.resolve(languagePreference)
      : request(config),
  getRuntimeConfigSync: () => ({ preferredLanguages: ["fr-FR"] }),
}));
vi.mock("@/lib/remote/device-token", () => ({ isBrowserRemote: () => false }));
vi.mock("./steps/WelcomeIntro", () => ({ WelcomeIntro: () => <p>Welcome intro</p> }));
vi.mock("./steps/DiscoverCliStep", () => ({
  DiscoverCliStep: () => (
    <label>
      CLI path draft
      <input />
    </label>
  ),
}));

const SETTINGS_PATH = "/home/user/.cadencr/settings/settings.json";
const ONBOARDING_URL = "/api/workspace/settings/onboarding_step";
const PROJECT_ROUTE = "/projects/$projectId/features/$featureId";
const PROJECT_PATH = "/projects/1/features/1";
const SAVED_DECISION: TelemetryState = {
  decision_version: 1,
  audience_enabled: false,
  diagnostics_enabled: false,
  usage_enabled: false,
  installation_id: null,
  audience_configured: true,
  diagnostics_configured: true,
  usage_configured: true,
  audience_status: "disabled",
  diagnostics_status: "disabled",
  usage_status: "disabled",
};
const NO_DECISION: TelemetryState = {
  ...SAVED_DECISION,
  decision_version: null,
  audience_enabled: true,
};

function settingsError(
  status: 400 | 422,
  cause = status === 422 ? "Is a directory" : "Malformed JSON",
): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError("Unable to read settings", "ERR_BAD_REQUEST", undefined, null, {
    status,
    statusText: "Invalid settings",
    headers,
    config: { headers },
    data: {
      code: status === 422 ? "SETTINGS_READ_FAILED" : "SETTINGS_INVALID",
      error: `${SETTINGS_PATH}: ${cause}`,
    },
  });
}

function serveSettings(error: AxiosError | null = null) {
  request.mockImplementation(async ({ method, url }) => {
    if (method !== "GET") throw new Error(`Unexpected ${method} ${url}`);
    if (error) throw error;
    if (url === "/api/telemetry") return SAVED_DECISION;
    if (url === ONBOARDING_URL) return { value: "completed" };
    throw new Error(`Unexpected ${url}`);
  });
}

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = vi.fn();
  const root = createRootRoute();
  const project = createRoute({
    getParentRoute: () => root,
    path: PROJECT_ROUTE,
    component: () => (
      <>
        <h1>Project workspace</h1>
        <button type="button" onClick={stop}>
          Stop
        </button>
      </>
    ),
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => <h1>Edit JSON</h1>,
  });
  window.history.replaceState(null, "", `#${PROJECT_PATH}`);
  history = createHashHistory();
  const router = createRouter({
    routeTree: root.addChildren([project, settings]),
    history,
  });
  render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <OnboardingGate
          openSettings={() => router.navigate({ to: "/settings" })}
          languageSuggestion={<LanguageUpgradeSuggestion />}
        >
          <RouterProvider router={router} />
        </OnboardingGate>
      </LanguageProvider>
    </QueryClientProvider>,
  );
  return { client, router, stop };
}

describe("OnboardingGate settings repair", () => {
  beforeEach(() => {
    request.mockReset();
    languagePreference.value = "en-US";
  });
  afterEach(() => {
    cleanup();
    history?.destroy();
  });

  it.each([400, 422] as const)("opens the actual Settings route after a %i", async (status) => {
    serveSettings(settingsError(status));
    const { router } = renderGate();
    const user = userEvent.setup();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(SETTINGS_PATH);
    expect(alert).toHaveTextContent(status === 422 ? "Is a directory" : "Malformed JSON");
    expect(screen.queryByText("Welcome to Cadencr")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    await user.click(screen.getByRole("button", { name: "Open Settings" }));

    expect(await screen.findByRole("heading", { name: "Edit JSON" })).toBeVisible();
    expect(router.state.resolvedLocation?.pathname).toBe("/settings");
    expect(screen.queryByText("Project workspace")).not.toBeInTheDocument();
  });

  it("waits until Settings is repaired before offering the system language", async () => {
    languagePreference.value = "legacy-english";
    serveSettings(settingsError(400));
    const { client } = renderGate();
    const offer = { name: "Switch to French?" };
    await userEvent.click(await screen.findByRole("button", { name: "Open Settings" }));
    expect(await screen.findByRole("heading", { name: "Edit JSON" })).toBeVisible();
    expect(screen.queryByRole("dialog", offer)).not.toBeInTheDocument();

    serveSettings();
    await act(() => invalidateSettingsDerivedQueries(client));
    expect(await screen.findByRole("dialog", offer)).toBeVisible();
  });

  it("keeps the saved refusal and opens a new repair episode after another corruption", async () => {
    serveSettings();
    const { client, router, stop } = renderGate();
    const user = userEvent.setup();
    const project = await screen.findByRole("heading", { name: "Project workspace" });

    serveSettings(settingsError(400));
    await act(() => invalidateSettingsDerivedQueries(client));
    expect(await screen.findByRole("alert")).toHaveTextContent("Malformed JSON");
    expect(project).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(await screen.findByRole("heading", { name: "Edit JSON" })).toBeVisible();

    serveSettings();
    await act(() => invalidateSettingsDerivedQueries(client));
    await waitFor(() => expect(client.getQueryState(TELEMETRY_QUERY_KEY)?.status).toBe("success"));
    expect(client.getQueryData(TELEMETRY_QUERY_KEY)).toEqual(SAVED_DECISION);
    expect(screen.queryByText("Help improve Cadencr")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Edit JSON" })).toBeVisible();

    await act(() =>
      router.navigate({ to: PROJECT_ROUTE, params: { projectId: "1", featureId: "1" } }),
    );
    expect(await screen.findByRole("heading", { name: "Project workspace" })).toBeVisible();
    serveSettings(settingsError(422));
    await act(() => invalidateSettingsDerivedQueries(client));
    expect(await screen.findByRole("alert")).toHaveTextContent("Is a directory");
    expect(screen.getByRole("button", { name: "Open Settings" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledOnce();
    expect(request.mock.calls.every(([config]) => config.method === "GET")).toBe(true);
  });

  it.each(["onboarding", "telemetry"] as const)(
    "recovers without navigation or a privacy request when %s responds first",
    async (first) => {
      serveSettings(settingsError(400));
      const { client, router } = renderGate();
      expect(await screen.findByRole("alert")).toHaveTextContent("Malformed JSON");

      const onboarding = Promise.withResolvers<{ value: string }>();
      const telemetry = Promise.withResolvers<TelemetryState>();
      request.mockImplementation(async ({ url }) =>
        url === "/api/telemetry" ? telemetry.promise : onboarding.promise,
      );
      await waitFor(() => expect(request).toHaveBeenCalledTimes(4), { timeout: 4_000 });
      if (first === "onboarding") {
        await act(async () => onboarding.resolve({ value: "completed" }));
      } else {
        await act(async () => telemetry.resolve(SAVED_DECISION));
      }
      const firstKey = first === "onboarding" ? [ONBOARDING_URL] : TELEMETRY_QUERY_KEY;
      await waitFor(() => expect(client.getQueryState(firstKey)?.status).toBe("success"));
      expect(screen.queryByText("Help improve Cadencr")).not.toBeInTheDocument();
      expect(screen.queryByText("Project workspace")).not.toBeInTheDocument();
      onboarding.resolve({ value: "completed" });
      telemetry.resolve(SAVED_DECISION);

      expect(await screen.findByRole("heading", { name: "Project workspace" })).toBeVisible();
      expect(router.state.resolvedLocation?.pathname).toBe(PROJECT_PATH);
      expect(screen.queryByText("Help improve Cadencr")).not.toBeInTheDocument();
      expect(request.mock.calls.every(([config]) => config.method === "GET")).toBe(true);
    },
  );

  it("returns from Welcome even if the first two reads straddle settings restoration", async () => {
    serveSettings();
    const { client, router } = renderGate();
    await screen.findByRole("heading", { name: "Project workspace" });

    request.mockImplementation(async ({ url }) =>
      url === "/api/telemetry" ? NO_DECISION : { value: null },
    );
    await act(() => invalidateSettingsDerivedQueries(client));
    await screen.findByRole("heading", { name: "Welcome to Cadencr" });
    expect(screen.queryByText("Project workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("Welcome intro")).not.toBeInTheDocument();

    const beforeRestore = Promise.withResolvers<TelemetryState>();
    let telemetryReads = 0;
    request.mockImplementation(async ({ url }) => {
      if (url === "/api/telemetry") {
        telemetryReads++;
        return telemetryReads === 1 ? beforeRestore.promise : SAVED_DECISION;
      }
      return { value: url === ONBOARDING_URL ? "completed" : null };
    });
    // Welcome has no route or app socket. Only its own recheck can see these reads.
    expect(
      await screen.findByText("Checking settings…", undefined, { timeout: 4_000 }),
    ).toBeVisible();
    expect(screen.queryByText("Help improve Cadencr")).not.toBeInTheDocument();
    await act(async () => beforeRestore.resolve(NO_DECISION));
    await waitFor(() =>
      expect(client.getQueryState(TELEMETRY_QUERY_KEY)?.fetchStatus).toBe("idle"),
    );
    expect(screen.getByText("Checking settings…")).toBeVisible();
    expect(screen.queryByText("Help improve Cadencr")).not.toBeInTheDocument();

    expect(
      await screen.findByRole("heading", { name: "Project workspace" }, { timeout: 4_000 }),
    ).toBeVisible();
    expect(telemetryReads).toBe(2);
    expect(router.state.resolvedLocation?.pathname).toBe(PROJECT_PATH);
    expect(client.getQueryData(TELEMETRY_QUERY_KEY)).toEqual(SAVED_DECISION);
    expect(request.mock.calls.every(([config]) => config.method === "GET")).toBe(true);
  }, 10_000);

  it("keeps first-use progress and input through an in-flight Welcome recheck", async () => {
    let step: string | null = null;
    let holdWelcomeRead = false;
    const stale = Promise.withResolvers<{ value: null }>();
    const recheckStarted = vi.fn();
    request.mockImplementation(async ({ method, url, data }) => {
      if (url === "/api/telemetry") return { ...NO_DECISION, audience_configured: false };
      if (url !== ONBOARDING_URL) return { value: null };
      if (method === "PUT") {
        step = (data as { value: string }).value;
      } else if (holdWelcomeRead && step === null) {
        recheckStarted();
        return stale.promise;
      }
      return { value: step };
    });

    const { client } = renderGate();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Welcome to Cadencr" });
    expect(await screen.findByText("Welcome intro")).toBeVisible();
    holdWelcomeRead = true;
    await waitFor(() => expect(recheckStarted).toHaveBeenCalledOnce(), { timeout: 7_000 });
    await user.click(screen.getByRole("button", { name: "Get started" }));
    const draft = await screen.findByRole("textbox", { name: "CLI path draft" });
    await user.type(draft, "/tmp/qa-cli");

    await act(async () => stale.resolve({ value: null }));
    expect(client.getQueryData([ONBOARDING_URL])).toEqual({ value: "discover_cli" });
    // A current read of the same step must also keep the local draft mounted.
    await act(() => invalidateSettingsDerivedQueries(client));
    expect(screen.queryByText("Welcome to Cadencr")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "CLI path draft" })).toBe(draft);
    expect(draft).toHaveValue("/tmp/qa-cli");
    expect(step).toBe("discover_cli");
  }, 10_000);

  it("shows telemetry section corruption as a repair and restores v1 without consent or activity", async () => {
    request.mockImplementation(async ({ url }) => {
      if (url === "/api/telemetry") throw settingsError(400, "Invalid telemetry object");
      return { value: "completed" };
    });
    const { client } = renderGate();
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid telemetry object");
    expect(screen.queryByText("Help improve Cadencr")).not.toBeInTheDocument();
    expect(screen.queryByText("Project workspace")).not.toBeInTheDocument();

    serveSettings();
    expect(
      await screen.findByRole("heading", { name: "Project workspace" }, { timeout: 4_000 }),
    ).toBeVisible();
    expect(client.getQueryData(TELEMETRY_QUERY_KEY)).toEqual(SAVED_DECISION);
    expect(screen.queryByText("Help improve Cadencr")).not.toBeInTheDocument();
    expect(request.mock.calls.every(([config]) => config.method === "GET")).toBe(true);
  });
});
