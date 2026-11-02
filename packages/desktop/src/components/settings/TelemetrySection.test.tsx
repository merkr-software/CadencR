import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetrySection } from "./TelemetrySection";
import {
  readTelemetry,
  updateTelemetry,
  resetTelemetryIdentity,
  type TelemetryState,
} from "@/api/telemetry";

const context = vi.hoisted(() => ({ remote: false }));
vi.mock("@/lib/remote/device-token", () => ({ isBrowserRemote: () => context.remote }));
vi.mock("@/api/telemetry", () => ({
  TELEMETRY_QUERY_KEY: ["telemetry-preferences"],
  needsTelemetryDecision: (state: TelemetryState) => state.decision_version === null,
  readTelemetry: vi.fn(),
  updateTelemetry: vi.fn(),
  resetTelemetryIdentity: vi.fn(),
}));
vi.mock("@/lib/desktop-bridge", () => ({
  desktopBridge: { telemetryRelayStatus: () => Promise.resolve("idle") },
}));
const initial: TelemetryState = {
  diagnostics_enabled: false,
  usage_enabled: false,
  audience_enabled: true,
  audience_configured: false,
  audience_status: "not_configured",
  decision_version: 1,
  installation_id: null,
  diagnostics_configured: false,
  usage_configured: false,
  diagnostics_status: "disabled",
  usage_status: "disabled",
};
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TelemetrySection />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  context.remote = false;
  vi.mocked(readTelemetry).mockResolvedValue(initial);
});
describe("telemetry preferences", () => {
  it("starts with separate detailed off switches and the independent audience switch on and explains the data boundary", async () => {
    mount();
    expect(await screen.findByRole("switch", { name: "Technical diagnostics" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "Usage analytics" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.getByRole("switch", { name: "Monthly audience counter" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByText(/sends independently, including before your detailed telemetry choice/),
    ).toBeVisible();
    expect(screen.getByText(/No prompts, agent replies, code/)).toBeVisible();
  });
  it("waits for confirmed state and preserves the independent usage choice", async () => {
    let confirm: ((state: TelemetryState) => void) | undefined;
    vi.mocked(updateTelemetry).mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    mount();
    const diagnostics = await screen.findByRole("switch", { name: "Technical diagnostics" });
    fireEvent.click(diagnostics);
    await waitFor(() =>
      expect(vi.mocked(updateTelemetry).mock.calls[0]?.[0]).toEqual({
        diagnostics_enabled: true,
        usage_enabled: false,
        audience_enabled: true,
      }),
    );
    expect(diagnostics).toHaveAttribute("aria-checked", "false");
    expect(diagnostics).toBeDisabled();
    expect(screen.getByText("Saving…")).toBeVisible();
    confirm?.({ ...initial, diagnostics_enabled: true, diagnostics_status: "not_configured" });
    await waitFor(() => expect(diagnostics).toHaveAttribute("aria-checked", "true"));
    expect(screen.getAllByText(/Not configured in this build/)).toHaveLength(2);
    expect(screen.getByRole("switch", { name: "Usage analytics" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
  it("opts out of the monthly audience counter independently of detailed tracking", async () => {
    vi.mocked(updateTelemetry).mockResolvedValue({
      ...initial,
      audience_enabled: false,
      audience_status: "disabled",
    });
    mount();
    fireEvent.click(await screen.findByRole("switch", { name: "Monthly audience counter" }));
    await waitFor(() =>
      expect(vi.mocked(updateTelemetry).mock.calls[0]?.[0]).toEqual({
        diagnostics_enabled: false,
        usage_enabled: false,
        audience_enabled: false,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Monthly audience counter" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    expect(screen.getByText("Detailed telemetry decision saved.")).toBeVisible();
  });
  it("leaves consent off and shows an inline failure when saving fails", async () => {
    vi.mocked(updateTelemetry).mockRejectedValue(new Error("Service disconnected"));
    mount();
    const diagnostics = await screen.findByRole("switch", { name: "Technical diagnostics" });
    fireEvent.click(diagnostics);
    expect(await screen.findByRole("alert")).toHaveTextContent("Service disconnected");
    expect(diagnostics).toHaveAttribute("aria-checked", "false");
    vi.mocked(resetTelemetryIdentity).mockResolvedValue(initial);
    fireEvent.click(screen.getByRole("button", { name: "Reset telemetry ID" }));
    expect(await screen.findByText(/Telemetry ID reset/)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("resets identity through the service without altering choices", async () => {
    vi.mocked(resetTelemetryIdentity).mockResolvedValue({ ...initial, installation_id: "new-id" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Reset telemetry ID" }));
    expect(await screen.findByText(/Telemetry ID reset/)).toBeVisible();
    expect(resetTelemetryIdentity).toHaveBeenCalledTimes(1);
    expect(updateTelemetry).not.toHaveBeenCalled();
  });
});

it("explains local-only management without polling protected endpoints on remote devices", () => {
  context.remote = true;
  mount();
  expect(screen.getByText(/Manage telemetry from the local Cadencr desktop/)).toBeVisible();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(readTelemetry).not.toHaveBeenCalled();
});
