import { describe, expect, it } from "vitest";
import { customInstance } from "./client";
import { agentExtensionOperationTimeout, neovimOperationTimeout } from "./operation-timeouts";

describe("Neovim initialization request timeout", () => {
  it.each(["/api/neovim/start", "/api/features/7/neovim/open"])(
    "keeps %s alive for the backend initialization budget",
    async (url) => {
      const timeout = await customInstance<number>({
        method: "POST",
        url,
        adapter: async (config) => ({
          data: config.timeout,
          status: 200,
          statusText: "OK",
          headers: {},
          config,
        }),
      });
      expect(timeout).toBe(120000);
    },
  );

  it.each([
    { method: "GET", url: "/api/neovim/start" },
    { method: "POST", url: "/api/neovim/stop" },
    { method: "POST", url: "/api/features/7/neovim/open/extra" },
    { method: "POST", url: "/api/features/not-a-number/neovim/open" },
  ])("keeps unrelated requests on their normal timeout", (config) => {
    expect(neovimOperationTimeout(config)).toBeUndefined();
  });

  it("preserves an explicit timeout", () => {
    expect(
      neovimOperationTimeout({ method: "POST", url: "/api/neovim/start", timeout: 5000 }),
    ).toBe(5000);
  });
});

describe("agent extension request timeout", () => {
  it("keeps CLI-driven installs alive past the default budget", () => {
    expect(
      agentExtensionOperationTimeout({ method: "POST", url: "/api/agent-extensions/mcp/install" }),
    ).toBe(900000);
    expect(
      agentExtensionOperationTimeout({ method: "GET", url: "/api/agent-extensions/skills" }),
    ).toBe(600000);
    expect(
      agentExtensionOperationTimeout({ method: "POST", url: "/api/git/status" }),
    ).toBeUndefined();
  });
});
