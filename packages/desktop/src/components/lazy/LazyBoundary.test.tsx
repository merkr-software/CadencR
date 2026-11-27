import { Component, useEffect, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test-utils";
import { LazyBoundary } from "./LazyBoundary";
import { isChunkLoadFailure, lazyChunk, LazyChunkError, preloadableChunk } from "./lazy-chunk";
import { RouteError } from "./RouteFallbacks";

function Panel({ text }: { text: string }) {
  return <p>{text}</p>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class OuterBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <p>outer: {this.state.error.message}</p> : this.props.children;
  }
}

describe("LazyBoundary", () => {
  it("says what is loading, then shows the component", async () => {
    const load = deferred<typeof Panel>();
    const LazyPanel = lazyChunk(() => load.promise);
    render(
      <LazyBoundary label="Terminal">
        <LazyPanel text="terminal body" />
      </LazyBoundary>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading Terminal…");
    load.resolve(Panel);
    expect(await screen.findByText("terminal body")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers a reload when the chunk fails to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const LazyPanel = lazyChunk<{ text: string }>(() =>
      Promise.reject(new TypeError("Importing a module script failed.")),
    );
    render(
      <LazyBoundary label="Git">
        <LazyPanel text="never" />
      </LazyBoundary>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load Git.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("leaves a module that failed while evaluating to the boundary above", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const LazyPanel = lazyChunk<{ text: string }>(() =>
      Promise.reject(new ReferenceError("settings is not defined")),
    );
    render(
      <OuterBoundary>
        <LazyBoundary label="Settings">
          <LazyPanel text="never" />
        </LazyBoundary>
      </OuterBoundary>,
    );
    expect(await screen.findByText("outer: settings is not defined")).toBeInTheDocument();
    expect(screen.queryByText(/Check the connection/)).not.toBeInTheDocument();
  });

  it("leaves any other error to the boundary above", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Broken(): ReactNode {
      throw new Error("render bug");
    }
    const LazyBroken = lazyChunk(() => Promise.resolve(Broken));
    render(
      <OuterBoundary>
        <LazyBoundary label="Editor">
          <LazyBroken />
        </LazyBoundary>
      </OuterBoundary>,
    );
    expect(await screen.findByText("outer: render bug")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("LazyBoundary overlay", () => {
  function Behind({ children }: { children: ReactNode }) {
    return (
      <>
        <textarea aria-label="composer" autoFocus />
        {children}
      </>
    );
  }

  it("holds the keys while it loads, Escape dismisses it, and the focus goes back", () => {
    const onDismiss = vi.fn();
    const LazyPanel = lazyChunk(() => new Promise<typeof Panel>(() => undefined));
    const { unmount } = render(
      <Behind>
        <LazyBoundary label="file search" variant="overlay" onDismiss={onDismiss}>
          <LazyPanel text="never" />
        </LazyBoundary>
      </Behind>,
    );
    const loading = screen.getByRole("status");
    expect(loading).toHaveFocus();
    fireEvent.keyDown(loading, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("hands the focus back before the loaded dialog mounts, so the dialog can return it", async () => {
    const load = deferred<typeof Panel>();
    const LazyPanel = lazyChunk(() => load.promise);
    let focusedAtMount: Element | null = null;
    function Dialog({ text }: { text: string }) {
      useEffect(() => {
        focusedAtMount = document.activeElement;
      }, []);
      return <p>{text}</p>;
    }
    render(
      <Behind>
        <LazyBoundary label="file search" variant="overlay" onDismiss={() => undefined}>
          <LazyPanel text="dialog" />
        </LazyBoundary>
      </Behind>,
    );
    expect(screen.getByRole("status")).toHaveFocus();
    await act(async () => load.resolve(Dialog));
    expect(await screen.findByText("dialog")).toBeInTheDocument();
    expect(focusedAtMount).toBe(screen.getByRole("textbox", { name: "composer" }));
  });

  it("offers Close beside Reload when it fails, and Escape dismisses it too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onDismiss = vi.fn();
    const LazyPanel = lazyChunk<{ text: string }>(() =>
      Promise.reject(new TypeError("Importing a module script failed.")),
    );
    const { user } = render(
      <LazyBoundary label="search" variant="overlay" onDismiss={onDismiss}>
        <LazyPanel text="never" />
      </LazyBoundary>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load search.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});

describe("isChunkLoadFailure", () => {
  it.each([
    [
      "Chromium",
      new TypeError("Failed to fetch dynamically imported module: https://h/assets/a.js"),
    ],
    ["WebKit", new TypeError("Importing a module script failed.")],
    ["Firefox", new TypeError("error loading dynamically imported module: https://h/assets/a.js")],
    ["Vite CSS preload", new Error("Unable to preload CSS for /assets/a.css")],
    ["an already marked failure", new LazyChunkError(new Error("anything"))],
  ])("recognizes %s", (_engine, error) => {
    expect(isChunkLoadFailure(error)).toBe(true);
  });

  it.each([
    ["a module that threw while evaluating", new ReferenceError("window is not defined")],
    ["a network error from a request", new TypeError("Failed to fetch")],
    ["a non-error value", "Importing a module script failed."],
  ])("leaves %s alone", (_case, error) => {
    expect(isChunkLoadFailure(error)).toBe(false);
  });
});

describe("preloadableChunk", () => {
  it("settles a failed prefetch without rejecting, and its render offers Reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn<() => Promise<typeof Panel>>(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module: a.js")),
    );
    const chunk = preloadableChunk(load);
    // What boot awaits outside the phone layout: it never throws.
    await expect(chunk.prefetch()).resolves.toBeUndefined();
    render(
      <LazyBoundary label="conversation">
        <chunk.Component text="transcript" />
      </LazyBoundary>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t load conversation.");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("renders in one pass once preloaded", async () => {
    const chunk = preloadableChunk(() => Promise.resolve(Panel));
    await chunk.preload();
    render(
      <LazyBoundary label="conversation">
        <chunk.Component text="transcript" />
      </LazyBoundary>,
    );
    expect(screen.getByText("transcript")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("loads on first render when nothing preloaded it", async () => {
    const chunk = preloadableChunk(() => Promise.resolve(Panel));
    render(
      <LazyBoundary label="conversation">
        <chunk.Component text="transcript" />
      </LazyBoundary>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading conversation…");
    expect(await screen.findByText("transcript")).toBeInTheDocument();
  });

  it("loads again on render after a failed prefetch", async () => {
    const load = vi
      .fn<() => Promise<typeof Panel>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
      .mockResolvedValue(Panel);
    const chunk = preloadableChunk(load);
    chunk.prefetch();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    render(
      <LazyBoundary label="conversation">
        <chunk.Component text="transcript" />
      </LazyBoundary>,
    );
    expect(await screen.findByText("transcript")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("RouteError", () => {
  it("offers a reload for a page whose chunk failed to load", () => {
    render(
      <RouteError
        error={new TypeError("Failed to fetch dynamically imported module: settings.lazy.js")}
        reset={() => undefined}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t load this page.");
  });
});
