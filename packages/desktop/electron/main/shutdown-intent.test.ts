import { afterEach, describe, expect, it, vi } from "vitest";
import { QUIT_WITHOUT_ASKING, RESUME_AGENTS } from "../../src/shared/app-close";
import { beforeQuitStep, recordQuitIntent, sendShutdownIntent } from "./shutdown-intent";

const STOP_AGENTS = { resumeAgents: false, resumeBackgroundWork: false };

describe("sendShutdownIntent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tells the service to keep the agents it stops stopped", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetch);

    await sendShutdownIntent("http://127.0.0.1:5004", "token", STOP_AGENTS);

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5004/api/restart-continuations/shutdown-intent",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ resume_agents: false, resume_background_work: false }),
        headers: expect.objectContaining({ "x-cadencr-token": "token" }),
      }),
    );
  });

  it("keeps only background work stopped after a quit nobody was asked about", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetch);

    await sendShutdownIntent("http://127.0.0.1:5004", "token", QUIT_WITHOUT_ASKING);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ resume_agents: true, resume_background_work: false }),
      }),
    );
  });

  it("sets resuming back when a quit fails after stopping was recorded", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetch);

    await sendShutdownIntent("http://127.0.0.1:5004", "token", RESUME_AGENTS);

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ resume_agents: true, resume_background_work: true }),
      }),
    );
  });

  it("fails loudly when the service does not record it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 401 }))),
    );
    await expect(
      sendShutdownIntent("http://127.0.0.1:5004", null, QUIT_WITHOUT_ASKING),
    ).rejects.toThrow(
      "could not record that your agents should stay stopped: the service returned 401",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    await expect(sendShutdownIntent("http://127.0.0.1:5004", null, STOP_AGENTS)).rejects.toThrow(
      "ECONNREFUSED",
    );
  });
});

describe("recordQuitIntent", () => {
  const quitting = { quitting: true };
  const recorder = (outcome: Promise<void> = Promise.resolve()) => ({
    setShutdownIntent: vi.fn(() => outcome),
  });

  it("records nothing when everything resumes or the service keeps running", async () => {
    const service = recorder();
    const report = vi.fn();

    expect(await recordQuitIntent(service, quitting, RESUME_AGENTS, report)).toBe(false);
    // Closing the window on macOS leaves the service up: a later update must resume.
    expect(await recordQuitIntent(service, { quitting: false }, QUIT_WITHOUT_ASKING, report)).toBe(
      false,
    );
    expect(await recordQuitIntent(null, quitting, STOP_AGENTS, report)).toBe(false);
    expect(service.setShutdownIntent).not.toHaveBeenCalled();
  });

  it("records a quit that keeps background work stopped", async () => {
    const service = recorder();

    expect(await recordQuitIntent(service, quitting, QUIT_WITHOUT_ASKING, vi.fn())).toBe(true);
    expect(service.setShutdownIntent).toHaveBeenCalledWith(QUIT_WITHOUT_ASKING);
  });

  it("blocks the quit only over an answer the user gave", async () => {
    const failure = () => recorder(Promise.reject(new Error("ECONNREFUSED")));
    const report = vi.fn();

    await expect(recordQuitIntent(failure(), quitting, STOP_AGENTS, report)).rejects.toThrow(
      "ECONNREFUSED",
    );
    expect(await recordQuitIntent(failure(), quitting, QUIT_WITHOUT_ASKING, report)).toBe(false);
    expect(report).toHaveBeenCalledWith("ECONNREFUSED");
  });
});

describe("beforeQuitStep", () => {
  const step = (allowClose: boolean, hasWindow: boolean, shutdownReady = false) =>
    beforeQuitStep({ allowClose, hasWindow, shutdownReady });

  it("lets the window ask the user first", () => {
    expect(step(false, true)).toBe("ask-window");
  });

  it("records a quit nobody could be asked about, then stops the service", () => {
    // The window was closed on macOS, then Cadencr quit from the Dock.
    expect(step(false, false)).toBe("stop-unasked");
  });

  it("stops a settled quit as it is, then lets it through", () => {
    expect(step(true, false)).toBe("stop");
    expect(step(true, true, true)).toBe("quit");
  });
});
