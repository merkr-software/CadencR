import { describe, expect, it, vi } from "vitest";
import { createServiceSupervisor } from "./service-supervisor";

const EXIT = { code: 1, signal: null, detail: "Service exit: code=1 signal=null." };

describe("service supervisor", () => {
  it("reports a service that died on its own", () => {
    const publish = vi.fn();
    const supervisor = createServiceSupervisor({ respawn: vi.fn(), publish });

    supervisor.reportExit(EXIT);

    expect(publish).toHaveBeenCalledWith({ state: "down", detail: EXIT.detail });
    expect(supervisor.status()).toEqual({ state: "down", detail: EXIT.detail });
  });

  it("restarts a dead service and reports each stage", async () => {
    const publish = vi.fn();
    const respawn = vi.fn(() => Promise.resolve());
    const supervisor = createServiceSupervisor({ respawn, publish });
    supervisor.reportExit(EXIT);

    await supervisor.restart();

    expect(respawn).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls.map(([status]) => status.state)).toEqual([
      "down",
      "restarting",
      "running",
    ]);
  });

  it("stays down with the reason when the restart fails", async () => {
    const publish = vi.fn();
    const respawn = vi.fn(() => Promise.reject(new Error("port 5004 is already in use")));
    const supervisor = createServiceSupervisor({ respawn, publish });
    supervisor.reportExit(EXIT);

    await expect(supervisor.restart()).resolves.toBeUndefined();

    expect(supervisor.status()).toEqual({ state: "down", detail: "port 5004 is already in use" });
  });

  it("refuses to restart a running service", async () => {
    const respawn = vi.fn();
    const supervisor = createServiceSupervisor({ respawn, publish: vi.fn() });

    await expect(supervisor.restart()).rejects.toThrow("The service is already running.");
    expect(respawn).not.toHaveBeenCalled();
  });

  it("ignores exits once the app is shutting down", () => {
    const publish = vi.fn();
    const supervisor = createServiceSupervisor({ respawn: vi.fn(), publish });

    supervisor.stopSupervising();
    supervisor.reportExit(EXIT);

    expect(publish).not.toHaveBeenCalled();
    expect(supervisor.status()).toEqual({ state: "running" });
  });
});
