import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingGate } from "@/components/onboarding/OnboardingGate";
import { useTelemetryActivity } from "@/hooks/useTelemetryActivity";
import { TelemetryChoices } from "./TelemetryChoices";
import { readTelemetry, updateTelemetry, type TelemetryState } from "@/api/telemetry";
import type { OnboardingStep } from "@/lib/onboarding-step";

const context = vi.hoisted(() => ({
  remote: false,
  navigationFailure: false,
  step: "completed" as OnboardingStep,
  listeners: new Set<() => void>(),
  retry: vi.fn(),
}));
vi.mock("@/lib/remote/device-token", () => ({ isBrowserRemote: () => context.remote }));
vi.mock("@/hooks/useTelemetryActivity", () => ({ useTelemetryActivity: vi.fn(() => null) }));
vi.mock("@/api/telemetry", async (original) => ({
  ...(await original<typeof import("@/api/telemetry")>()),
  readTelemetry: vi.fn(),
  updateTelemetry: vi.fn(),
}));
vi.mock("@/hooks/useOnboardingStatus", () => ({
  useOnboardingStatus: () => {
    const step = useSyncExternalStore(
      (listener) => {
        context.listeners.add(listener);
        return () => context.listeners.delete(listener);
      },
      () => context.step,
    );
    const setStep = async (next: OnboardingStep) => {
      if (context.navigationFailure) throw new Error("Could not save setup progress");
      context.step = next;
      context.listeners.forEach((listener) => listener());
    };
    return {
      step,
      isCompleted: step === "completed",
      isLoading: false,
      isPersisting: false,
      error: null,
      retry: context.retry,
      setStep,
      complete: () => setStep("completed"),
    };
  },
}));
vi.mock("@/components/onboarding/steps/WelcomeStep", () => ({
  WelcomeStep: () => <p>Welcome step</p>,
}));
vi.mock("@/components/onboarding/steps/DiscoverCliStep", () => ({ DiscoverCliStep: () => null }));
vi.mock("@/components/onboarding/steps/ChooseWorkspaceStep", () => ({
  ChooseWorkspaceStep: () => null,
}));
vi.mock("@/components/onboarding/steps/PickAgentStep", () => ({ PickAgentStep: () => null }));
vi.mock("@/components/onboarding/steps/NotificationsStep", () => ({
  NotificationsStep: () => null,
}));
vi.mock("@/components/onboarding/steps/PreferencesStep", () => ({ PreferencesStep: () => null }));
vi.mock("@/components/onboarding/steps/FirstPromptStep", () => ({
  FirstPromptStep: () => <p>Final onboarding step</p>,
}));
const initial: TelemetryState = {
  diagnostics_enabled: false,
  usage_enabled: false,
  audience_enabled: true,
  decision_version: null,
  installation_id: null,
  diagnostics_configured: true,
  usage_configured: true,
  audience_configured: false,
  diagnostics_status: "disabled",
  usage_status: "disabled",
  audience_status: "not_configured",
};
function mount(
  content = (
    <OnboardingGate>
      <button>Workspace action</button>
    </OnboardingGate>
  ),
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
  return { ...rendered, client };
}
beforeEach(() => {
  vi.clearAllMocks();
  context.remote = false;
  context.navigationFailure = false;
  context.step = "completed";
  context.listeners.clear();
  vi.mocked(readTelemetry).mockResolvedValue(initial);
  vi.mocked(updateTelemetry).mockImplementation(async (choices) => ({
    ...initial,
    ...choices,
    audience_enabled: choices.audience_enabled ?? initial.audience_enabled,
    decision_version: 1,
  }));
});

describe("local telemetry decision", () => {
  it("blocks the workspace while loading, and Escape/outside clicks cannot dismiss the decision", async () => {
    mount();
    expect(screen.getByRole("status")).toHaveTextContent("Loading privacy preferences");
    expect(screen.queryByText("Workspace action")).not.toBeInTheDocument();
    await screen.findByRole("button", { name: "Decline detailed telemetry" });
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    expect(updateTelemetry).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "persists a detailed refusal while preserving audience %s and stays open after reload",
    async (audienceEnabled) => {
      vi.mocked(readTelemetry).mockResolvedValue({ ...initial, audience_enabled: audienceEnabled });
      let confirm: ((state: TelemetryState) => void) | undefined;
      vi.mocked(updateTelemetry).mockImplementation(
        () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
      );
      const mounted = mount();
      fireEvent.click(await screen.findByRole("button", { name: "Decline detailed telemetry" }));
      await waitFor(() =>
        expect(vi.mocked(updateTelemetry).mock.calls[0]?.[0]).toEqual({
          diagnostics_enabled: false,
          usage_enabled: false,
        }),
      );
      expect(screen.getByText("Saving your choices…")).toBeVisible();
      expect(screen.queryByText("Workspace action")).not.toBeInTheDocument();
      const rejected = { ...initial, audience_enabled: audienceEnabled, decision_version: 1 };
      confirm?.(rejected);
      expect(await screen.findByText("Workspace action")).toBeVisible();
      mounted.unmount();
      vi.mocked(readTelemetry).mockResolvedValue(rejected);
      mount();
      expect(await screen.findByText("Workspace action")).toBeVisible();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );
  it("blocks on read failures and retries without silently accepting consent", async () => {
    vi.mocked(readTelemetry).mockRejectedValueOnce(new Error("Service unavailable"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Service unavailable");
    expect(screen.queryByText("Workspace action")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Decline detailed telemetry" })).toBeVisible();
    expect(updateTelemetry).not.toHaveBeenCalled();
  });
  it("keeps the gate closed after a failed save and allows retry", async () => {
    vi.mocked(updateTelemetry).mockRejectedValueOnce(new Error("Disk full"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Decline detailed telemetry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
    expect(screen.queryByText("Workspace action")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Decline detailed telemetry" }));
    expect(await screen.findByText("Workspace action")).toBeVisible();
  });
  it("routes Skip onboarding into the same required decision once, then completes after rejection", async () => {
    context.step = "welcome";
    mount();
    expect(await screen.findByText("Welcome step")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Decline detailed telemetry" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip onboarding" }));
    expect(await screen.findByRole("button", { name: "Decline detailed telemetry" })).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Skip onboarding" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Skip step" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Decline detailed telemetry" }));
    expect(await screen.findByText("Workspace action")).toBeVisible();
    expect(context.step).toBe("completed");
  });
  it("saves the onboarding decision and advances to the final setup step without a duplicate prompt", async () => {
    context.step = "telemetry";
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Decline detailed telemetry" }));
    expect(await screen.findByText("Final onboarding step")).toBeVisible();
    expect(context.step).toBe("first_prompt");
    expect(
      screen.queryByRole("button", { name: "Decline detailed telemetry" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(updateTelemetry).toHaveBeenCalledTimes(1);
  });
  it("surfaces onboarding navigation failures while keeping the decision required", async () => {
    context.step = "welcome";
    context.navigationFailure = true;
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Skip onboarding" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save setup progress");
    expect(screen.queryByText("Workspace action")).not.toBeInTheDocument();
    context.navigationFailure = false;
    fireEvent.click(screen.getByRole("button", { name: "Skip onboarding" }));
    expect(await screen.findByRole("button", { name: "Decline detailed telemetry" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("preserves a mounted workspace after a background refresh failure with a saved decision", async () => {
    vi.mocked(readTelemetry).mockResolvedValue({ ...initial, decision_version: 1 });
    const unmounted = vi.fn();
    function Workspace() {
      useEffect(() => unmounted, []);
      return <p>Active terminal</p>;
    }
    const { client } = mount(
      <OnboardingGate>
        <Workspace />
      </OnboardingGate>,
    );
    expect(await screen.findByText("Active terminal")).toBeVisible();
    vi.mocked(readTelemetry).mockRejectedValue(new Error("Service offline"));
    await client.refetchQueries({ queryKey: ["telemetry-preferences"] });
    expect(await screen.findByText(/Your saved privacy choices remain in effect/)).toBeVisible();
    expect(screen.getByText("Active terminal")).toBeVisible();
    expect(unmounted).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("enables the monthly counter before the detailed decision and keeps it enabled after refusal", async () => {
    vi.mocked(readTelemetry).mockResolvedValue({ ...initial, audience_configured: true });
    vi.mocked(updateTelemetry).mockImplementation(async (choices) => ({
      ...initial,
      ...choices,
      audience_enabled: choices.audience_enabled ?? initial.audience_enabled,
      audience_configured: true,
      decision_version: 1,
    }));
    mount();
    await screen.findByRole("button", { name: "Enable diagnostics & usage" });
    expect(useTelemetryActivity).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText("Workspace action")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Decline detailed telemetry" }));
    expect(await screen.findByText("Workspace action")).toBeVisible();
    expect(useTelemetryActivity).toHaveBeenLastCalledWith(true);
    expect(vi.mocked(updateTelemetry).mock.calls[0]?.[0]).toEqual({
      diagnostics_enabled: false,
      usage_enabled: false,
    });
  });
  it.each([
    { audience_enabled: false, audience_configured: true },
    { audience_enabled: true, audience_configured: false },
  ])(
    "does not enable monthly activity for $audience_enabled / $audience_configured",
    async (audience) => {
      vi.mocked(readTelemetry).mockResolvedValue({ ...initial, ...audience });
      mount();
      await screen.findByRole("button", { name: "Decline detailed telemetry" });
      expect(useTelemetryActivity).not.toHaveBeenCalledWith(true);
    },
  );
  it("does not read host privacy state or show local onboarding on remote browsers", () => {
    context.remote = true;
    context.step = "welcome";
    mount();
    expect(screen.getByText("Workspace action")).toBeVisible();
    expect(readTelemetry).not.toHaveBeenCalled();
    expect(useTelemetryActivity).not.toHaveBeenCalled();
    expect(updateTelemetry).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("privacy customization", () => {
  it.each([
    { enabled: true, configured: true, status: "On by default" },
    { enabled: false, configured: true, status: "Off — your setting is kept" },
    { enabled: true, configured: false, status: "Not configured — nothing sent" },
  ])(
    "discloses the independent monthly counter state: $status",
    ({ enabled, configured, status }) => {
      mount(
        <TelemetryChoices
          state={{ ...initial, audience_enabled: enabled, audience_configured: configured }}
        />,
      );
      const counter = within(screen.getByRole("region", { name: "Monthly audience counter" }));
      expect(counter.getByText(status)).toBeVisible();
      expect(counter.getByText(/independently, even before this choice/)).toBeVisible();
      expect(counter.getByText(/These buttons do not change it/)).toBeVisible();
      expect(counter.getByText(/Turn off in Settings/)).toBeVisible();
      expect(
        screen.getByText(
          "Your code, prompts, agent replies and terminal output are never included.",
        ),
      ).toBeVisible();
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    },
  );
  it("offers plain benefits and keeps exact data details available in a disclosure", async () => {
    mount(<TelemetryChoices state={initial} />);
    expect(screen.getByRole("heading", { name: "Fix bugs faster" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Improve useful features" })).toBeVisible();
    expect(screen.getByText("Send technical error reports to Sentry.")).toBeVisible();
    expect(screen.getByText("Share basic usage statistics with PostHog.")).toBeVisible();
    expect(screen.getByText(/Both are off until enabled/)).toBeVisible();
    const summary = screen.getByText("What is shared?");
    const disclosure = summary.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    await userEvent.setup().click(summary);
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText(/curated error categories and app stack positions/)).toBeVisible();
    expect(screen.getByText(/Raw error messages and stack source text stay local/)).toBeVisible();
    expect(screen.getByText(/random installation ID, which links reports/)).toBeVisible();
    expect(screen.getByText(/Workspace file paths, repository names, log files/)).toBeVisible();
    expect(screen.getByText(/PostHog receives the connection IP/)).toBeVisible();
    expect(updateTelemetry).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "offers only detailed switches and preserves audience %s when saving",
    async (audienceEnabled) => {
      mount(<TelemetryChoices state={{ ...initial, audience_enabled: audienceEnabled }} />);
      fireEvent.click(screen.getByRole("button", { name: "Customize" }));
      expect(screen.getAllByRole("switch")).toHaveLength(2);
      expect(screen.getByRole("switch", { name: "Technical diagnostics" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(screen.getByRole("switch", { name: "Usage analytics" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(
        screen.queryByRole("switch", { name: "Monthly audience counter" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/independently, even before this choice/)).toBeVisible();
      expect(screen.getByText(/These buttons do not change it/)).toBeVisible();
      fireEvent.click(screen.getByRole("switch", { name: "Technical diagnostics" }));
      fireEvent.click(screen.getByRole("button", { name: "Save my choices" }));
      await waitFor(() =>
        expect(vi.mocked(updateTelemetry).mock.calls[0]?.[0]).toEqual({
          diagnostics_enabled: true,
          usage_enabled: false,
        }),
      );
    },
  );
  it.each([true, false])(
    "allows detailed telemetry while preserving audience %s",
    async (audienceEnabled) => {
      mount(<TelemetryChoices state={{ ...initial, audience_enabled: audienceEnabled }} />);
      fireEvent.click(screen.getByRole("button", { name: "Enable diagnostics & usage" }));
      await waitFor(() =>
        expect(vi.mocked(updateTelemetry).mock.calls[0]?.[0]).toEqual({
          diagnostics_enabled: true,
          usage_enabled: true,
        }),
      );
    },
  );
  it("keeps a counter opt-out made externally after the dialog snapshot was read", async () => {
    const confirmed = { ...initial, audience_enabled: false, decision_version: 1 };
    vi.mocked(updateTelemetry).mockResolvedValue(confirmed);
    const { client } = mount(<TelemetryChoices state={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline detailed telemetry" }));
    await waitFor(() =>
      expect(vi.mocked(updateTelemetry).mock.calls[0]?.[0]).toEqual({
        diagnostics_enabled: false,
        usage_enabled: false,
      }),
    );
    await waitFor(() => expect(client.getQueryData(["telemetry-preferences"])).toEqual(confirmed));
  });
});
