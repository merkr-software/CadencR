import type { HostToGuest, TabContext, ThemeSnapshot } from "@cadencr/tab-sdk/protocol";
import { AxiosError, type AxiosResponse } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PluginTabBroker } from "./broker";
import type { BackendFailureDeps } from "./broker-backend-failures";
import type { GrantDeps } from "./broker-grant";
import type { FetchLike } from "./broker-http";
import type { SocketFactory } from "./broker-streams";
import { FakePluginSocket } from "./plugin-socket-fixtures";
import { usePluginTabRuntimeStore } from "./runtime-store";

const CONTEXT: TabContext = {
  project: { id: 1, name: "Cadencr", path: "/repo" },
  feature: { id: 7, name: "Graph", branch: "feat/graph", baseBranch: "main", worktreePath: null },
  pullRequest: null,
  session: null,
};

const THEME: ThemeSnapshot = {
  id: "cadencr-dark",
  appearance: "dark",
  tokens: { background: "#131416" },
};

interface Guest {
  request: (method: string, params?: unknown) => Promise<HostToGuest>;
  events: HostToGuest[];
  close: () => void;
}

const openPorts: MessagePort[] = [];
const brokers: PluginTabBroker[] = [];
let instanceCounter = 0;

function connect(broker: PluginTabBroker): Guest {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  broker.attachPort(port1);
  const pending = new Map<string, (message: HostToGuest) => void>();
  const events: HostToGuest[] = [];
  let next = 0;
  port2.onmessage = (event: MessageEvent<HostToGuest>) => {
    const message = event.data;
    if (message.kind === "event") events.push(message);
    else pending.get(message.id)?.(message);
  };
  return {
    events,
    close: () => port2.close(),
    request: (method, params) =>
      new Promise((resolve) => {
        const id = `r${++next}`;
        pending.set(id, resolve);
        port2.postMessage({ v: 1, kind: "request", id, method, params });
      }),
  };
}

function grantDeps(overrides: Partial<GrantDeps> = {}): GrantDeps {
  return {
    mint: vi.fn(async () => ({
      token: `tok-${Math.random().toString(36).slice(2)}`,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      scopes: ["git:read"],
      api_version: 1,
    })),
    revoke: vi.fn(async () => undefined),
    reportRevokeFailure: vi.fn(),
    now: () => Date.now(),
    ...overrides,
  };
}

function createBroker(
  options: {
    instanceId?: string;
    fetch?: FetchLike;
    grant?: GrantDeps;
    backendFailures?: BackendFailureDeps;
    origins?: string[];
    hasCommands?: boolean;
    hasBackend?: boolean;
    socket?: SocketFactory;
    visible?: boolean;
    shortcuts?: string[];
  } = {},
): PluginTabBroker {
  const broker = new PluginTabBroker(
    {
      instanceId: options.instanceId ?? `7:plugin:graph-${++instanceCounter}`,
      featureId: 7,
      plugin: {
        id: "graph",
        name: "Graph",
        version: "0.1.0",
        allowedOrigins: options.origins ?? [],
        hasCommands: options.hasCommands ?? false,
        hasBackend: options.hasBackend ?? false,
        shortcuts: options.shortcuts ?? [],
      },
      context: CONTEXT,
      visible: options.visible ?? true,
    },
    {
      grant: options.grant ?? grantDeps(),
      backendFailures: options.backendFailures ?? { report: vi.fn(), clear: vi.fn() },
      fetch: options.fetch ?? vi.fn(),
      theme: () => THEME,
      windowPorts: false,
      socket:
        options.socket ??
        (() => {
          throw new Error("no socket in this test");
        }),
    },
  );
  brokers.push(broker);
  return broker;
}

function ok(message: HostToGuest): unknown {
  if (message.kind !== "response" || !("result" in message)) {
    throw new Error(`expected a result, got ${JSON.stringify(message)}`);
  }
  return message.result;
}

function errorCode(message: HostToGuest): string {
  if (message.kind !== "response" || !("error" in message)) {
    throw new Error(`expected an error, got ${JSON.stringify(message)}`);
  }
  return message.error.code;
}

beforeEach(() => {
  usePluginTabRuntimeStore.setState({ badges: {}, externalOpens: [] });
});

afterEach(() => {
  for (const broker of brokers.splice(0)) broker.dispose();
  for (const port of openPorts.splice(0)) port.close();
});

describe("PluginTabBroker handshake", () => {
  it("answers hello with the negotiated version, context, theme and scopes", async () => {
    const guest = connect(createBroker({ instanceId: "7:plugin:graph" }));
    const result = ok(await guest.request("hello", { sdkVersion: "0.1.0", apiVersions: [1, 3] }));
    expect(result).toMatchObject({
      apiVersion: 1,
      instanceId: "7:plugin:graph",
      plugin: { id: "graph", version: "0.1.0" },
      context: CONTEXT,
      theme: THEME,
    });
    const capabilities = (result as { capabilities: string[] }).capabilities;
    expect(capabilities).toContain("api.request");
    expect(capabilities).toContain("git:read");
    // No allowed origins in the manifest: no egress.
    expect(capabilities).not.toContain("net.fetch");
    // Neither commands nor a backend: a page-only tab.
    expect(capabilities).not.toContain("exec.run");
    expect(capabilities).not.toContain("backend.request");
  });

  it("offers exec.run and backend.request only when the manifest declares them", async () => {
    const guest = connect(createBroker({ hasCommands: true, hasBackend: true }));
    const result = ok(await guest.request("hello", { sdkVersion: "0.1.0", apiVersions: [1, 1] }));
    const capabilities = (result as { capabilities: string[] }).capabilities;
    expect(capabilities).toContain("exec.run");
    expect(capabilities).toContain("backend.request");
  });

  it("names the active shortcuts in hello", async () => {
    const guest = connect(createBroker({ shortcuts: ["refresh"] }));
    const result = ok(await guest.request("hello", { sdkVersion: "0.1.0", apiVersions: [1, 1] }));
    expect(result).toMatchObject({ shortcuts: ["refresh"] });
  });

  it("tells a page recreated while hidden that it is hidden", async () => {
    const guest = connect(createBroker({ visible: false }));
    const result = ok(await guest.request("hello", { sdkVersion: "0.1.0", apiVersions: [1, 1] }));
    expect(result).toMatchObject({ visible: false });
  });

  it("refuses a guest whose API range doesn't include v1", async () => {
    const guest = connect(createBroker());
    const reply = await guest.request("hello", { sdkVersion: "9.0.0", apiVersions: [2, 4] });
    expect(errorCode(reply)).toBe("PLUGIN_API_UNSUPPORTED");
  });

  it("accepts a repeated hello on the same port", async () => {
    const guest = connect(createBroker());
    const params = { sdkVersion: "0.1.0", apiVersions: [1, 1] };
    ok(await guest.request("hello", params));
    expect(ok(await guest.request("hello", params))).toMatchObject({ apiVersion: 1 });
  });

  it("rejects unknown methods with BAD_REQUEST", async () => {
    const guest = connect(createBroker());
    for (const method of ["shell.exec", "constructor", "toString", "hasOwnProperty"]) {
      expect(errorCode(await guest.request(method, {}))).toBe("BAD_REQUEST");
    }
  });
});

describe("PluginTabBroker api.request", () => {
  it("relays with the grant token and transfers the raw body", async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response('{"id":7}', { status: 200 }));
    const grant = grantDeps({
      mint: vi.fn(async () => ({
        token: "grant-1",
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        scopes: [],
        api_version: 1,
      })),
    });
    const guest = connect(createBroker({ fetch, grant }));
    const result = ok(
      await guest.request("api.request", {
        method: "GET",
        path: "/api/features/7",
        query: { include: "settings" },
      }),
    ) as { status: number; body: ArrayBuffer };
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toMatch(/\/api\/features\/7\?include=settings$/);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-cadencr-plugin-token"]).toBe("grant-1");
    expect(result.status).toBe(200);
    expect(result.body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(result.body)).toBe('{"id":7}');
  });

  it("resolves non-2xx statuses for the SDK to map", async () => {
    const fetch = vi.fn<FetchLike>(
      async () => new Response('{"error":"nope","code":"PLUGIN_SCOPE_DENIED"}', { status: 403 }),
    );
    const guest = connect(createBroker({ fetch }));
    const result = ok(
      await guest.request("api.request", { method: "GET", path: "/api/git/status" }),
    );
    expect(result).toMatchObject({ status: 403 });
  });

  it("re-mints the grant once after a 401", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const grant = grantDeps();
    const guest = connect(createBroker({ fetch, grant }));
    ok(await guest.request("api.request", { method: "GET", path: "/api/projects" }));
    expect(grant.mint).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("re-mints once when concurrent requests are all refused with the same grant", async () => {
    let stale = true;
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      const token = (init.headers as Record<string, string>)["x-cadencr-plugin-token"];
      return new Response("{}", { status: stale && token === "tok-1" ? 401 : 200 });
    });
    let minted = 0;
    const grant = grantDeps({
      mint: vi.fn(async () => ({
        token: `tok-${++minted}`,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        scopes: [],
        api_version: 1,
      })),
    });
    const guest = connect(createBroker({ fetch, grant }));
    ok(await guest.request("state.get", {}));
    const replies = await Promise.all(
      [1, 2, 3].map(() => guest.request("api.request", { method: "GET", path: "/api/projects" })),
    );
    stale = false;
    for (const reply of replies) ok(reply);
    expect(grant.mint).toHaveBeenCalledTimes(2);
  });

  it("re-mints a grant that is about to expire instead of presenting it", async () => {
    let now = Date.now();
    const fetch = vi.fn<FetchLike>(async () => new Response("{}", { status: 200 }));
    const grant = grantDeps({ now: () => now });
    const guest = connect(createBroker({ fetch, grant }));
    ok(await guest.request("api.request", { method: "GET", path: "/api/projects" }));
    ok(await guest.request("api.request", { method: "GET", path: "/api/projects" }));
    expect(grant.mint).toHaveBeenCalledTimes(1);
    // The machine slept past the grant's refresh margin (15 min TTL).
    now += 14 * 60_000;
    ok(await guest.request("api.request", { method: "GET", path: "/api/projects" }));
    expect(grant.mint).toHaveBeenCalledTimes(2);
  });

  it("rejects paths outside the service API", async () => {
    const guest = connect(createBroker());
    for (const path of [
      "https://evil.test/api",
      "/api/../etc",
      "/api/x?y=1",
      "/health",
      "/api/%2e%2e/remote/pair",
      "/api/.%2E/remote/pair",
      "/api/..\\remote",
      "/api/./x",
    ]) {
      expect(errorCode(await guest.request("api.request", { method: "GET", path }))).toBe(
        "BAD_REQUEST",
      );
    }
  });

  it("maps a refused grant to the service's code", async () => {
    const response = {
      status: 403,
      data: { error: "Graph is off for this project", code: "PLUGIN_TAB_DISABLED" },
    } as AxiosResponse;
    const grant = grantDeps({
      mint: vi.fn(async () => {
        throw new AxiosError("Forbidden", "ERR_BAD_REQUEST", undefined, undefined, response);
      }),
    });
    const guest = connect(createBroker({ grant }));
    expect(errorCode(await guest.request("api.request", { method: "GET", path: "/api/x" }))).toBe(
      "PLUGIN_TAB_DISABLED",
    );
  });
});

describe("PluginTabBroker storage, state and ui", () => {
  it("reads a missing storage key as null", async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response('{"error":"missing","code":"PLUGIN_TAB_STORAGE_NOT_FOUND"}', { status: 404 }),
    );
    const guest = connect(createBroker({ fetch }));
    expect(ok(await guest.request("storage.get", { key: "layout" }))).toBeNull();
  });

  it("keeps state across port replacement and broker recreation", async () => {
    const instanceId = "7:plugin:stateful";
    const first = createBroker({ instanceId });
    const guest = connect(first);
    ok(await guest.request("state.set", { value: { zoom: 2 } }));
    // Guest reload: a new port on the same broker.
    const reloaded = connect(first);
    expect(ok(await reloaded.request("state.get", {}))).toEqual({ zoom: 2 });
    // Guest recycled / tab remounted: a new broker for the same instance.
    first.dispose();
    const second = connect(createBroker({ instanceId }));
    expect(ok(await second.request("state.get", {}))).toEqual({ zoom: 2 });
  });

  it("caps state at 1 MiB", async () => {
    const guest = connect(createBroker());
    const value = "x".repeat(1024 * 1024 + 1);
    expect(errorCode(await guest.request("state.set", { value }))).toBe("BAD_REQUEST");
  });

  it("stores the badge per instance and clears it on dispose", async () => {
    const broker = createBroker({ instanceId: "7:plugin:badged" });
    const guest = connect(broker);
    ok(await guest.request("ui.setBadge", { text: "12" }));
    expect(usePluginTabRuntimeStore.getState().badges["7:plugin:badged"]).toBe("12");
    expect(errorCode(await guest.request("ui.setBadge", { text: "12345" }))).toBe("BAD_REQUEST");
    broker.dispose();
    expect(usePluginTabRuntimeStore.getState().badges["7:plugin:badged"]).toBeUndefined();
  });

  it("refuses net.fetch when the manifest allows no origin", async () => {
    const guest = connect(createBroker());
    const reply = await guest.request("net.fetch", { url: "https://api.example.com/x" });
    expect(errorCode(reply)).toBe("PLUGIN_NETWORK_DENIED");
  });

  it("relays net.fetch as raw bytes both ways", async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response("pong", {
          status: 200,
          headers: { "x-cadencr-net-status": "201", "x-cadencr-net-headers": '{"a":"b"}' },
        }),
    );
    const guest = connect(createBroker({ fetch, origins: ["https://api.example.com"] }));
    const body = new TextEncoder().encode("ping").buffer;
    const result = ok(
      await guest.request("net.fetch", {
        url: "https://api.example.com/x?q=1",
        method: "POST",
        headers: { accept: "text/plain" },
        body,
      }),
    ) as { status: number; headers: Record<string, string>; body: ArrayBuffer };
    const [url, init] = fetch.mock.calls[0] ?? [];
    const target = new URL(String(url));
    expect(target.pathname).toBe("/api/plugin-tabs/self/net/fetch");
    expect(target.searchParams.get("url")).toBe("https://api.example.com/x?q=1");
    expect(target.searchParams.get("method")).toBe("POST");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(JSON.parse(headers["x-cadencr-net-headers"] ?? "")).toEqual({ accept: "text/plain" });
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe("ping");
    expect(result.status).toBe(201);
    expect(result.headers).toEqual({ a: "b" });
    expect(new TextDecoder().decode(result.body)).toBe("pong");
  });

  it("escapes non-ASCII net.fetch headers so fetch accepts them", async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response("", {
          status: 200,
          headers: { "x-cadencr-net-status": "200", "x-cadencr-net-headers": "{}" },
        }),
    );
    const guest = connect(createBroker({ fetch, origins: ["https://api.example.com"] }));
    ok(
      await guest.request("net.fetch", {
        url: "https://api.example.com/x",
        headers: { "x-name": "日本語 😀" },
      }),
    );
    const [, init] = fetch.mock.calls[0] ?? [];
    const sent = ((init?.headers ?? {}) as Record<string, string>)["x-cadencr-net-headers"] ?? "";
    expect(sent).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(sent)).toEqual({ "x-name": "日本語 😀" });
    expect(() => new Headers({ "x-cadencr-net-headers": sent })).not.toThrow();
  });

  it("maps a net.fetch relay failure to the service's code", async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        new Response('{"error":"origin not allowed","code":"PLUGIN_NETWORK_DENIED"}', {
          status: 403,
        }),
    );
    const guest = connect(createBroker({ fetch, origins: ["https://api.example.com"] }));
    const reply = await guest.request("net.fetch", { url: "https://evil.test/" });
    expect(errorCode(reply)).toBe("PLUGIN_NETWORK_DENIED");
  });

  it("refuses an oversize net.fetch body before relaying it", async () => {
    const fetch = vi.fn<FetchLike>();
    const guest = connect(createBroker({ fetch, origins: ["https://api.example.com"] }));
    const body = new ArrayBuffer(2 * 1024 * 1024 + 1);
    const reply = await guest.request("net.fetch", { url: "https://api.example.com/", body });
    expect(errorCode(reply)).toBe("BAD_REQUEST");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("PluginTabBroker events", () => {
  it("pushes context.changed only when the context changes", async () => {
    const broker = createBroker();
    const guest = connect(broker);
    broker.setContext({ ...CONTEXT });
    broker.setContext({ ...CONTEXT, feature: { ...CONTEXT.feature, branch: "feat/other" } });
    broker.setContext({ ...CONTEXT, feature: { ...CONTEXT.feature, branch: "feat/other" } });
    await vi.waitFor(() => expect(guest.events).toHaveLength(1));
    // Flush: a stray duplicate would have arrived with the first one.
    ok(await guest.request("state.get", {}));
    expect(guest.events).toHaveLength(1);
    expect(guest.events[0]).toMatchObject({ event: "context.changed" });
  });

  it("pushes visibility changes", async () => {
    const broker = createBroker();
    const guest = connect(broker);
    broker.setVisible(false);
    await vi.waitFor(() =>
      expect(guest.events[0]).toMatchObject({
        event: "visibility.changed",
        payload: { visible: false },
      }),
    );
  });

  it("delivers presses of its active shortcuts only", async () => {
    const broker = createBroker({ shortcuts: ["refresh"] });
    const guest = connect(broker);
    broker.pressShortcut("taken-by-cadencr");
    broker.pressShortcut("refresh");
    await vi.waitFor(() =>
      expect(guest.events).toEqual([
        expect.objectContaining({ event: "shortcut", payload: { id: "refresh" } }),
      ]),
    );
  });
});

describe("PluginTabBroker guest lifecycle", () => {
  it("releases socket, subscriptions and grant when the guest dies, then resumes", async () => {
    const sockets: FakePluginSocket[] = [];
    const grant = grantDeps();
    const broker = createBroker({
      grant,
      socket: (url, protocol) => {
        const socket = new FakePluginSocket(url, protocol);
        sockets.push(socket);
        return socket;
      },
    });
    const guest = connect(broker);
    const subscribing = guest.request("streams.subscribe", { topic: "git.status" });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await vi.waitFor(() => expect(sockets[0]!.subscribes()).toHaveLength(1));
    sockets[0]!.acceptSubscribe("git.status", "srv-1");
    ok(await subscribing);
    const firstToken = sockets[0]!.protocol.replace("cadencr-plugin.", "");

    broker.suspend();
    expect(sockets[0]!.readyState).toBe(3);
    await vi.waitFor(() => expect(grant.revoke).toHaveBeenCalledWith(firstToken));

    // The recreated page brings a new port: a fresh hello mints a new grant.
    const next = connect(broker);
    const hello = ok(await next.request("hello", { sdkVersion: "0.1.0", apiVersions: [1, 1] }));
    expect(hello).toMatchObject({ apiVersion: 1 });
    expect(grant.mint).toHaveBeenCalledTimes(2);
    const resubscribing = next.request("streams.subscribe", { topic: "git.status" });
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]!.protocol).not.toBe(sockets[0]!.protocol);
    sockets[1]!.open();
    await vi.waitFor(() => expect(sockets[1]!.subscribes()).toHaveLength(1));
    sockets[1]!.acceptSubscribe("git.status", "srv-2");
    ok(await resubscribing);
  });

  it("keeps one link confirmation pending per tab", async () => {
    const guest = connect(createBroker({ instanceId: "7:plugin:links" }));
    const first = guest.request("ui.openExternal", { url: "https://example.com/a" });
    await vi.waitFor(() =>
      expect(usePluginTabRuntimeStore.getState().externalOpens).toHaveLength(1),
    );
    const second = await guest.request("ui.openExternal", { url: "https://example.com/b" });
    expect(errorCode(second)).toBe("CAPABILITY_DENIED");
    expect(usePluginTabRuntimeStore.getState().externalOpens).toHaveLength(1);
    for (const url of ["https://[::1]/", "https://127.0.0.2/", "https://app.localhost/"]) {
      expect(errorCode(await guest.request("ui.openExternal", { url }))).toBe("BAD_REQUEST");
    }
    const [pending] = usePluginTabRuntimeStore.getState().externalOpens;
    pending?.resolve(false);
    expect(errorCode(await first)).toBe("CAPABILITY_DENIED");
  });
});

describe("PluginTabBroker exec.run and backend.request", () => {
  it("lets the service refuse an undeclared program, so the attempt is recorded", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      Response.json({ error: "not listed", code: "PLUGIN_EXEC_DENIED" }, { status: 403 }),
    );
    const guest = connect(createBroker({ fetch, hasCommands: true }));
    expect(errorCode(await guest.request("exec.run", { program: "bash" }))).toBe(
      "PLUGIN_EXEC_DENIED",
    );
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe("/api/plugin-tabs/self/exec");
  });

  it("refuses malformed params without calling the service", async () => {
    const fetch = vi.fn<FetchLike>();
    const guest = connect(createBroker({ fetch, hasCommands: true, hasBackend: true }));
    expect(errorCode(await guest.request("exec.run", { program: 42 }))).toBe("BAD_REQUEST");
    expect(errorCode(await guest.request("exec.run", { program: "git", args: "log" }))).toBe(
      "BAD_REQUEST",
    );
    expect(errorCode(await guest.request("backend.request", { method: "m", params: 1n }))).toBe(
      "BAD_REQUEST",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves bounds to the service, which records the refusal", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      Response.json({ error: "Bad request: timeout_ms", code: "BAD_REQUEST" }, { status: 400 }),
    );
    const guest = connect(createBroker({ fetch, hasCommands: true }));
    expect(errorCode(await guest.request("exec.run", { program: "git", timeoutMs: 0 }))).toBe(
      "BAD_REQUEST",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      program: "git",
      args: [],
      timeout_ms: 0,
    });
  });

  it("relays exec.run and maps the result to the SDK's shape", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      Response.json({ exit_code: 0, success: true, stdout: "main\n", stderr: "", duration_ms: 4 }),
    );
    const guest = connect(createBroker({ fetch, hasCommands: true }));
    const result = ok(
      await guest.request("exec.run", { program: "git", args: ["branch", "--show-current"] }),
    );
    expect(result).toEqual({
      exitCode: 0,
      success: true,
      stdout: "main\n",
      stderr: "",
      durationMs: 4,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(new URL(String(url)).pathname).toBe("/api/plugin-tabs/self/exec");
    expect(JSON.parse(String(init?.body))).toEqual({
      program: "git",
      args: ["branch", "--show-current"],
    });
  });

  it("passes the service's refusal through with its code", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      Response.json({ error: "not found", code: "PLUGIN_EXEC_NOT_FOUND" }, { status: 422 }),
    );
    const guest = connect(createBroker({ fetch, hasCommands: true }));
    expect(errorCode(await guest.request("exec.run", { program: "kubectl" }))).toBe(
      "PLUGIN_EXEC_NOT_FOUND",
    );
  });

  it("relays backend.request and returns the backend's answer as is", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      Response.json({ error: { code: "NOPE", message: "m" } }),
    );
    const guest = connect(createBroker({ fetch, hasBackend: true }));
    const result = ok(
      await guest.request("backend.request", { method: "ports", params: { all: true } }),
    );
    expect(result).toEqual({ error: { code: "NOPE", message: "m" } });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(new URL(String(url)).pathname).toBe("/api/plugin-tabs/self/backend");
    expect(JSON.parse(String(init?.body))).toEqual({ method: "ports", params: { all: true } });
  });
});

describe("PluginTabBroker backend failures", () => {
  function failures() {
    return {
      report: vi.fn<BackendFailureDeps["report"]>(),
      clear: vi.fn<BackendFailureDeps["clear"]>(),
    };
  }

  it("tells the user once when the backend can't run, and still rejects the page", async () => {
    let answer = (): Response =>
      Response.json(
        {
          error: "the tab's backend `bin/x` is not a native executable",
          code: "PLUGIN_BACKEND_NOT_NATIVE",
        },
        { status: 422 },
      );
    const fetch = vi.fn<FetchLike>(async () => answer());
    const sink = failures();
    const broker = createBroker({ fetch, hasBackend: true, backendFailures: sink });
    const guest = connect(broker);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(errorCode(await guest.request("backend.request", { method: "ports" }))).toBe(
        "PLUGIN_BACKEND_NOT_NATIVE",
      );
    }
    expect(sink.report).toHaveBeenCalledTimes(1);
    expect(sink.report).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: broker.instanceId,
        title: "Graph: its backend is not a native executable",
      }),
    );
    answer = () => Response.json({ result: [] });
    ok(await guest.request("backend.request", { method: "ports" }));
    expect(sink.clear).toHaveBeenCalledWith(broker.instanceId);
  });

  it("leaves the backend's own and transient errors, and other methods, to the page", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      Response.json({ error: "slow", code: "PLUGIN_BACKEND_TIMEOUT" }, { status: 504 }),
    );
    const sink = failures();
    const guest = connect(
      createBroker({ fetch, hasBackend: true, hasCommands: true, backendFailures: sink }),
    );
    expect(errorCode(await guest.request("backend.request", { method: "ports" }))).toBe(
      "PLUGIN_BACKEND_TIMEOUT",
    );
    fetch.mockImplementation(async () =>
      Response.json({ error: "x", code: "PLUGIN_BACKEND_UNAVAILABLE" }, { status: 422 }),
    );
    // Same code from another method: not the backend's launch.
    errorCode(await guest.request("exec.run", { program: "git" }));
    expect(sink.report).not.toHaveBeenCalled();
  });
});
