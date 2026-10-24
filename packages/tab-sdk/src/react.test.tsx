import { CadencrError } from "./errors.js";
import { StrictMode, Suspense, startTransition, useLayoutEffect, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
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

  it.each(["pending", "confirmed"] as const)(
    "useStorage keeps a %s layout-effect write when the initial read answers",
    async (writeStatus) => {
      host = createTestHost({ storage: { note: "old" } });
      let answerRead!: (value: string) => void;
      const read = new Promise<string>((resolve) => {
        answerRead = resolve;
      });
      host.handle("storage.get", () => read);
      let finishWrite!: () => void;
      const writeStarted = new Promise<void>((started) => {
        host.handle(
          "storage.set",
          ({ key, value }) =>
            new Promise((resolve) => {
              finishWrite = () => {
                host.storage.set(key, value);
                resolve(null);
              };
              started();
            }),
        );
      });
      let write!: Promise<void>;
      function EarlyNotes() {
        const { value, loading, set } = useStorage<string>("note", "empty");
        useLayoutEffect(() => {
          write = set("chosen");
        }, [set]);
        return <p data-testid="early-note">{loading ? "loading" : value}</p>;
      }
      render(
        <CadencrProvider connectOptions={{ transport: host.transport }}>
          <EarlyNotes />
        </CadencrProvider>,
      );
      await screen.findByTestId("early-note");
      await writeStarted;
      if (writeStatus === "confirmed") {
        await act(async () => {
          finishWrite();
          await write;
        });
        expect(host.storage.get("note")).toBe("chosen");
      } else {
        expect(host.storage.get("note")).toBe("old");
      }
      // Releasing the stale read must not replace either kind of early write.
      await act(async () => {
        answerRead("old");
      });
      try {
        expect((await screen.findByText("chosen")).textContent).toBe("chosen");
      } finally {
        if (writeStatus === "pending") {
          await act(async () => {
            finishWrite();
            await write;
          });
        }
      }
      expect(host.storage.get("note")).toBe("chosen");
    },
  );

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
      await flush();
    });
    expect(button.textContent).toBe("empty");
    expect(screen.getByRole("alert").textContent).toBe("disk full");
    await act(async () => {
      answerRead?.();
      await flush();
    });
    expect(button.textContent).toBe("stored");
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

  it("useStorage accepts a new key's layout-effect write after StrictMode replay", async () => {
    host = createTestHost({ storage: { a: "stored-a", b: "old-b" } });
    let answerRead!: (value: string) => void;
    const read = new Promise<string>((resolve) => {
      answerRead = resolve;
    });
    host.handle("storage.get", ({ key }) => (key === "b" ? read : "stored-a"));
    let write!: Promise<void>;
    function SwitchingNotes() {
      const [key, setKey] = useState("a");
      const { value, loading, set } = useStorage<string>(key, "empty");
      useLayoutEffect(() => {
        if (key === "b") write = set("chosen-b");
      }, [key, set]);
      return (
        <>
          <p>{loading ? "loading" : value}</p>
          <button type="button" onClick={() => setKey("b")}>
            switch
          </button>
        </>
      );
    }
    render(
      <StrictMode>
        <CadencrProvider connectOptions={{ transport: host.transport }}>
          <SwitchingNotes />
        </CadencrProvider>
      </StrictMode>,
    );
    await screen.findByText("stored-a");
    await act(async () => {
      screen.getByRole("button", { name: "switch" }).click();
    });
    await act(async () => {
      await write;
      answerRead("old-b");
    });
    expect(await screen.findByText("chosen-b")).toBeTruthy();
    expect(host.storage.get("b")).toBe("chosen-b");
  });

  it("useStorage rolls back a failed write while Suspense hides the committed key", async () => {
    host = createTestHost({ storage: { note: "stored" } });
    let rejectWrite!: (error: CadencrError) => void;
    const pendingWrite = new Promise<null>((_, reject) => {
      rejectWrite = reject;
    });
    host.handle("storage.set", () => pendingWrite);
    const suspended = new Promise<never>(() => {});
    let write!: Promise<void>;
    function HiddenNotes({ hidden }: { hidden: boolean }) {
      const { value, loading, error, set } = useStorage<string>("note", "empty");
      if (hidden) throw suspended;
      return (
        <>
          <p data-testid="hidden-note">{loading ? "loading" : value}</p>
          {error ? <p role="alert">{error.message}</p> : null}
          <button
            type="button"
            onClick={() => {
              write = set("chosen");
            }}
          >
            write
          </button>
        </>
      );
    }
    function HidingNotes() {
      const [hidden, setHidden] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setHidden((value) => !value)}>
            toggle
          </button>
          <Suspense fallback={<p>hidden fallback</p>}>
            <HiddenNotes hidden={hidden} />
          </Suspense>
        </>
      );
    }
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <HidingNotes />
      </CadencrProvider>,
    );
    await screen.findByText("stored");
    await act(async () => {
      screen.getByRole("button", { name: "write" }).click();
    });
    expect(screen.getByTestId("hidden-note").textContent).toBe("chosen");
    await act(async () => {
      screen.getByRole("button", { name: "toggle" }).click();
    });
    expect(screen.getByText("hidden fallback")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "write" })).toBeNull();
    await act(async () => {
      rejectWrite(new CadencrError("HOST_ERROR", "disk full"));
      await expect(write).rejects.toMatchObject({ code: "HOST_ERROR" });
    });
    await act(async () => {
      screen.getByRole("button", { name: "toggle" }).click();
    });
    expect(screen.queryByText("hidden fallback")).toBeNull();
    expect(screen.getByTestId("hidden-note").textContent).toBe("stored");
    expect(screen.getByRole("alert").textContent).toBe("disk full");
  });

  it("useStorage retains the committed key when a new key's transition suspends", async () => {
    host = createTestHost({ storage: { a: "stored-a", b: "stored-b" } });
    let rejectWrite!: (error: CadencrError) => void;
    const pendingWrite = new Promise<null>((_, reject) => {
      rejectWrite = reject;
    });
    host.handle("storage.set", () => pendingWrite);
    const suspended = new Promise<never>(() => {});
    let renderedB = false;
    let write!: Promise<void>;
    function SwitchingNotes() {
      const [key, setKey] = useState("a");
      const { value, loading, error, set } = useStorage<string>(key, "empty");
      if (key === "b") {
        renderedB = true;
        throw suspended;
      }
      return (
        <>
          <p data-testid="committed-note">{loading ? "loading" : value}</p>
          {error ? <p role="alert">{error.message}</p> : null}
          <button
            type="button"
            onClick={() => {
              write = set("chosen-a");
            }}
          >
            write
          </button>
          <button type="button" onClick={() => startTransition(() => setKey("b"))}>
            switch
          </button>
        </>
      );
    }
    render(
      <CadencrProvider connectOptions={{ transport: host.transport }}>
        <Suspense fallback={<p>switching</p>}>
          <SwitchingNotes />
        </Suspense>
      </CadencrProvider>,
    );
    await screen.findByText("stored-a");
    await act(async () => {
      screen.getByRole("button", { name: "write" }).click();
    });
    expect(screen.getByTestId("committed-note").textContent).toBe("chosen-a");
    await act(async () => {
      screen.getByRole("button", { name: "switch" }).click();
    });
    expect(renderedB).toBe(true);
    expect(screen.queryByText("switching")).toBeNull();
    await act(async () => {
      rejectWrite(new CadencrError("HOST_ERROR", "disk full"));
      await expect(write).rejects.toMatchObject({ code: "HOST_ERROR" });
    });
    expect(screen.getByTestId("committed-note").textContent).toBe("stored-a");
    expect(screen.getByRole("alert").textContent).toBe("disk full");
    expect(host.requests.filter((request) => request.method === "storage.get")).toHaveLength(1);
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
