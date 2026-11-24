import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureStatus, type Feature } from "@/api/generated";
import { persistedIds, resetPersistedIdSets } from "@/test/persisted-id-set-mock";
import {
  SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY,
  SIDEBAR_EXPANDED_PROJECTS_KEY,
} from "./usePersistedIdSet";
import { useArchivedSectionOpen } from "./useArchivedSectionOpen";
import { useProjectExpansion } from "./useProjectExpansion";

vi.mock("@/hooks/usePersistedIdSet", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("@/test/persisted-id-set-mock")),
}));

beforeEach(() => resetPersistedIdSets());

describe("useProjectExpansion", () => {
  it("expands the active project without persisting it", () => {
    const { result } = renderHook(() => useProjectExpansion(7));
    expect(result.current.expandedIds.has(7)).toBe(true);
    expect(persistedIds(SIDEBAR_EXPANDED_PROJECTS_KEY)).toEqual([]);
  });

  it("persists explicit toggles, and collapsing the active project sticks", () => {
    const { result } = renderHook(() => useProjectExpansion(7));
    act(() => result.current.setExpanded(3, true));
    expect(persistedIds(SIDEBAR_EXPANDED_PROJECTS_KEY)).toEqual([3]);
    act(() => result.current.setExpanded(7, false));
    expect(result.current.expandedIds.has(7)).toBe(false);
    expect([...result.current.expandedIds]).toEqual([3]);
  });
});

type ActiveFeatureArg = Pick<Feature, "id" | "status"> | undefined;

function active(id: number): ActiveFeatureArg {
  return { id, status: FeatureStatus.active };
}

function archived(id: number): ActiveFeatureArg {
  return { id, status: FeatureStatus.archived };
}

function renderArchivedSectionOpen(initial: ActiveFeatureArg) {
  return renderHook(
    ({ feature }: { feature: ActiveFeatureArg }) => useArchivedSectionOpen(4, feature),
    { initialProps: { feature: initial } },
  );
}

describe("useArchivedSectionOpen", () => {
  it("opens for an archived active conversation without persisting it, and persists re-open after collapse", () => {
    const { result } = renderArchivedSectionOpen(archived(2));
    expect(result.current.showArchived).toBe(true);
    expect(persistedIds(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY)).toEqual([]);

    act(() => result.current.toggleArchived());
    expect(result.current.showArchived).toBe(false);
    expect(persistedIds(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY)).toEqual([]);

    act(() => result.current.toggleArchived());
    expect(result.current.showArchived).toBe(true);
    expect(persistedIds(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY)).toEqual([4]);
  });

  it("opens when an archived active conversation finishes loading", () => {
    const { result, rerender } = renderArchivedSectionOpen(undefined);
    expect(result.current.showArchived).toBe(false);
    rerender({ feature: archived(2) });
    expect(result.current.showArchived).toBe(true);
    expect(persistedIds(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY)).toEqual([]);
  });

  it("closes the auto-opened section when leaving or unarchiving the conversation", () => {
    const { result, rerender } = renderArchivedSectionOpen(archived(2));
    expect(result.current.showArchived).toBe(true);

    rerender({ feature: active(2) });
    expect(result.current.showArchived).toBe(false);

    rerender({ feature: archived(3) });
    expect(result.current.showArchived).toBe(true);

    rerender({ feature: active(1) });
    expect(result.current.showArchived).toBe(false);
  });

  it("does not open when the active conversation is archived, and re-opens if revisited later", () => {
    const { result, rerender } = renderArchivedSectionOpen(active(1));
    expect(result.current.showArchived).toBe(false);

    // Cache flips to archived before navigation leaves feature 1.
    rerender({ feature: archived(1) });
    expect(result.current.showArchived).toBe(false);

    // Navigation lands on the next active conversation, then home.
    rerender({ feature: active(2) });
    expect(result.current.showArchived).toBe(false);
    rerender({ feature: undefined });
    expect(result.current.showArchived).toBe(false);

    // Later explicitly visiting archived feature 1 auto-opens again.
    rerender({ feature: archived(1) });
    expect(result.current.showArchived).toBe(true);
  });

  it("allows explicit open while suppressed after archiving", () => {
    const { result, rerender } = renderArchivedSectionOpen(active(1));
    rerender({ feature: archived(1) });
    expect(result.current.showArchived).toBe(false);

    act(() => result.current.toggleArchived());
    expect(result.current.showArchived).toBe(true);
    expect(persistedIds(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY)).toEqual([4]);
  });

  it("persists an explicit open and keeps it open across conversation changes", () => {
    const { result, rerender } = renderArchivedSectionOpen(active(1));
    act(() => result.current.toggleArchived());
    expect(result.current.showArchived).toBe(true);
    expect(persistedIds(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY)).toEqual([4]);

    rerender({ feature: archived(1) });
    expect(result.current.showArchived).toBe(true);
    rerender({ feature: active(2) });
    expect(result.current.showArchived).toBe(true);
  });

  it("keeps toggleArchived stable across active-to-active conversation switches", () => {
    const { result, rerender } = renderArchivedSectionOpen(active(1));
    const initialToggle = result.current.toggleArchived;

    rerender({ feature: active(2) });
    expect(result.current.toggleArchived).toBe(initialToggle);
  });
});
