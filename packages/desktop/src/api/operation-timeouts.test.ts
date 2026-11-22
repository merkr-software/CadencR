import { describe, expect, it } from "vitest";
import { customInstance } from "./client";
import {
  agentExtensionOperationTimeout,
  archiveOperationTimeout,
  isNoTimeoutPath,
  neovimOperationTimeout,
  projectUpdateOperationTimeout,
} from "./operation-timeouts";

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

describe("archive request timeout", () => {
  it("waits for the whole cleanup the service runs before answering", async () => {
    const timeout = await customInstance<number>({
      method: "POST",
      url: "/api/features/7/archive",
      adapter: async (config) => ({
        data: config.timeout,
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      }),
    });
    expect(timeout).toBe(600000);
  });

  it.each([
    { method: "GET", url: "/api/features/7/archive" },
    { method: "POST", url: "/api/features/7/archive-cleanup/retry" },
    { method: "POST", url: "/api/features/7/archive-preview" },
  ])("keeps $method $url on its normal timeout", (config) => {
    expect(archiveOperationTimeout(config)).toBeUndefined();
  });
});

describe("project update request timeout", () => {
  it("waits for a folder move, which may copy the folder to another volume", async () => {
    const timeout = await customInstance<number>({
      method: "PATCH",
      url: "/api/projects/7",
      adapter: async (config) => ({
        data: config.timeout,
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      }),
    });
    expect(timeout).toBe(600000);
  });

  it.each([
    { method: "DELETE", url: "/api/projects/7" },
    { method: "PATCH", url: "/api/projects/7/settings" },
  ])("keeps $method $url on its normal timeout", (config) => {
    expect(projectUpdateOperationTimeout(config)).toBeUndefined();
  });
});

describe("long-running git and LSP no-timeout paths", () => {
  it.each([
    "/api/git/commit",
    "/api/git/push",
    "/api/git/update-branch",
    "/api/git/update-branch/continue",
    "/api/git/update-branch/abort",
    "/api/git/merge",
    "/api/git/fetch",
    "/api/git/fetch?feature_id=1",
    "/api/lsp/sessions",
  ])("disables the 30s Axios timeout for %s", async (url) => {
    expect(isNoTimeoutPath(url)).toBe(true);
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
    expect(timeout).toBe(0);
  });

  it.each([
    "/api/git/merge-conflicts",
    "/api/git/commit-log",
    "/api/git/commit-graph",
    "/api/git/push-input",
    "/api/git/status",
  ])("does not match sibling prefix path %s", async (url) => {
    expect(isNoTimeoutPath(url)).toBe(false);
    const timeout = await customInstance<number>({
      method: "GET",
      url,
      adapter: async (config) => ({
        data: config.timeout,
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      }),
    });
    expect(timeout).toBe(30000);
  });
});
