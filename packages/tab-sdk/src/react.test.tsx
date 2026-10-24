import { CadencrError } from "./errors.js";
import { StrictMode, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CadencrProvider,
  useCadencr,
  useShortcut,
  useStorage,
  useStream,
  useTabContext,
  useTheme,
  useVisibility,
} from "./react.js";
import { flush } from "./test-utils.js";
import { createTestHost, type TestHost } from "./testing/index.js";

let host: TestHost;

afterEach(() => {
  cleanup();
  host?.close();
});

function Info() {
  const context = useTabContext();
  const theme = useTheme();
  const visible = useVisibility();
  return (
    <p data-testid="info">
      {context.feature.name}|{theme.appearance}|{visible ? "shown" : "hidden"}
    </p>
  );
}

describe("CadencrProvider", () => {
  it("renders the fallback, then children wired to live context", async () => {
    host = createTestHost();
    render(
      <StrictMode>
        <CadencrProvider
          fallback={<p>connecting</p>}
          connectOptions={{ transport: host.transport }}
        >
          <Info />
        </CadencrProvider>
      </StrictMode>,
    );
    expect(screen.getByText("connecting")).toBeTruthy();
    expect((await screen.findByTestId("info")).textContent).toBe("Demo feature|dark|shown");
    await act(async () => {
      host.setContext({ ...host.context, feature: { ...host.context.feature, name: "Next" } });
      host.setTheme({ ...host.theme, appearance: "light" });
      host.setVisible(false);
      await flush();
    });
    expect(screen.getByTestId("info").textContent).toBe("Next|light|hidden");
  });

  it("runs a useShortcut handler for its id only", async () => {
    host = createTestHost({ shortcuts: ["refresh", "next"] });
    function Counter() {
      const [count, setCount] = useState(0);
      useShortcut("refresh", () => setCount((value) => value + 1));
      return <p data-testid="count">{count}</p>;
    }
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <Counter />
      </CadencrProvider>,
    );
    await screen.findByTestId("count");
    await act(async () => {
      host.pressShortcut("refresh");
      host.pressShortcut("next");
      host.pressShortcut("refresh");
      await flush();
    });
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("renders errorFallback when the connection fails", async () => {
    host = createTestHost({ apiVersions: [9, 9] });
    render(
      <CadencrProvider
        connectOptions={{ transport: host.transport }}
        errorFallback={(error) => <p>failed: {error.code}</p>}
      >
        <Info />
      </CadencrProvider>,
    );
    expect(await screen.findByText("failed: PLUGIN_API_UNSUPPORTED")).toBeTruthy();
  });

  it("renders a built-in error state without errorFallback", async () => {
    host = createTestHost({ apiVersions: [9, 9] });
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <Info />
      </CadencrProvider>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Can't reach Cadencr");
    expect(alert.textContent).toContain("PLUGIN_API_UNSUPPORTED");
    expect(screen.queryByTestId("info")).toBeNull();
  });
});

function Counter() {
  const [count, setCount] = useState(0);
  const [, rerender] = useState(0);
  useStream("git.status", () => setCount((n) => n + 1));
  const client = useCadencr();
  return (
    <button type="button" onClick={() => rerender((n) => n + 1)}>
      {count}:{client.instanceId}
    </button>
  );
}

function Notes() {
  const { value, loading, set } = useStorage<string>("note", "empty");
  if (loading) return <p>loading</p>;
  return (
    <button type="button" onClick={() => void set("saved")}>
      {value}
    </button>
  );
}

function EagerNotes() {
  const { value, error, set } = useStorage<string>("note", "empty");
  return (
    <>
      {/* A failed write is reported through `error`, shown below. */}
      <button type="button" onClick={() => set("chosen").catch(() => undefined)}>
        {value}
      </button>
      {error ? <p role="alert">{error.message}</p> : null}
    </>
  );
}

describe("hooks", () => {
  it("useStream keeps one subscription across renders", async () => {
    host = createTestHost();
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <Counter />
      </CadencrProvider>,
    );
    const button = await screen.findByRole("button");
    await act(async () => {
      button.click();
      button.click();
      await flush();
    });
    expect(host.subscriptions.size).toBe(1);
    await act(async () => {
      host.pushStream("git.status", { domain: "git", action: "status", payload: {} });
      host.pushStream("git.status", { domain: "git", action: "status", payload: {} });
      await flush();
    });
    expect(button.textContent).toBe("2:test-instance");
    cleanup();
    await flush();
    expect(host.subscriptions.size).toBe(0);
  });

  it("useStorage loads and writes through", async () => {
    host = createTestHost({ storage: { note: "hello" } });
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <Notes />
      </CadencrProvider>,
    );
    const button = await screen.findByRole("button");
    expect(button.textContent).toBe("hello");
    await act(async () => {
      button.click();
      await flush();
    });
    expect(button.textContent).toBe("saved");
    expect(host.storage.get("note")).toBe("saved");
  });

  it("useStorage keeps a write made before the first read answered", async () => {
    host = createTestHost({ storage: { note: "old" } });
    let answerRead: (() => void) | undefined;
    host.handle(
      "storage.get",
      () =>
        new Promise((resolve) => {
          answerRead = () => resolve("old");
        }),
    );
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <EagerNotes />
      </CadencrProvider>,
    );
    const button = await screen.findByRole("button");
    await act(async () => {
      button.click();
      await flush();
    });
    expect(button.textContent).toBe("chosen");
    await act(async () => {
      answerRead?.();
      await flush();
    });
    expect(button.textContent).toBe("chosen");
    expect(host.storage.get("note")).toBe("chosen");
  });

  it("useStorage shows the stored value when a write failed before the first read answered", async () => {
    host = createTestHost({ storage: { note: "stored" } });
    let answerRead: (() => void) | undefined;
    host.handle(
      "storage.get",
      () =>
        new Promise((resolve) => {
          answerRead = () => resolve("stored");
        }),
    );
    host.handle("storage.set", () => {
      throw new CadencrError("HOST_ERROR", "disk full");
    });
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <EagerNotes />
      </CadencrProvider>,
    );
    const button = await screen.findByRole("button");
    await act(async () => {
      button.click();
    });
    // The failed write's round trip can outlast a fixed flush on a busy runner.
    expect((await screen.findByRole("alert")).textContent).toBe("disk full");
    expect(button.textContent).toBe("empty");
    await act(async () => {
      answerRead?.();
    });
    await waitFor(() => expect(button.textContent).toBe("stored"));
  });

  it("useStorage shows the new key's value while a write to the old key is pending", async () => {
    host = createTestHost({ storage: { a: "value-a", b: "value-b" } });
    let finishWrite: (() => void) | undefined;
    host.handle(
      "storage.set",
      () =>
        new Promise((resolve) => {
          finishWrite = () => resolve(null);
        }),
    );
    function Switcher() {
      const [key, setKey] = useState("a");
      const { value, loading, set } = useStorage<string>(key, "empty");
      return (
        <>
          <p data-testid="value">{loading ? "loading" : value}</p>
          <button type="button" onClick={() => set("chosen-a").catch(() => undefined)}>
            write
          </button>
          <button type="button" onClick={() => setKey("b")}>
            switch
          </button>
        </>
      );
    }
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <Switcher />
      </CadencrProvider>,
    );
    const shown = () => screen.getByTestId("value").textContent;
    await screen.findByText("value-a");
    await act(async () => {
      screen.getByRole("button", { name: "write" }).click();
      await flush();
    });
    await act(async () => {
      screen.getByRole("button", { name: "switch" }).click();
      await flush();
    });
    expect(shown()).toBe("value-b");
    await act(async () => {
      finishWrite?.();
      await flush();
    });
    expect(shown()).toBe("value-b");
  });

  it("useStorage rolls a failed write back to the one saved before it", async () => {
    host = createTestHost({ storage: { note: "stored" } });
    const writes: Array<{ value: unknown; finish: (ok: boolean) => void }> = [];
    host.handle(
      "storage.set",
      ({ value }) =>
        new Promise((resolve, reject) => {
          writes.push({
            value,
            finish: (ok) => (ok ? resolve(null) : reject(new CadencrError("HOST_ERROR", "boom"))),
          });
        }),
    );
    function Overlapping() {
      const { value, loading, set } = useStorage<string>("note", "empty");
      if (loading) return <p>loading</p>;
      return (
        <>
          <p data-testid="value">{value}</p>
          <button type="button" onClick={() => set("A").catch(() => undefined)}>
            A
          </button>
          <button type="button" onClick={() => set("B").catch(() => undefined)}>
            B
          </button>
        </>
      );
    }
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <Overlapping />
      </CadencrProvider>,
    );
    const shown = () => screen.getByTestId("value").textContent;
    await screen.findByText("stored");
    await act(async () => {
      screen.getByRole("button", { name: "A" }).click();
      screen.getByRole("button", { name: "B" }).click();
      await flush();
    });
    expect(shown()).toBe("B");
    // B waits for A: it cannot be saved first and leave A stored.
    expect(writes.map((write) => write.value)).toEqual(["A"]);
    await act(async () => {
      writes[0]?.finish(true);
      await flush();
    });
    expect(writes.map((write) => write.value)).toEqual(["A", "B"]);
    await act(async () => {
      writes[1]?.finish(false);
      await flush();
    });
    expect(shown()).toBe("A");
  });
});
