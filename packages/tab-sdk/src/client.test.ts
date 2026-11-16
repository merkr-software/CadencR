import { describe, expect, it, vi } from "vitest";
import { connected, flush } from "./test-utils.js";
import { createTabContext } from "./testing/index.js";

describe("requests", () => {
  it("correlates concurrent responses by id", async () => {
    const { host, client } = await connected();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    host.handle("storage.get", async ({ key }) => {
      if (key === "slow") await gate;
      return key;
    });
    const slow = client.storage.get("slow");
    const fast = client.storage.get("fast");
    await expect(fast).resolves.toBe("fast");
    release();
    await expect(slow).resolves.toBe("slow");
    client.close();
    host.close();
  });

  it("runs one key's storage writes in call order, other keys alongside", async () => {
    const { host, client } = await connected();
    const sent: string[] = [];
    const answers = new Map<string, (ok: boolean) => void>();
    const answer = (label: string) =>
      new Promise<null>((resolve, reject) => {
        sent.push(label);
        answers.set(label, (ok) => (ok ? resolve(null) : reject(new Error(label))));
      });
    host.handle("storage.set", ({ key, value }) => answer(`${key}=${String(value)}`));
    host.handle("storage.delete", ({ key }) => answer(`${key} deleted`));
    const first = client.storage.set("a", 1);
    const second = client.storage.set("a", 2);
    const removed = client.storage.delete("a");
    const other = client.storage.set("b", 1);
    await flush();
    expect(sent).toEqual(["a=1", "b=1"]);
    answers.get("a=1")?.(false);
    await expect(first).rejects.toThrow();
    await flush();
    // A failed write does not hold back the next one.
    expect(sent).toEqual(["a=1", "b=1", "a=2"]);
    answers.get("a=2")?.(true);
    await expect(second).resolves.toBeUndefined();
    await flush();
    expect(sent.at(-1)).toBe("a deleted");
    answers.get("a deleted")?.(true);
    answers.get("b=1")?.(true);
    await expect(removed).resolves.toBeUndefined();
    await expect(other).resolves.toBeUndefined();
    client.close();
    host.close();
  });

  it("saves a queued storage write as it was when set was called", async () => {
    const { host, client } = await connected();
    const saved: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    host.handle("storage.set", async ({ value }) => {
      saved.push(value);
      if (saved.length === 1) await gate;
      return null;
    });
    const first = client.storage.set("prefs", { theme: "dark" });
    const prefs = { theme: "light" };
    const second = client.storage.set("prefs", prefs);
    prefs.theme = "changed later";
    release();
    await Promise.all([first, second]);
    expect(saved).toEqual([{ theme: "dark" }, { theme: "light" }]);
    await expect(client.storage.set("prefs", { run: () => 1 } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    client.close();
    host.close();
  });

  it("times out one request without breaking the connection", async () => {
    const { host, client } = await connected({}, { requestTimeoutMs: 30 });
    host.handle("config.get", () => new Promise(() => {}));
    await expect(client.config.get()).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(client.storage.list()).resolves.toEqual([]);
    client.close();
    host.close();
  });

  it("surfaces host errors as CadencrError", async () => {
    const { host, client } = await connected();
    await expect(client.net.fetch("https://example.com")).rejects.toMatchObject({
      name: "CadencrError",
      code: "PLUGIN_NETWORK_DENIED",
    });
    client.close();
    host.close();
  });

  it("round-trips storage, state, config and ui", async () => {
    const { host, client } = await connected({ config: { group: "directory" } });
    await client.storage.set("a", { n: 1 });
    await expect(client.storage.get("a")).resolves.toEqual({ n: 1 });
    await expect(client.storage.get("missing")).resolves.toBeNull();
    await expect(client.storage.list()).resolves.toEqual(["a"]);
    await client.storage.delete("a");
    await expect(client.storage.list()).resolves.toEqual([]);
    await expect(client.state.get()).resolves.toBeNull();
    await client.state.set({ tab: 2 });
    await expect(client.state.get()).resolves.toEqual({ tab: 2 });
    await expect(client.config.get()).resolves.toEqual({ group: "directory" });
    await client.ui.toast({ title: "Saved", variant: "success" });
    await client.ui.setBadge("3");
    expect(host.badge).toBe("3");
    await expect(client.ui.setBadge("12345")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client.ui.openExternal("http://x.test")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await client.ui.openExternal("https://x.test");
    expect(host.requests.map((r) => r.method)).toContain("ui.openExternal");
    client.close();
    host.close();
  });

  it("encodes net.fetch bodies as ArrayBuffer", async () => {
    const { host, client } = await connected();
    host.handle("net.fetch", ({ body }) => ({
      status: 201,
      headers: { "X-Echo": "1" },
      body: body ?? new ArrayBuffer(0),
    }));
    const response = await client.net.fetch("https://api.test/x", { method: "POST", body: "hi" });
    expect(response.status).toBe(201);
    expect(response.headers["x-echo"]).toBe("1");
    await expect(response.text()).resolves.toBe("hi");
    client.close();
    host.close();
  });
});

describe("events", () => {
  it("tracks context and visibility changes", async () => {
    const { host, client } = await connected();
    const contexts: number[] = [];
    const visibility: boolean[] = [];
    client.onContextChange((context) => contexts.push(context.feature.id));
    client.onVisibilityChange((visible) => visibility.push(visible));
    const next = createTabContext({
      feature: { ...host.context.feature, id: 42 },
    });
    host.setContext(next);
    host.setVisible(false);
    await flush();
    expect(contexts).toEqual([42]);
    expect(client.context.feature.id).toBe(42);
    expect(visibility).toEqual([false]);
    expect(client.visible).toBe(false);
    client.close();
    host.close();
  });

  it("delivers manifest shortcuts and lists the active ones", async () => {
    const { host, client } = await connected({ shortcuts: ["refresh"] });
    const pressed: string[] = [];
    client.onShortcut((id) => pressed.push(id));
    host.pressShortcut("refresh");
    await flush();
    expect(pressed).toEqual(["refresh"]);
    expect(client.shortcuts).toEqual(["refresh"]);
    client.close();
    host.close();
  });

  it("ignores events from a newer host", async () => {
    const { host, client } = await connected();
    const errors: unknown[] = [];
    client.onError((error) => errors.push(error));
    (host.emit as (event: string, payload: object) => void)("made.up", {});
    await flush();
    expect(errors).toEqual([]);
    client.close();
    host.close();
  });

  it("starts hidden when the host says so in the handshake", async () => {
    const { host, client } = await connected({ visible: false });
    expect(client.visible).toBe(false);
    client.close();
    host.close();
  });
});

describe("theme option", () => {
  it("does not touch the document outside a browser", async () => {
    const spy = vi.fn();
    const { host, client } = await connected();
    client.onThemeChange(spy);
    host.setTheme({ ...host.theme, id: "cadencr-light", appearance: "light" });
    await flush();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: "cadencr-light" }));
    expect(client.theme.appearance).toBe("light");
    client.close();
    host.close();
  });
});
