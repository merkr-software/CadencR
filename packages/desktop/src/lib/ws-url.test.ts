import { describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  resolveApiBaseUrlSync: () => "http://127.0.0.1:5005",
  getAuthTokenSync: () => "test-token",
}));

const { getNeovimWsUrl, getTerminalWsUrl, getWsProtocols } = await import("./ws-url");

describe("getNeovimWsUrl", () => {
  it("builds the neovim websocket URL from the API base URL", () => {
    expect(getNeovimWsUrl()).toBe("ws://127.0.0.1:5005/api/neovim/ws");
  });

  it("stays independent from the terminal URL", () => {
    expect(getNeovimWsUrl()).not.toBe(getTerminalWsUrl());
  });
});

describe("getWsProtocols", () => {
  it("carries the auth token as a subprotocol", () => {
    expect(getWsProtocols()).toEqual(["cadencr-token.test-token"]);
  });
});
