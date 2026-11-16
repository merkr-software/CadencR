import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginTabActivity } from "@/api/generated";
import { setPluginTabActivityOpen } from "@/lib/plugin-tabs/runtime-store";
import { render, screen, within } from "@/test-utils";

import { PluginTabActivityDialog } from "./PluginTabActivityDialog";
import { pluginTabSummary } from "./plugin-tab-fixtures";

const mocks = vi.hoisted(() => ({
  activity: null as PluginTabActivity | null,
  stop: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => {
  const { useMutation, useQuery } = await import("@tanstack/react-query");
  return {
    ...(await importOriginal<typeof import("@/api/generated")>()),
    usePluginTabActivity: () =>
      useQuery({ queryKey: ["/api/plugin-tabs/x/activity"], queryFn: () => mocks.activity }),
    usePluginTabStopBackend: () => useMutation({ mutationFn: mocks.stop }),
  };
});

const INSTANCE = "7:plugin:monitor";

const SUMMARY = pluginTabSummary({
  id: "monitor",
  name: "Port monitor",
  access_level: "backend",
  commands: [{ program: "git", reasoning: "History." }],
  backend: {
    protocol: 1,
    binary: { "darwin-aarch64": "bin/darwin-aarch64/ports" },
    reasoning: "Ports.",
  },
});

afterEach(() => act(() => setPluginTabActivityOpen(null)));

function renderOpen() {
  render(<PluginTabActivityDialog instanceId={INSTANCE} featureId={7} summary={SUMMARY} />);
  act(() => setPluginTabActivityOpen(INSTANCE));
}

describe("PluginTabActivityDialog", () => {
  it("stays closed until its instance is opened", () => {
    render(<PluginTabActivityDialog instanceId={INSTANCE} featureId={7} summary={SUMMARY} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => setPluginTabActivityOpen("7:plugin:other"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists the commands run, refusals included, and the running backend with its log", async () => {
    mocks.activity = {
      commands: [
        {
          program: "bash",
          args: ["-c", "x"],
          started_at: new Date().toISOString(),
          duration_ms: 0,
          outcome: "refused",
          error: "`bash` is not in this tab's commands",
        },
        {
          program: "git",
          args: ["log", "-1"],
          started_at: new Date().toISOString(),
          duration_ms: 12,
          outcome: "exited",
          exit_code: 0,
        },
      ],
      backend: {
        state: "running",
        restart_held: false,
        pid: 4242,
        started_at: new Date().toISOString(),
        starts: 1,
        stderr_tail: ["backend ready"],
      },
    };
    renderOpen();
    const dialog = await screen.findByRole("dialog", { name: "Port monitor activity" });
    expect(within(dialog).getByText("Native code")).toBeInTheDocument();
    const commands = await within(dialog).findByRole("list", { name: "Commands run" });
    expect(within(commands).getByText("bash -c x")).toBeInTheDocument();
    expect(within(commands).getByText("Refused")).toBeInTheDocument();
    expect(within(commands).getByText("git log -1")).toBeInTheDocument();
    expect(within(commands).getByText("Exit 0")).toBeInTheDocument();
    expect(
      within(dialog).getByText("bin/darwin-aarch64/ports (darwin-aarch64)"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Running as process 4242/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Backend log")).toHaveTextContent("backend ready");
    await userEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    expect(mocks.stop).toHaveBeenCalledWith({ id: "monitor", featureId: 7 }, expect.anything());
  });

  it("shows a backend still getting ready as starting, with nothing to stop yet", async () => {
    mocks.activity = {
      commands: [],
      backend: { state: "starting", restart_held: false, pid: 5151, starts: 1, stderr_tail: [] },
    };
    renderOpen();
    const dialog = await screen.findByRole("dialog");
    const status = await within(dialog).findByText(/^Starting…/);
    expect(status).toHaveTextContent("Starting… waiting for process 5151 to be ready.");
    expect(status).toHaveAttribute("role", "status");
    expect(within(dialog).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("says why refused starts are held and offers to allow a restart", async () => {
    mocks.activity = {
      commands: [],
      backend: {
        state: "stopped",
        restart_held: true,
        start_error:
          "the tab's backend /x/bin/ports differs from the binary its signed package names; reinstall the tab from the marketplace",
        exited_at: new Date().toISOString(),
        exit_reason: "its tab was closed",
        starts: 6,
        stderr_tail: ["[cadencr] the backend could not start: …"],
      },
    };
    renderOpen();
    const dialog = await screen.findByRole("dialog");
    const headline = await within(dialog).findByText(/^Couldn't start:/);
    expect(headline).toHaveTextContent(
      "Couldn't start: the tab's backend /x/bin/ports differs from the binary its signed package names; reinstall the tab from the marketplace. Cadencr won't start it again until you allow a restart. Started 6 times.",
    );
    expect(within(dialog).queryByText(/its tab was closed/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Allow restart" }));
    expect(mocks.stop).toHaveBeenCalledWith({ id: "monitor", featureId: 7 }, expect.anything());
  });

  it("offers no restart for a stopped backend whose starts aren't held", async () => {
    mocks.activity = {
      commands: [],
      backend: {
        state: "stopped",
        restart_held: false,
        exit_reason: "its tab was closed",
        starts: 1,
        stderr_tail: [],
      },
    };
    renderOpen();
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Stopped: its tab was closed\./)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Allow restart" })).toBeNull();
  });

  it("says a backend that never started will start on the first request", async () => {
    mocks.activity = { commands: [], backend: null };
    renderOpen();
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Not started yet/)).toBeInTheDocument();
    expect(within(dialog).getByText(/No command has run/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Stop" })).toBeNull();
  });
});
