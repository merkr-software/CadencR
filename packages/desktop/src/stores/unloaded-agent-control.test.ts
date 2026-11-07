import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const api = vi.hoisted(() => ({
  interruptAgentSession: vi.fn(),
  suspendAgentSession: vi.fn(),
}));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  ...api,
}));

const { stopUnloadedAgents, suspendUnloadedAgents } = await import("./unloaded-agent-control");

function serviceError(status: number, code: string, error: string): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(error, String(status), config, null, {
    status,
    statusText: "",
    headers: {},
    config,
    data: { code, error },
  });
}

describe("stopUnloadedAgents", () => {
  afterEach(() => {
    vi.clearAllMocks();
    api.interruptAgentSession.mockReset();
  });

  it("shows the stop in flight, then that it was acknowledged", async () => {
    const { loading, success } = toast;
    let acknowledge: () => void = () => undefined;
    api.interruptAgentSession.mockImplementation(
      () => new Promise<void>((resolve) => (acknowledge = resolve)),
    );

    const stopping = stopUnloadedAgents([4]);
    expect(loading).toHaveBeenCalledWith("Stopping 1 agent…", expect.anything());
    expect(success).not.toHaveBeenCalled();
    acknowledge();
    await stopping;

    expect(api.interruptAgentSession).toHaveBeenCalledWith(4);
    expect(success).toHaveBeenCalledWith("Stopped 1 agent", expect.anything());
  });

  it("counts a turn that already ended as stopped, and reports a refused stop", async () => {
    const { error } = toast;
    api.interruptAgentSession.mockImplementation((id: number) =>
      Promise.reject(
        id === 1
          ? serviceError(409, "NOTHING_TO_STOP", "Session not active")
          : serviceError(502, "SDK_ERROR", "stdin is closed"),
      ),
    );

    await stopUnloadedAgents([1, 2]);

    expect(error).toHaveBeenCalledWith("Couldn't stop 1 agent", {
      id: "stop-unloaded-agents:failed",
      description: "stdin is closed",
    });
  });

  it("does nothing without agents to reach", async () => {
    await stopUnloadedAgents([]);
    expect(api.interruptAgentSession).not.toHaveBeenCalled();
  });
});

describe("suspendUnloadedAgents", () => {
  afterEach(() => {
    vi.clearAllMocks();
    api.suspendAgentSession.mockReset();
  });

  it("pauses each agent and warns about the ones that kept running", async () => {
    const { warning } = toast;
    api.suspendAgentSession
      .mockResolvedValueOnce({ accepted: true })
      .mockRejectedValueOnce(serviceError(500, "DB_ERROR", "disk full"));

    await suspendUnloadedAgents([5, 6]);

    expect(api.suspendAgentSession.mock.calls).toEqual([[5], [6]]);
    expect(warning).toHaveBeenCalledWith(
      "1 agent kept running into sleep",
      expect.objectContaining({ description: "disk full" }),
    );
  });
});
