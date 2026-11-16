import { afterEach, describe, expect, it, vi } from "vitest";
import { sendShutdownIntent } from "./shutdown-intent";

describe("sendShutdownIntent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tells the service to keep the agents it stops stopped", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetch);

    await sendShutdownIntent("http://127.0.0.1:5004", "token", { resumeAgents: false });

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5004/api/restart-continuations/shutdown-intent",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ resume_agents: false }),
        headers: expect.objectContaining({ "x-cadencr-token": "token" }),
      }),
    );
  });

  it("sets resuming back when a quit fails after stopping was recorded", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetch);

    await sendShutdownIntent("http://127.0.0.1:5004", "token", { resumeAgents: true });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ resume_agents: true }) }),
    );
  });

  it("fails loudly when the service does not record it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
    );
    await expect(
      sendShutdownIntent("http://127.0.0.1:5004", null, { resumeAgents: false }),
    ).rejects.toThrow(
      "could not record that your agents should stay stopped: the service returned 401",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    await expect(
      sendShutdownIntent("http://127.0.0.1:5004", null, { resumeAgents: false }),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
