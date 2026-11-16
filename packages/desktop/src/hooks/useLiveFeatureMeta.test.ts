// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveFeatureMeta } from "./useLiveFeatureMeta";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry, type SessionEntry } from "@/stores/ws-session-types";

function seedSession(id: string, patch: Partial<SessionEntry>): void {
  useWsSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [id]: { ...createSessionEntry(), ...patch } },
  }));
}

describe("useLiveFeatureMeta", () => {
  beforeEach(() => {
    useWsSessionStore.setState({ sessions: {} });
  });

  it("keeps a stable snapshot ref when an unrelated slice mutates (stream delta)", () => {
    seedSession("s-a", { featureTitle: "Fix login" });
    const { result } = renderHook(() => useLiveFeatureMeta());
    const first = result.current;
    expect(first["s-a"]?.featureTitle).toBe("Fix login");

    // A stream delta bumps `blocks` (and the whole sessions object) but leaves
    // title/auto-naming untouched — the snapshot ref must not change, so the
    // sidebar does not re-render.
    act(() => {
      useWsSessionStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          "s-a": { ...s.sessions["s-a"], blocks: [{ id: "b1", type: "text", content: "hi" }] },
        },
      }));
    });
    expect(result.current).toBe(first);
  });

  it("updates the snapshot when a feature title changes", () => {
    seedSession("s-a", { featureTitle: null });
    const { result } = renderHook(() => useLiveFeatureMeta());

    act(() => seedSession("s-a", { featureTitle: "Renamed" }));
    expect(result.current["s-a"]?.featureTitle).toBe("Renamed");
  });

  it("updates the snapshot when auto-naming toggles", () => {
    seedSession("s-a", { isAutoNaming: false });
    const { result } = renderHook(() => useLiveFeatureMeta());
    // No live meta yet (not naming, no title): absent from the snapshot.
    expect(result.current["s-a"]).toBeUndefined();

    act(() => seedSession("s-a", { isAutoNaming: true }));
    expect(result.current["s-a"]?.isAutoNaming).toBe(true);
  });
});
