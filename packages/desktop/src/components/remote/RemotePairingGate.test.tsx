import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@/test-utils";
import { extractPairingCode, RemotePairingGate } from "./RemotePairingGate";
import * as deviceToken from "@/lib/remote/device-token";
import * as pairing from "@/api/remote-pairing";

vi.mock("@/components/CadencrLogo", () => ({ CadencrLogo: () => <span aria-label="Cadencr" /> }));

vi.mock("./QrPairingScanner", () => ({
  QrPairingScanner: ({ onDetect }: { onDetect: (value: string) => void }) => (
    <button type="button" onClick={() => onDetect("https://host/#code=scanned-code")}>
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

  it("keeps a manually pasted pairing link session-only", async () => {
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
    await user.type(
      screen.getByLabelText("Pairing link or code"),
      "https://host/#code=fragment-code",
    );
    await user.click(screen.getByRole("button", { name: /pair device/i }));
    expect(pair).toHaveBeenCalledWith("fragment-code");
    expect(screen.getByText(/couldn't save/i)).toBeInTheDocument();
  });

  it("keeps scanned QR pairing session-only too", async () => {
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
    await user.click(screen.getByRole("button", { name: /scan qr code/i }));
    await user.click(await screen.findByRole("button", { name: "Simulate scanned QR" }));
    expect(pair).toHaveBeenCalledWith("scanned-code");
    expect(await screen.findByText(/couldn't save/i)).toBeInTheDocument();
  });

  it("offers both scan and paste affordances when unpaired", () => {
    vi.spyOn(deviceToken, "isBrowserRemote").mockReturnValue(true);
    vi.spyOn(deviceToken, "readDeviceToken").mockReturnValue(null);
    render(
      <RemotePairingGate>
        <div>app-content</div>
      </RemotePairingGate>,
    );
    expect(screen.getByRole("button", { name: /scan qr code/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pair device/i })).toBeInTheDocument();
  });
});
