import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import type { RemoteDevice, RemoteStatus } from "@/api/generated";
import { uiI18n } from "@/lib/i18n/ui";
import { pairingTargets, RemotePairSection } from "./RemotePairSection";

interface StoreState {
  refresh: () => Promise<void>;
  revokeDevice: (id: number) => Promise<void>;
  statusAt: number;
  status: { pairing_state: RemoteStatus["pairing_state"]; devices: RemoteDevice[] };
}

// A tiny reactive stand-in for the remote store: polls are simulated by
// `report`, which publishes a status as if requested at `requestedAt`.
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state = {} as StoreState;
  return {
    get: () => state,
    reset: (next: StoreState) => {
      state = next;
    },
    set: (patch: Partial<StoreState>) => {
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
const mint = vi.hoisted(() => vi.fn());
vi.mock("@/api/generated", () => ({ remotePairingCode: mint }));
vi.mock("@/stores/remote-store", async () => {
  const { useSyncExternalStore } = await import("react");
  const useRemoteStore = <T,>(selector: (state: StoreState) => T): T =>
    useSyncExternalStore(store.subscribe, () => selector(store.get()));
  useRemoteStore.getState = store.get;
  return { useRemoteStore };
});
vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="pairing-qr">{value}</div>,
}));

const fingerprint = Array.from({ length: 32 }, () => "AB").join(":");
const status: RemoteStatus = {
  enabled: true,
  port: 5006,
  fingerprint,
  tunnel_host: null,
  lan_urls: ["https://100.97.1.2:5006/", "https://192.168.1.5:5006/"],
  pairing_state: "none",
  connected_devices: 0,
  devices: [],
  audit_tail: [],
};
const ipad: RemoteDevice = { id: 1, label: "Old iPad", created_at: "2026-11-20 10:00:00" };
const iphone: RemoteDevice = { id: 2, label: "iPhone", created_at: "2026-11-26 08:00:00" };

function minted(code: string, urls = status.lan_urls) {
  return { code, expires_in_secs: 120, fingerprint, urls: urls.map((u) => `${u}#code=${code}`) };
}

function report(
  pairingState: RemoteStatus["pairing_state"],
  devices: RemoteDevice[],
  requestedAt: number,
) {
  act(() => store.set({ status: { pairing_state: pairingState, devices }, statusAt: requestedAt }));
}

beforeEach(() => {
  mint.mockReset();
  mint.mockResolvedValue(minted("secret-code"));
  store.reset({
    refresh: vi.fn(() => Promise.resolve()),
    revokeDevice: vi.fn(() => Promise.resolve()),
    statusAt: 0,
    status: { pairing_state: "none", devices: [ipad] },
  });
});
afterEach(() => vi.useRealTimers());

describe("pairing targets", () => {
  it("offers a tunnel first, then the local network, then Tailscale", () => {
    const targets = pairingTargets({ ...status, tunnel_host: "machine.tailnet.ts.net" });
    expect(targets.map((t) => [new URL(t.origin).host, t.kind])).toEqual([
      ["machine.tailnet.ts.net", "tunnel"],
      ["192.168.1.5:5006", "lan"],
      ["100.97.1.2:5006", "tailscale"],
    ]);
  });

  it("keeps a listener address named as the tunnel on its self-signed certificate", () => {
    const targets = pairingTargets({ ...status, tunnel_host: "192.168.1.5:5006" });
    expect(targets.find((t) => t.origin === "https://192.168.1.5:5006")?.kind).toBe("lan");
  });
});

describe("RemotePairSection", () => {
  it("shows the QR at once, with the certificate warning step for a local address", async () => {
    render(<RemotePairSection status={status} />);
    expect(screen.getByRole("img", { name: "Creating a code" })).toBeInTheDocument();
    expect(screen.queryByText(/code expired/i)).not.toBeInTheDocument();
    expect(await screen.findByTestId("pairing-qr")).toHaveTextContent(
      "https://192.168.1.5:5006/#code=secret-code",
    );
    expect(screen.getByText("Continue past the privacy warning")).toBeInTheDocument();
    expect(screen.getByText("AB:AB:AB:AB:AB:AB:AB:AB")).toBeInTheDocument();
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("drops the warning step for a browser-trusted tunnel", async () => {
    mint.mockResolvedValue(
      minted("secret-code", ["https://machine.tailnet.ts.net/", ...status.lan_urls]),
    );
    render(<RemotePairSection status={{ ...status, tunnel_host: "machine.tailnet.ts.net" }} />);
    expect(await screen.findByTestId("pairing-qr")).toHaveTextContent(
      "https://machine.tailnet.ts.net/#code=secret-code",
    );
    expect(screen.queryByText("Continue past the privacy warning")).not.toBeInTheDocument();
  });

  it("shows no code when the certificate changed under the dialog", async () => {
    mint.mockResolvedValue({ ...minted("secret"), fingerprint: "changed" });
    render(<RemotePairSection status={status} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/certificate changed/i);
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show a new code" })).toBeInTheDocument();
  });

  it("translates the host-disabled rejection while the mint error is visible", async () => {
    uiI18n.addResource(
      "fr",
      "ui",
      "remote.pairing.code.errors.disabled",
      "Activez l’accès distant avant d’associer un appareil.",
    );
    mint.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        data: {
          code: "CONFLICT",
          error: "A diagnostic independent of the reason",
          details: { code: "REMOTE_PAIRING_DISABLED" },
        },
      },
    });
    try {
      render(<RemotePairSection status={status} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /^Conflict: Enable remote access before pairing$/,
      );
      await act(() => uiI18n.changeLanguage("fr"));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Activez l’accès distant avant d’associer un appareil.",
      );
      expect(mint).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
    } finally {
      await act(() => uiI18n.changeLanguage("en"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
  });

  it("keeps the diagnostic of a generic conflict when minting", async () => {
    const diagnostic = "Conflict: the host returned an unknown error";
    mint.mockRejectedValueOnce({
      isAxiosError: true,
      response: { data: { code: "CONFLICT", error: diagnostic } },
    });
    render(<RemotePairSection status={status} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(diagnostic);
  });

  it("ignores a consumed status about the previous code", async () => {
    render(<RemotePairSection status={status} />);
    await screen.findByTestId("pairing-qr");
    // Requested before this code was minted: it describes the previous one.
    report("consumed", [ipad, iphone], 1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("names the device that used the code once listed, and forgets it once revoked", async () => {
    render(<RemotePairSection status={status} />);
    await screen.findByTestId("pairing-qr");
    mint.mockResolvedValue(minted("next-code"));
    // The service can report the code used before it lists the new device.
    report("consumed", [ipad], performance.now());
    expect(await screen.findByRole("status")).toHaveTextContent("A device is paired");
    await waitFor(() =>
      expect(screen.getByTestId("pairing-qr")).toHaveTextContent("#code=next-code"),
    );
    report("pending", [ipad, iphone], performance.now());
    expect(screen.getByRole("status")).toHaveTextContent("iPhone is paired");
    expect(screen.getByRole("button", { name: /not you\? revoke/i })).toBeInTheDocument();
    expect(mint).toHaveBeenCalledTimes(2);
    // Revoked from the devices list: the notice goes with it.
    report("pending", [ipad], performance.now());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("never names the previous code's device for the next one", async () => {
    const pixel: RemoteDevice = { id: 3, label: "Pixel", created_at: "2026-11-26 09:00:00" };
    render(<RemotePairSection status={status} />);
    await screen.findByTestId("pairing-qr");
    mint.mockResolvedValue(minted("second"));
    // The iPhone used the first code, unlisted when the second was minted.
    report("consumed", [ipad], performance.now());
    await waitFor(() => expect(screen.getByTestId("pairing-qr")).toHaveTextContent("second"));
    report("pending", [ipad, iphone], performance.now());
    mint.mockResolvedValue(minted("third"));
    // The Pixel uses the second code, unlisted yet: not the iPhone.
    report("consumed", [ipad, iphone], performance.now());
    await waitFor(() => expect(screen.getByTestId("pairing-qr")).toHaveTextContent("third"));
    expect(screen.getByRole("status")).toHaveTextContent("A device is paired");
    report("pending", [ipad, iphone, pixel], performance.now());
    expect(screen.getByRole("status")).toHaveTextContent("Pixel is paired");
  });

  it("catches a code used just before it expired", async () => {
    vi.useFakeTimers();
    mint.mockResolvedValue({ ...minted("short"), expires_in_secs: 1 });
    render(<RemotePairSection status={status} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    // Used after the last poll: the refresh at expiry is the first to say so.
    vi.mocked(store.get().refresh).mockImplementation(() => {
      store.set({
        status: { pairing_state: "consumed", devices: [ipad, iphone] },
        statusAt: performance.now(),
      });
      return Promise.resolve();
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByRole("status")).toHaveTextContent("iPhone is paired");
  });

  it("renews an expired code a few times, then waits for a click", async () => {
    vi.useFakeTimers();
    mint.mockResolvedValue({ ...minted("short"), expires_in_secs: 1 });
    render(<RemotePairSection status={status} />);
    for (let count = 1; count <= 5; count += 1) {
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(mint).toHaveBeenCalledTimes(count);
      await act(() => vi.advanceTimersByTimeAsync(1000));
    }
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(mint).toHaveBeenCalledTimes(5);
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
    expect(screen.getByText(/code expired/i)).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Show a new code" }).click());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(mint).toHaveBeenCalledTimes(6);
    expect(screen.getByTestId("pairing-qr")).toBeInTheDocument();
  });
});
