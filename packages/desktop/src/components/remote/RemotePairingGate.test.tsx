import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import { extractPairingCode, RemotePairingGate } from "./RemotePairingGate";
import * as deviceToken from "@/lib/remote/device-token";
import * as pairing from "@/api/remote-pairing";
import * as fullscreen from "@/hooks/useFullscreen";
import { uiI18n } from "@/lib/i18n/ui";

vi.mock("@/components/CadencrLogo", () => ({ CadencrLogo: () => <span aria-label="Cadencr" /> }));

vi.mock("./QrPairingScanner", () => ({
  QrPairingScanner: ({ onCode }: { onCode: (code: string) => void }) => (
    <button type="button" onClick={() => onCode("scanned-code")}>
      Simulate scanned QR
    </button>
  ),
}));

describe("extractPairingCode", () => {
  it("pulls the code from a full pairing URL", () => {
    expect(extractPairingCode("https://192.168.1.5:9876/?code=ABC-123_def")).toBe("ABC-123_def");
  });

  it.each([
    ["https://host:9876/#code=fragment-code", "fragment-code"],
    ["#code=fragment-code&other=1", "fragment-code"],
    ["https://host:9876/#/projects/7?code=fragment-code&tab=agent", "fragment-code"],
    ["#code=%E0%A4%A", null],
    ["https://host:9876/#code=%", null],
  ])("parses fragment URLs and safely rejects malformed encoding", (input, expected) => {
    expect(extractPairingCode(input)).toBe(expected);
  });

  it("ignores a trailing hash route", () => {
    expect(extractPairingCode("https://host:9876/?code=XYZ#/ws-session/x")).toBe("XYZ");
  });

  it("pulls the code from a bare query fragment", () => {
    expect(extractPairingCode("?code=tok123")).toBe("tok123");
  });

  it("treats a bare token as the code and trims it", () => {
    expect(extractPairingCode("  rawTokenValue  ")).toBe("rawTokenValue");
  });

  it("returns null for blank input", () => {
    expect(extractPairingCode("   ")).toBeNull();
  });
});

describe("RemotePairingGate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders children on the desktop shell / loopback (not a remote browser)", () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(false);
    render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    expect(screen.getByText("app-content")).toBeInTheDocument();
  });

  it("renders children when a remote browser is already paired", () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue("a-token");
    render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    expect(screen.getByText("app-content")).toBeInTheDocument();
  });

  it("shows the pairing screen when a remote browser is unpaired", () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    expect(screen.getByRole("heading", { name: /pair this device/i })).toBeInTheDocument();
    expect(screen.queryByText("app-content")).not.toBeInTheDocument();
  });

  it("keeps a pasted pairing link session-only in a browser tab", async () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    const pair = vi
      .spyOn(pairing, "pairRemoteDevice")
      .mockResolvedValue({ storagePersisted: false });
    const { user } = render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    await user.click(screen.getByRole("button", { name: /paste the pairing link/i }));
    await user.type(screen.getByLabelText("Pairing link"), "https://host/#code=fragment-code");
    await user.click(screen.getByRole("button", { name: "Pair with this link" }));
    expect(pair).toHaveBeenCalledWith("fragment-code", { trust: false, chosen: true });
    expect(screen.getByText(/couldn't save/i)).toBeInTheDocument();
  });

  it("keeps the sign-in when asked to stay signed in, for a scanned code", async () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    const pair = vi
      .spyOn(pairing, "pairRemoteDevice")
      .mockResolvedValue({ storagePersisted: false });
    const { user } = render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    await user.click(screen.getByRole("switch", { name: "Stay signed in on this device" }));
    await user.click(screen.getByRole("button", { name: "Scan the code" }));
    await user.click(await screen.findByRole("button", { name: "Simulate scanned QR" }));
    expect(pair).toHaveBeenCalledWith("scanned-code", { trust: true, chosen: true });
    expect(await screen.findByText(/couldn't save/i)).toBeInTheDocument();
  });

  it("pairs with a new link that only changes the hash, and scrubs the code", async () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    const pair = vi
      .spyOn(pairing, "pairRemoteDevice")
      .mockResolvedValue({ storagePersisted: false });
    render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    window.history.replaceState(null, "", "/#code=hash-code");
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect(pair).toHaveBeenCalledWith("hash-code", { trust: false, chosen: true }),
    );
    expect(window.location.hash).toBe("");
    expect(await screen.findByText(/couldn't save/i)).toBeInTheDocument();
  });

  it("scrubs a code that arrives during a pairing, and does not start a second one", async () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    let finish: (value: { storagePersisted: boolean }) => void = () => undefined;
    const pair = vi.spyOn(pairing, "pairRemoteDevice").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    window.history.replaceState(null, "", "/#code=first-code");
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect(pair).toHaveBeenCalledWith("first-code", { trust: false, chosen: true }),
    );

    window.history.replaceState(null, "", "/#code=second-code");
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(window.location.hash).toBe("");
    expect(pair).toHaveBeenCalledTimes(1);

    await act(async () => finish({ storagePersisted: false }));
    expect(await screen.findByText(/couldn't save/i)).toBeInTheDocument();
  });

  it("ignores a hash change that carries no pairing code", () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    const pair = vi.spyOn(pairing, "pairRemoteDevice");
    render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    window.history.replaceState(null, "", "/#/settings");
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(pair).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/settings");
    window.history.replaceState(null, "", "/");
  });

  it("rejects a pasted text that is not a pairing link without pairing", async () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    const pair = vi.spyOn(pairing, "pairRemoteDevice");
    const { user } = render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    await user.click(screen.getByRole("button", { name: /paste the pairing link/i }));
    await user.type(screen.getByLabelText("Pairing link"), "not a link!");
    await user.click(screen.getByRole("button", { name: "Pair with this link" }));
    expect(screen.getByRole("alert")).toHaveTextContent("isn't a pairing link");
    expect(pair).not.toHaveBeenCalled();
  });

  it("stays signed in by default in a home-screen app", async () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    vi.spyOn(fullscreen, "detectStandalone").mockReturnValue(true);
    const pair = vi
      .spyOn(pairing, "pairRemoteDevice")
      .mockResolvedValue({ storagePersisted: false });
    const { user } = render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    expect(screen.getByRole("switch", { name: "Stay signed in on this device" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Scan the code" }));
    await user.click(await screen.findByRole("button", { name: "Simulate scanned QR" }));
    expect(pair).toHaveBeenCalledWith("scanned-code", { trust: true, chosen: true });
  });

  it("offers both scan and paste affordances when unpaired", () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    expect(screen.getByRole("button", { name: "Scan the code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /paste the pairing link/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Stay signed in on this device" })).not.toBeChecked();
  });

  it("returns the open remote view to pairing when the host revokes this device", () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    deviceToken.writeDeviceToken("paired-test-session", false);
    render(<RemotePairingGate>Active remote conversation</RemotePairingGate>);
    expect(screen.getByText("Active remote conversation")).toBeVisible();
    act(() => deviceToken.clearDeviceToken());
    expect(screen.getByRole("heading", { name: "Pair this device" })).toBeVisible();
    expect(screen.queryByText("Active remote conversation")).not.toBeInTheDocument();
  });

  it("says why the boot-time pairing failed, in the browser's language", async () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-CA"]);
    uiI18n.addResourceBundle("fr", "ui", {
      remote: {
        pairing: {
          gate: {
            title: "Associer cet appareil",
            instructions: "Sur votre ordinateur, ouvrez <name>Accès à distance</name>.",
          },
          error: { usedOrExpired: "Ce code a déjà servi ou a expiré." },
        },
      },
    });
    sessionStorage.setItem("cadencr.remotePairingError", JSON.stringify({ kind: "expired" }));
    try {
      render(<RemotePairingGate>app-content</RemotePairingGate>);
      expect(await screen.findByRole("heading", { name: "Associer cet appareil" })).toBeVisible();
      expect(screen.getByText("Accès à distance")).toHaveClass("font-medium");
      expect(screen.getByRole("alert")).toHaveTextContent("Ce code a déjà servi ou a expiré.");
      expect(pairing.takePairingError()).toBeNull();

      act(() => {
        languages.mockReturnValue(["en-GB"]);
        window.dispatchEvent(new Event("languagechange"));
      });
      expect(await screen.findByRole("heading", { name: "Pair this device" })).toBeVisible();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This code was already used or has expired. Scan the new code shown on your computer.",
      );
    } finally {
      await act(() => uiI18n.changeLanguage("en-US"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
  });
});
