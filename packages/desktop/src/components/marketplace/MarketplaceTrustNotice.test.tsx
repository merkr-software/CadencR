import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@/test-utils";
import { getMarketplaceTrust, setAsideMarketplaceTrust } from "@/api/generated";
import { MarketplaceTrustNotice } from "./MarketplaceTrustNotice";

vi.mock("@/api/generated", () => ({
  getMarketplaceTrust: vi.fn(),
  setAsideMarketplaceTrust: vi.fn(),
}));

const unreadable = {
  status: "invalid" as const,
  error_code: "PINNED_TRUST_CONFIGURATION_INVALID",
  error: "/data/registry-trust/generation.json: expected value at line 1 column 3",
  recovery: "set_aside" as const,
  file: "/data/registry-trust/generation.json",
};

beforeEach(() => vi.resetAllMocks());

describe("marketplace trust notice", () => {
  it("renders nothing while the trust is usable", async () => {
    vi.mocked(getMarketplaceTrust).mockResolvedValue({ status: "configured" });
    const { container } = render(<MarketplaceTrustNotice />);
    await waitFor(() => expect(getMarketplaceTrust).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("names the cause and sets the faulty file aside only when asked", async () => {
    vi.mocked(getMarketplaceTrust)
      .mockResolvedValueOnce(unreadable)
      .mockResolvedValue({ status: "configured" });
    vi.mocked(setAsideMarketplaceTrust).mockResolvedValue({
      status: "configured",
      kept_at: "/data/registry-trust/generation.json.invalid-20261111T120000.000000Z",
    });
    render(<MarketplaceTrustNotice />);
    expect(await screen.findByText(/expected value at line 1 column 3/)).toBeInTheDocument();
    expect(screen.getByText(/PINNED_TRUST_CONFIGURATION_INVALID/)).toBeInTheDocument();
    expect(screen.getByText(/renamed beside itself, never deleted/)).toBeInTheDocument();
    expect(setAsideMarketplaceTrust).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Set the file aside and rebuild" }));
    expect(
      await screen.findByText(/kept at \/data\/registry-trust\/generation\.json\.invalid-/),
    ).toBeInTheDocument();
    expect(setAsideMarketplaceTrust).toHaveBeenCalledTimes(1);
  });

  it("offers no file action when only an update can help", async () => {
    vi.mocked(getMarketplaceTrust).mockResolvedValue({
      ...unreadable,
      error: "generation.json: refusing a rollback; update Cadencr",
      recovery: "update_app",
      file: null,
    });
    render(<MarketplaceTrustNotice />);
    expect(await screen.findByText(/Update Cadencr to verify the marketplace again/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the notice and shows the error when setting aside fails", async () => {
    vi.mocked(getMarketplaceTrust).mockResolvedValue(unreadable);
    vi.mocked(setAsideMarketplaceTrust).mockRejectedValue({
      response: { data: { code: "TRUST_RECOVERY_FAILED", error: "permission denied" } },
    });
    render(<MarketplaceTrustNotice />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Set the file aside and rebuild" }),
    );
    expect(await screen.findByText("TRUST_RECOVERY_FAILED: permission denied")).toBeTruthy();
    expect(screen.getByText(/expected value at line 1 column 3/)).toBeInTheDocument();
  });
});
