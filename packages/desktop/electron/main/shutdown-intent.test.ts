import { afterEach, describe, expect, it, vi } from "vitest";
import { QUIT_WITHOUT_ASKING, RESUME_AGENTS } from "../../src/shared/app-close";
import {
  beforeQuitStep,
  QuitIntentRecording,
  recordQuitIntent,
  sendShutdownIntent,
} from "./shutdown-intent";

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
  type Flags = Parameters<typeof beforeQuitStep>[0];
  const flags = ["allowClose", "hasWindow", "quitAnswered", "shutdownReady"] as const;
  const every: Flags[] = Array.from({ length: 16 }, (_, bits) => ({
    allowClose: Boolean(bits & 1),
    hasWindow: Boolean(bits & 2),
    quitAnswered: Boolean(bits & 4),
    shutdownReady: Boolean(bits & 8),
  }));
  const label = (state: Flags) => flags.filter((flag) => state[flag]).join("+") || "none";

  it.each(every.map((state) => [label(state), state] as const))("%s", (_, state) => {
    const step = beforeQuitStep(state);
    if (!state.allowClose && state.hasWindow) {
      // The window asks the user first.
      expect(step).toBe("ask-window");
    } else if (state.shutdownReady) {
      expect(step).toBe("quit");
    } else if (state.quitAnswered) {
      // The dialog's (or an update's) intent is already recorded.
      expect(step).toBe("stop");
    } else {
      // Nobody was asked, whatever allowClose and the window say.
      expect(step).toBe("stop-unasked");
    }
  });

  it("records the Dock quit after a window closed normally on macOS", () => {
    expect(
      beforeQuitStep({
        allowClose: true,
        hasWindow: false,
        quitAnswered: false,
        shutdownReady: false,
      }),
    ).toBe("stop-unasked");
  });
});

describe("QuitIntentRecording", () => {
  const recorder = (outcome: Promise<void>) => ({ setShutdownIntent: vi.fn(() => outcome) });
  function held() {
    let release: () => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    return { promise, release, fail };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("makes a second quit wait for the PUT still in flight before stopping", async () => {
    const recording = new QuitIntentRecording();
    const put = held();
    const service = recorder(put.promise);
    void recording.track(
      recordQuitIntent(service, { quitting: true }, STOP_AGENTS, vi.fn()).then(),
    );
    const stop = vi.fn(() => Promise.resolve());

    const second = recording.stopWhenReady("stop", vi.fn(), stop);
    await settle();
    expect(service.setShutdownIntent).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    put.release();
    await second;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops nothing after a recording that failed: the first quit reports it", async () => {
    const recording = new QuitIntentRecording();
    const put = held();
    const first = recording.track(
      recordQuitIntent(recorder(put.promise), { quitting: true }, STOP_AGENTS, vi.fn()).then(),
    );
    const stop = vi.fn(() => Promise.resolve());
    const second = recording.stopWhenReady("stop", vi.fn(), stop);

    put.fail(new Error("ECONNREFUSED"));
    await expect(first).rejects.toThrow("ECONNREFUSED");
    await second;
    expect(stop).not.toHaveBeenCalled();
  });

  it("records a quit nobody answered before stopping", async () => {
    const recording = new QuitIntentRecording();
    const order: string[] = [];
    await recording.stopWhenReady(
      "stop-unasked",
      async () => void order.push("record"),
      async () => void order.push("stop"),
    );
    expect(order).toEqual(["record", "stop"]);
  });
});
