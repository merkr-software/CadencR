import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTCH_PREFS,
  type NotchAgent,
  type NotchBridge,
  type NotchPrefs,
  type NotchPrimaryStyle,
  type NotchNotification,
} from "@/shared/notch";
import { NotchIsland } from "./NotchIsland";

function agent(featureId: number, status: NotchAgent["status"]): NotchAgent {
  return {
    featureId,
    projectId: 1,
    title: `Agent ${featureId}`,
    projectName: "cadencr",
    status,
    pendingKind: status === "question" ? "permission" : null,
    providerLabel: null,
    providerIconSrc: null,
    providerIconMono: false,
    turnStartedAtMs: null,
    lastActivityAtMs: null,
    lastAction: null,
    preview: null,
    unread: false,
  };
}

interface BridgeHandles {
  bridge: NotchBridge;
  notify: (notification: NotchNotification) => void;
  hover: (hovering: boolean) => void;
  snoozed: (until: number | null) => void;
}

function installBridge(
  prefs: NotchPrefs,
  hardware = true,
  agents = [agent(1, "question"), agent(2, "running")],
  snoozedUntil: number | null = null,
): NotchBridge & BridgeHandles {
  const off = () => () => {};
  let notify: (notification: NotchNotification) => void = () => {};
  let hover: (hovering: boolean) => void = () => {};
  let snoozed: (until: number | null) => void = () => {};
  const bridge: NotchBridge = {
    ready: () =>
      Promise.resolve({
        geometry: {
          notchWidth: 200,
          compactWidth: 400,
          notchHeight: 32,
          hardware,
          windowWidth: 720,
          windowHeight: 620,
        },
        snapshot: { agents },
        prefs,
        snoozedUntil,
      }),
    setHotRect: vi.fn(() => Promise.resolve()),
    openFeature: vi.fn(() => Promise.resolve()),
    dismiss: vi.fn(() => Promise.resolve()),
    collapse: vi.fn(() => Promise.resolve()),
    snooze: vi.fn(() => Promise.resolve()),
    onSnapshot: off,
    onNotification: (cb) => {
      notify = cb;
      return () => {};
    },
    onHover: (cb) => {
      hover = cb;
      return () => {};
    },
    onGeometry: off,
    onPrefs: off,
    onSnooze: (cb) => {
      snoozed = cb;
      return () => {};
    },
  };
  const handles = {
    ...bridge,
    bridge,
    notify: (n: NotchNotification) => notify(n),
    hover: (h: boolean) => hover(h),
    snoozed: (until: number | null) => snoozed(until),
  };
  window.cadencrNotch = handles;
  return handles;
}

async function renderCompactLayer(prefs: NotchPrefs, hardware = true): Promise<HTMLElement> {
  installBridge(prefs, hardware);
  const { container } = render(<NotchIsland />);
  await waitFor(() =>
    expect(container.querySelector('.island[data-mode="compact"]')).not.toBeNull(),
  );
  const layer = container.querySelector<HTMLElement>('.layer[data-active="true"]');
  if (!layer) throw new Error("No active layer");
  return layer;
}

afterEach(() => {
  delete window.cadencrNotch;
  vi.useRealTimers();
});

describe("NotchIsland compact ears", () => {
  it("shows the plain logo and still status dots with Always animate off", async () => {
    const layer = await renderCompactLayer(DEFAULT_NOTCH_PREFS);

    expect(layer.querySelector(".orb")?.getAttribute("data-state")).toBe("logo");
    expect(layer.querySelector(".compact-dots")?.getAttribute("data-still")).toBe("true");
    expect(
      [...layer.querySelectorAll(".compact-dot")].map((dot) => dot.getAttribute("data-status")),
    ).toEqual(["question", "running"]);
  });

  it("shows the aggregate status orb with Always animate on", async () => {
    const layer = await renderCompactLayer({ ...DEFAULT_NOTCH_PREFS, alwaysAnimate: true });

    expect(layer.querySelector(".orb")?.getAttribute("data-state")).toBe("question");
    expect(layer.querySelector(".compact-dots")?.getAttribute("data-still")).toBe("false");
  });

  it("replaces virtual compact ears with an 8px strip and a matching pointer region", async () => {
    const layer = await renderCompactLayer(DEFAULT_NOTCH_PREFS, false);
    const island = layer.closest<HTMLElement>(".island");
    expect(island?.style.getPropertyValue("--ih")).toBe("8px");
    expect(island?.style.getPropertyValue("--ir")).toBe("4px");
    expect(layer.querySelector(".orb")).toBeNull();
    expect(layer.querySelector(".compact-dots")).toBeNull();
    expect(layer.querySelector(".activity-strip")?.getAttribute("data-still")).toBe("true");
    expect(layer.querySelectorAll(".activity-logo-point")).toHaveLength(3);
    expect(
      [...layer.querySelectorAll(".activity-segment")].map((segment) =>
        segment.getAttribute("data-status"),
      ),
    ).toEqual(["question", "running"]);
    expect(window.cadencrNotch?.setHotRect).toHaveBeenLastCalledWith({
      x: 260,
      y: 0,
      width: 200,
      height: 8,
    });
  });

  it.each([
    ["strip_4", false],
    ["strip_8", false],
    ["builtin", false],
    ["builtin", true],
  ] as const)(
    "tucks %s status away without ambient agents on hardware=%s",
    async (primaryStyle, hardware) => {
      installBridge({ ...DEFAULT_NOTCH_PREFS, primaryStyle }, hardware, []);
      const { container } = render(<NotchIsland />);
      await waitFor(() => expect(container.querySelector(".island")).not.toBeNull());
      const island = container.querySelector<HTMLElement>(".island");
      expect(island?.dataset.mode).toBe("idle");
      expect(island?.dataset.hidden).toBe(String(!hardware));
      expect(container.querySelector('.layer[data-active="true"]')).toBeNull();
      if (hardware) {
        expect(island?.style.getPropertyValue("--iw")).toBe("200px");
        expect(island?.style.getPropertyValue("--ih")).toBe("32px");
      }
    },
  );

  it.each([
    ["strip_4", 4, 2, 200],
    ["strip_8", 8, 4, 200],
    ["builtin", 32, 13, 312],
  ] as const)(
    "renders primary style %s at its own size",
    async (primaryStyle, height, radius, width) => {
      const layer = await renderCompactLayer({ ...DEFAULT_NOTCH_PREFS, primaryStyle }, false);
      const island = layer.closest<HTMLElement>(".island");
      expect(island?.style.getPropertyValue("--ih")).toBe(`${height}px`);
      expect(island?.style.getPropertyValue("--ir")).toBe(`${radius}px`);
      expect(island?.style.getPropertyValue("--iw")).toBe(`${width}px`);
      expect(island?.dataset.hardware).toBe("false");
      expect(layer.querySelector(".orb") != null).toBe(primaryStyle === "builtin");
      expect(layer.querySelector(".activity-strip") != null).toBe(primaryStyle !== "builtin");
    },
  );

  it.each(["none", "strip_4", "strip_8", "builtin"] as const)(
    "keeps hardware geometry and content unchanged with primary style %s",
    async (primaryStyle) => {
      const layer = await renderCompactLayer({ ...DEFAULT_NOTCH_PREFS, primaryStyle });
      const island = layer.closest<HTMLElement>(".island");
      expect(island?.style.getPropertyValue("--ih")).toBe("32px");
      expect(island?.style.getPropertyValue("--iw")).toBe("312px");
      expect(layer.querySelector(".orb")).not.toBeNull();
      expect(layer.querySelector(".activity-strip")).toBeNull();
    },
  );

  it("hides primary status and clears the pointer region even when a panel was open", async () => {
    const bridge = installBridge(DEFAULT_NOTCH_PREFS, false);
    let hover: Parameters<NotchBridge["onHover"]>[0] | undefined;
    let prefs: Parameters<NotchBridge["onPrefs"]>[0] | undefined;
    bridge.onHover = (callback) => {
      hover = callback;
      return () => {};
    };
    bridge.onPrefs = (callback) => {
      prefs = callback;
      return () => {};
    };
    const { container } = render(<NotchIsland />);
    await waitFor(() => expect(container.querySelector(".activity-strip")).not.toBeNull());
    act(() => hover?.(true));
    await waitFor(() =>
      expect(container.querySelector(".island")?.getAttribute("data-mode")).toBe("expanded"),
    );
    act(() => prefs?.({ ...DEFAULT_NOTCH_PREFS, primaryStyle: "none" }));
    expect(container.querySelector(".island")?.getAttribute("data-hidden")).toBe("true");
    expect(container.querySelector(".island")?.getAttribute("data-mode")).toBe("idle");
    expect(container.querySelector(".activity-strip")).toBeNull();
    expect(bridge.setHotRect).toHaveBeenLastCalledWith({ x: 360, y: 0, width: 0, height: 0 });
  });

  it("honors Always on off for the virtual strip", async () => {
    installBridge({ ...DEFAULT_NOTCH_PREFS, alwaysOn: false }, false);
    const { container } = render(<NotchIsland />);
    await waitFor(() => expect(container.querySelector(".island")).not.toBeNull());
    expect(container.querySelector(".island")?.getAttribute("data-mode")).toBe("idle");
    expect(container.querySelector(".island")?.getAttribute("data-hidden")).toBe("true");
  });

  it("updates the three-point mark as unread replies give way to work or waiting", async () => {
    const done = { ...agent(1, "done"), unread: true };
    const bridge = installBridge(DEFAULT_NOTCH_PREFS, false, [done]);
    let snapshot: Parameters<NotchBridge["onSnapshot"]>[0] | undefined;
    bridge.onSnapshot = (callback) => {
      snapshot = callback;
      return () => {};
    };
    const { container } = render(<NotchIsland />);
    const logo = () => container.querySelector(".activity-logo");
    await waitFor(() => expect(logo()?.getAttribute("data-state")).toBe("done"));
    expect(logo()?.querySelectorAll(".activity-logo-point")).toHaveLength(3);

    act(() => snapshot?.({ agents: [done, agent(2, "running")] }));
    expect(logo()?.getAttribute("data-state")).toBe("running");
    act(() => snapshot?.({ agents: [done, agent(2, "question")] }));
    expect(logo()?.getAttribute("data-state")).toBe("question");
    act(() => snapshot?.({ agents: [done] }));
    expect(logo()?.getAttribute("data-state")).toBe("done");
    act(() => snapshot?.({ agents: [{ ...done, unread: false }] }));
    expect(logo()?.getAttribute("data-state")).toBe("idle");
    expect(container.querySelector(".island")?.getAttribute("data-mode")).toBe("idle");
    expect(container.querySelector(".island")?.getAttribute("data-hidden")).toBe("true");
    act(() => snapshot?.({ agents: [agent(2, "running")] }));
    expect(container.querySelector(".island")?.getAttribute("data-mode")).toBe("compact");
    expect(container.querySelector(".island")?.getAttribute("data-hidden")).toBe("false");
  });

  it("shows every ambient agent as a segment while excluding read replies", async () => {
    const agents = Array.from({ length: 24 }, (_, index) => agent(index + 1, "running"));
    agents[0] = agent(1, "done");
    agents[1] = { ...agent(2, "done"), unread: true };
    agents[2] = { ...agent(3, "question"), pendingKind: "question" };
    installBridge({ ...DEFAULT_NOTCH_PREFS, alwaysAnimate: true }, false, agents);
    const { container } = render(<NotchIsland />);
    await waitFor(() => expect(container.querySelector(".activity-segment")).not.toBeNull());
    expect(container.querySelectorAll(".activity-segment")).toHaveLength(23);
    expect(container.querySelector(".activity-strip")?.getAttribute("data-still")).toBe("false");
    expect(container.querySelector('.activity-segment[data-kind="question"]')).not.toBeNull();
    const width = Number.parseFloat(
      container.querySelector<HTMLElement>(".island")?.style.getPropertyValue("--iw") ?? "",
    );
    expect(width).toBe(200);
  });

  it.each([
    ["strip_4", 9, 9, 0],
    ["strip_4", 10, 7, 3],
    ["strip_4", 24, 6, 18],
    ["strip_8", 9, 9, 0],
    ["strip_8", 10, 7, 3],
    ["strip_8", 24, 6, 18],
  ] as const)(
    "keeps urgent dots visible in a narrow %s strip with %i sessions",
    async (primaryStyle, count, visible, extra) => {
      const agents = Array.from({ length: count }, (_, index) => agent(index + 1, "running"));
      agents[0] = agent(1, "question");
      agents[1] = { ...agent(2, "question"), pendingKind: "question" };
      agents[2] = { ...agent(3, "done"), unread: true };
      const bridge = installBridge({ ...DEFAULT_NOTCH_PREFS, primaryStyle }, false, agents);
      const ready = bridge.ready;
      bridge.ready = async () => {
        const state = await ready();
        if (!state.geometry) throw new Error("Missing test geometry");
        return { ...state, geometry: { ...state.geometry, compactWidth: 184 } };
      };
      const { container } = render(<NotchIsland />);
      await waitFor(() => expect(container.querySelector(".activity-strip")).not.toBeNull());
      const dots = [...container.querySelectorAll(".activity-segment")];
      expect(dots).toHaveLength(visible);
      expect(dots.slice(0, 3).map((dot) => dot.getAttribute("data-status"))).toEqual([
        "question",
        "question",
        "done",
      ]);
      expect(dots[0]?.getAttribute("data-kind")).toBe("permission");
      expect(dots[1]?.getAttribute("data-kind")).toBe("question");
      expect(container.querySelector(".activity-count")?.textContent ?? null).toBe(
        extra > 0 ? `+${extra}` : null,
      );
    },
  );

  it.each<NotchPrimaryStyle>(["none", "strip_4", "strip_8", "builtin"])(
    "keeps notification peeks at their existing size with primary style %s",
    async (primaryStyle) => {
      const bridge = installBridge({ ...DEFAULT_NOTCH_PREFS, primaryStyle }, false, []);
      let notify: ((notification: NotchNotification) => void) | undefined;
      bridge.onNotification = (callback) => {
        notify = callback;
        return () => {};
      };
      const { container } = render(<NotchIsland />);
      await waitFor(() => expect(container.querySelector(".island")).not.toBeNull());
      act(() =>
        notify?.({
          id: "test",
          featureId: null,
          projectId: null,
          status: "completed",
          title: "Your agent finished",
          body: "A finished reply",
        }),
      );
      await waitFor(() =>
        expect(container.querySelector('.island[data-mode="peek"]')).not.toBeNull(),
      );
      const layer = container.querySelector<HTMLElement>('.layer[data-active="true"]');
      expect(layer?.querySelector(".ears")?.getAttribute("style")).toContain("height: 32px");
      expect(layer?.querySelector(".peek-title")?.textContent).toBe("Your agent finished");
      expect(layer?.querySelector(".activity-strip")).toBeNull();
      expect(bridge.setHotRect).toHaveBeenLastCalledWith(expect.objectContaining({ width: 460 }));
    },
  );

  it("keeps the expanded virtual panel and its pointer slack on hover", async () => {
    const bridge = installBridge(DEFAULT_NOTCH_PREFS, false);
    let hover: ((hovering: boolean) => void) | undefined;
    bridge.onHover = (callback) => {
      hover = callback;
      return () => {};
    };
    const { container } = render(<NotchIsland />);
    await waitFor(() => expect(container.querySelector(".activity-strip")).not.toBeNull());
    act(() => hover?.(true));
    await waitFor(() =>
      expect(container.querySelector('.island[data-mode="expanded"]')).not.toBeNull(),
    );
    const layer = container.querySelector<HTMLElement>('.layer[data-active="true"]');
    expect(layer?.querySelector(".panel-list")).not.toBeNull();
    expect(layer?.querySelector(".ears")?.getAttribute("style")).toContain("height: 32px");
    expect(layer?.querySelector(".activity-strip")).toBeNull();
  });
});

describe("NotchIsland snooze and close", () => {
  const ALWAYS_ON: NotchPrefs = DEFAULT_NOTCH_PREFS;
  const mode = (container: HTMLElement) =>
    container.querySelector(".island")?.getAttribute("data-mode");

  it("tucks the compact ears away while snoozed, and brings them back once it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installBridge(ALWAYS_ON, true, undefined, Date.now() + 60_000);
    const { container } = render(<NotchIsland />);
    await waitFor(() => expect(mode(container)).toBe("idle"));

    act(() => vi.advanceTimersByTime(60_000));

    expect(mode(container)).toBe("compact");
  });

  it.each(["strip_4", "strip_8", "builtin"] as const)(
    "honors snooze and resume in primary style %s",
    async (primaryStyle) => {
      const handles = installBridge({ ...ALWAYS_ON, primaryStyle }, false);
      const { container } = render(<NotchIsland />);
      await waitFor(() => expect(mode(container)).toBe("compact"));
      act(() => handles.snoozed(Date.now() + 60_000));
      expect(mode(container)).toBe("idle");
      expect(container.querySelector(".island")?.getAttribute("data-hidden")).toBe("true");
      act(() => handles.snoozed(null));
      expect(mode(container)).toBe("compact");
    },
  );

  /** A notification peeking out, with the pointer resting on it. */
  async function heldPeek(): Promise<BridgeHandles & { container: HTMLElement }> {
    const handles = installBridge(ALWAYS_ON);
    const { container } = render(<NotchIsland />);
    await waitFor(() => expect(mode(container)).toBe("compact"));
    act(() =>
      handles.notify({
        id: "n1",
        featureId: 1,
        projectId: 1,
        status: "completed",
        title: "Agent finished",
        body: "",
      }),
    );
    act(() => handles.hover(true));
    await screen.findByRole("button", { name: "Close" });
    return { ...handles, container };
  }

  it("closes a held peek without opening its conversation", async () => {
    const { bridge } = await heldPeek();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(bridge.collapse).toHaveBeenCalled();
    expect(bridge.openFeature).not.toHaveBeenCalled();
    expect(screen.queryByText("Agent finished")).toBeNull();
  });

  it("opens the conversation from the rest of the peek", async () => {
    const { bridge } = await heldPeek();

    fireEvent.click(screen.getByRole("button", { name: "Open Agent finished" }));

    expect(bridge.openFeature).toHaveBeenCalledWith({ featureId: 1, projectId: 1 });
  });

  it("snoozes from a held peek, which main's snooze push then drops", async () => {
    const { bridge, snoozed, container } = await heldPeek();

    fireEvent.click(screen.getByRole("button", { name: "30m" }));
    expect(bridge.snooze).toHaveBeenCalledWith(30);
    expect(bridge.openFeature).not.toHaveBeenCalled();

    act(() => {
      snoozed(Date.now() + 30 * 60_000);
    });
    expect(screen.queryByText("Agent finished")).toBeNull();
    expect(mode(container)).not.toBe("compact");
  });
});
