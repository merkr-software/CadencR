import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("useArchivedSectionOpen", () => {
  it("opens for an archived active conversation without persisting it", () => {
    const { result } = renderHook(() => useArchivedSectionOpen(4, true));
    expect(result.current.showArchived).toBe(true);
    expect(persistedIds(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY)).toEqual([]);
    act(() => result.current.toggleArchived());
    expect(result.current.showArchived).toBe(false);
  });

  it("persists an explicit open", () => {
    const { result } = renderHook(() => useArchivedSectionOpen(4, false));
    act(() => result.current.toggleArchived());
    expect(result.current.showArchived).toBe(true);
    expect(persistedIds(SIDEBAR_ARCHIVED_OPEN_PROJECTS_KEY)).toEqual([4]);
  });
});
