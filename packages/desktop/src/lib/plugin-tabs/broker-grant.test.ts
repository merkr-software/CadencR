import { describe, expect, it, vi } from "vitest";
import { GrantHolder, type GrantDeps } from "./broker-grant";

function deps(overrides: Partial<GrantDeps> = {}): GrantDeps {
  return {
    mint: vi.fn(async () => ({
      token: "tok",
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      scopes: [],
      api_version: 1,
    })),
    revoke: vi.fn(async () => undefined),
    reportRevokeFailure: vi.fn(),
    now: () => Date.now(),
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GrantHolder", () => {
  it("reports a revocation that failed once the tab is gone", async () => {
    const failure = new Error("offline");
    const grantDeps = deps({ revoke: vi.fn(async () => Promise.reject(failure)) });
    const holder = new GrantHolder("graph", 7, grantDeps);
    await holder.get();
    holder.dispose();
    await settle();
    expect(grantDeps.revoke).toHaveBeenCalledWith("tok");
    expect(grantDeps.reportRevokeFailure).toHaveBeenCalledWith(failure);
  });

  it("has nothing to revoke, or report, when the grant never minted", async () => {
    const grantDeps = deps({ mint: vi.fn(async () => Promise.reject(new Error("refused"))) });
    const holder = new GrantHolder("graph", 7, grantDeps);
    await expect(holder.get()).rejects.toThrow("refused");
    holder.dispose();
    await settle();
    expect(grantDeps.revoke).not.toHaveBeenCalled();
    expect(grantDeps.reportRevokeFailure).not.toHaveBeenCalled();
  });
});
