import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteStatus } from "@/api/generated";

const remoteStatus = vi.fn();
const remoteDisable = vi.fn();

vi.mock("@/api/generated", () => ({
  remoteStatus: (...args: unknown[]) => remoteStatus(...args),
  remoteEnable: vi.fn(),
  remoteDisable: (...args: unknown[]) => remoteDisable(...args),
  remoteRevokeDevice: vi.fn(),
  remoteSetTunnelHost: vi.fn(),
}));

import { uiI18n } from "@/lib/i18n/ui";
import { useRemoteStore, remoteFailureMessage } from "./remote-store";

function status(): RemoteStatus {
  return {
    enabled: false,
    connected_devices: 0,
    pairing_state: "none",
    devices: [],
    audit_tail: [],
    lan_urls: [],
  } as RemoteStatus;
}

/** A promise plus its resolver, so a test can hold `refresh()` in-flight. */
function deferred(): { promise: Promise<RemoteStatus>; resolve: (value: RemoteStatus) => void } {
  let resolve!: (value: RemoteStatus) => void;
  const promise = new Promise<RemoteStatus>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("remote-store refresh single-flight", () => {
  beforeEach(() => {
    remoteStatus.mockReset();
    useRemoteStore.setState({
      status: null,
      statusAt: 0,
      loaded: false,
      phase: "idle",
      error: null,
    });
  });

  it("coalesces overlapping refreshes into one request", async () => {
    const gate = deferred();
    remoteStatus.mockReturnValueOnce(gate.promise);

    const first = useRemoteStore.getState().refresh();
    const second = useRemoteStore.getState().refresh();

    expect(remoteStatus).toHaveBeenCalledTimes(1);

    gate.resolve(status());
    await Promise.all([first, second]);

    expect(useRemoteStore.getState().loaded).toBe(true);
  });

  it("fetches again once the in-flight refresh has settled", async () => {
    remoteStatus.mockResolvedValue(status());

    await useRemoteStore.getState().refresh();
    await useRemoteStore.getState().refresh();

    expect(remoteStatus).toHaveBeenCalledTimes(2);
  });

  it.each([{ fingerprint: 123 }, { tunnel_host: {} }, { port: "5006" }, { lan_urls: [123] }])(
    "rejects malformed certificate/origin metadata before it enters the UI: %j",
    async (invalid) => {
      remoteStatus.mockResolvedValue({ ...status(), ...invalid });
      await useRemoteStore.getState().refresh();
      expect(useRemoteStore.getState().status).toBeNull();
      const failure = useRemoteStore.getState().error;
      expect(failure?.kind).toBe("malformed");
      if (!failure) throw new Error("Expected a malformed status");
      expect(remoteFailureMessage(uiI18n.getFixedT("en", "ui"), failure)).toBe(
        "Malformed remote status response.",
      );
      expect(remoteFailureMessage(uiI18n.getFixedT("cimode", "ui"), failure)).toBe(
        "remote.host.errors.malformed",
      );
      expect(useRemoteStore.getState().phase).toBe("idle");
    },
  );
});

const rendererPath = "/tmp/Mon projet 日本語/index.html";

it.each([
  [
    { code: "REMOTE_RENDERER_INDEX_MISSING", path: rendererPath },
    { kind: "missingIndex", path: rendererPath },
  ],
  [{ code: "REMOTE_RENDERER_DIRECTORY_MISSING" }, { kind: "unpackaged" }],
  [
    { code: "REMOTE_RENDERER_INDEX_MISSING", path: 42 },
    { kind: "detail", message: "Filesystem: échec 57" },
  ],
  [undefined, { kind: "detail", message: "Filesystem: échec 57" }],
])(
  "uses structured renderer details and falls back to raw diagnostics: %j",
  async (details, expected) => {
    remoteStatus.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "SERVICE_UNAVAILABLE", error: "Filesystem: échec 57", details } },
    });
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().error).toEqual(expected);
  },
);

describe("remote-store polls once loaded", () => {
  beforeEach(async () => {
    remoteStatus.mockReset();
    useRemoteStore.setState({
      status: null,
      loaded: false,
      phase: "idle",
      error: null,
      pollError: null,
    });
    remoteStatus.mockResolvedValue(status());
    const firstLoad = useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().phase).toBe("loading");
    await firstLoad;
  });

  it("leaves the phase and an action's error alone, and keeps an unchanged status", async () => {
    const before = useRemoteStore.getState();
    useRemoteStore.setState({ error: { kind: "detail", message: "Could not revoke the device." } });
    const gate = deferred();
    remoteStatus.mockReturnValueOnce(gate.promise);

    const poll = useRemoteStore.getState().refresh();
    const sentBy = performance.now();
    expect(useRemoteStore.getState().phase).toBe("idle");
    gate.resolve(status());
    await poll;

    const after = useRemoteStore.getState();
    expect(after.status).toBe(before.status);
    expect(after.statusAt).toBeGreaterThan(before.statusAt);
    expect(after.statusAt).toBeLessThanOrEqual(sentBy);
    expect(after.error).toEqual({ kind: "detail", message: "Could not revoke the device." });
  });

  it("reports a failed poll until a poll succeeds", async () => {
    remoteStatus.mockRejectedValueOnce(new Error("offline"));
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().pollError).toEqual({ kind: "detail", message: "offline" });
    expect(useRemoteStore.getState().error).toBeNull();

    remoteStatus.mockResolvedValueOnce({ ...status(), pairing_state: "consumed" });
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().pollError).toBeNull();
    expect(useRemoteStore.getState().status?.pairing_state).toBe("consumed");
  });

  it("drops a poll answered after an action wrote a newer status", async () => {
    const gate = deferred();
    remoteStatus.mockReturnValueOnce(gate.promise);
    const poll = useRemoteStore.getState().refresh();
    remoteDisable.mockResolvedValueOnce({ ...status(), enabled: false, connected_devices: 3 });
    await useRemoteStore.getState().disable();
    gate.resolve({ ...status(), enabled: true });
    await poll;
    expect(useRemoteStore.getState().status?.connected_devices).toBe(3);
  });
});
