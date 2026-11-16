import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import type { RemoteStatus } from "@/api/generated";
import { RemotePairSection } from "./RemotePairSection";

const mocks = vi.hoisted(() => ({ mint: vi.fn(), refresh: vi.fn() }));
vi.mock("@/api/generated", () => ({ remotePairingCode: mocks.mint }));
vi.mock("@/stores/remote-store", () => ({
  useRemoteStore: <T,>(
    selector: (state: { refresh: typeof mocks.refresh; status: { pairing_state: "pending" } }) => T,
  ): T => selector({ refresh: mocks.refresh, status: { pairing_state: "pending" } }),
}));
vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="pairing-qr">{value}</div>,
}));
const fingerprint = Array.from({ length: 32 }, () => "AB").join(":");
const status: RemoteStatus = {
  enabled: true,
  port: 5006,
  fingerprint,
  tunnel_host: null,
  lan_urls: ["https://192.168.1.5:5006/", "https://192.168.1.6:5006/"],
  pairing_state: "none",
  connected_devices: 0,
  devices: [],
  audit_tail: [],
};

beforeEach(() => {
  mocks.mint.mockReset();
  mocks.refresh.mockReset();
  mocks.mint.mockResolvedValue({
    code: "secret-code",
    expires_in_secs: 60,
    fingerprint,
    urls: status.lan_urls.map((url) => `${url}#code=secret-code`),
  });
});

async function compare(
  user: ReturnType<typeof render>["user"],
  value = fingerprint,
): Promise<void> {
  await user.type(screen.getByLabelText(/fingerprint from the other device/i), value);
  await user.click(screen.getByRole("button", { name: "Compare and show pairing code" }));
}

describe("LAN pairing certificate comparison", () => {
  it("shows only a plain address until the full browser fingerprint matches", async () => {
    const { user } = render(<RemotePairSection status={status} />);
    expect(screen.getByText("https://192.168.1.5:5006/")).toBeInTheDocument();
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
    expect(mocks.mint).not.toHaveBeenCalled();
    await compare(user, "wrong");
    expect(screen.getByRole("alert")).toHaveTextContent("does not match");
    expect(mocks.mint).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText(/fingerprint from the other device/i));
    await compare(user, fingerprint.replaceAll(":", "").toLowerCase());
    await waitFor(() =>
      expect(screen.getByTestId("pairing-qr")).toHaveTextContent("/#code=secret-code"),
    );
    expect(mocks.mint).toHaveBeenCalledTimes(1);
  });

  it("revokes the gate on target changes, fingerprint changes and dialog remount", async () => {
    const { user, rerender, unmount } = render(<RemotePairSection status={status} />);
    await compare(user);
    await screen.findByTestId("pairing-qr");
    await user.click(screen.getByRole("button", { name: "192.168.1.6:5006 · LAN" }));
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/fingerprint from the other device/i)).toHaveValue("");
    await compare(user);
    await screen.findByTestId("pairing-qr");
    rerender(
      <RemotePairSection status={{ ...status, fingerprint: fingerprint.replaceAll("AB", "CD") }} />,
    );
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/fingerprint from the other device/i)).toHaveValue("");
    unmount();
    render(<RemotePairSection status={status} />);
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
  });

  it("blocks when the fingerprint is unavailable and catches a changed mint certificate", async () => {
    const { user, rerender } = render(
      <RemotePairSection status={{ ...status, fingerprint: null }} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
    rerender(<RemotePairSection status={status} />);
    mocks.mint.mockResolvedValue({
      code: "secret",
      expires_in_secs: 60,
      fingerprint: "changed",
      urls: status.lan_urls,
    });
    await compare(user);
    await screen.findByText(/host certificate changed/i);
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
  });

  it("does not bypass LAN verification when a LAN address is configured as the tunnel", () => {
    render(<RemotePairSection status={{ ...status, tunnel_host: "192.168.1.5:5006" }} />);
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/fingerprint from the other device/i)).toBeInTheDocument();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("defaults to the configured private tunnel and still gates every LAN target", async () => {
    mocks.mint.mockResolvedValue({
      code: "secret-code",
      expires_in_secs: 60,
      fingerprint,
      urls: ["https://machine.tailnet.ts.net/#code=secret-code", ...status.lan_urls],
    });
    const { user } = render(
      <RemotePairSection status={{ ...status, tunnel_host: "machine.tailnet.ts.net" }} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("pairing-qr")).toHaveTextContent(
        "https://machine.tailnet.ts.net/#code=secret-code",
      ),
    );
    expect(screen.queryByLabelText(/fingerprint from the other device/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "192.168.1.5:5006 · LAN" }));
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/fingerprint from the other device/i)).toBeInTheDocument();
  });
});
