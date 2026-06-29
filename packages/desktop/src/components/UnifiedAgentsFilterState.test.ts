import { beforeEach, describe, expect, it } from "vitest";
import {
  readUnifiedAgentsFilters,
  toUnifiedAgentsQueryParams,
} from "@/components/UnifiedAgentsFilterState";

const FILTER_KEYS = {
  mode: "unified_agents_mode",
  freshMinutes: "unified_agents_fresh_minutes",
  projectId: "unified_agents_project_id",
  projectIds: "unified_agents_project_ids",
  excludedTitles: "unified_agents_excluded_titles",
  query: "unified_agents_query",
  sortOrder: "unified_agents_sort_order",
} as const;

describe("UnifiedAgentsFilterState", () => {
  beforeEach((): void => {
    window.localStorage.clear();
  });

  it("falls back for invalid localStorage values", () => {
    window.localStorage.setItem(FILTER_KEYS.mode, "everything");
    window.localStorage.setItem(FILTER_KEYS.freshMinutes, "not-a-number");
    window.localStorage.setItem(FILTER_KEYS.projectId, "-7");
    window.localStorage.setItem(FILTER_KEYS.query, "needle");
    window.localStorage.setItem(FILTER_KEYS.sortOrder, "message_date");

    expect(readUnifiedAgentsFilters()).toEqual({
      mode: "recent",
      freshMinutes: 5,
      projectIds: [],
      excludedTitles: [],
      pinnedOnly: false,
      query: "needle",
      sortOrder: "created_desc",
    });
  });

  it("preserves free freshness values and project filters", () => {
    window.localStorage.setItem(FILTER_KEYS.mode, "all");
    window.localStorage.setItem(FILTER_KEYS.freshMinutes, "999");
    window.localStorage.setItem(FILTER_KEYS.projectIds, "42,43,42");
    window.localStorage.setItem(FILTER_KEYS.sortOrder, "created_asc");

    expect(readUnifiedAgentsFilters()).toEqual({
      mode: "all",
      freshMinutes: 999,
      projectIds: [42, 43],
      excludedTitles: [],
      pinnedOnly: false,
      query: "",
      sortOrder: "created_asc",
    });
  });

  it("reads, trims, and dedupes persisted excluded titles", () => {
    window.localStorage.setItem(
      FILTER_KEYS.excludedTitles,
      JSON.stringify(["  auth  ", "auth", "Docs site", 42]),
    );

    expect(readUnifiedAgentsFilters().excludedTitles).toEqual(["auth", "Docs site"]);
  });

  it("ignores malformed excluded-title storage", () => {
    window.localStorage.setItem(FILTER_KEYS.excludedTitles, "{not json");

    expect(readUnifiedAgentsFilters().excludedTitles).toEqual([]);
  });

  it("reads persisted activity sort options", () => {
    window.localStorage.setItem(FILTER_KEYS.sortOrder, "activity_asc");

    expect(readUnifiedAgentsFilters().sortOrder).toBe("activity_asc");
  });

  it("never requests archived agents from the unified agents API", () => {
    expect(toUnifiedAgentsQueryParams({ mode: "all", freshMinutes: 240 }, 100)).toEqual({
      mode: "all",
      fresh_minutes: undefined,
      message_limit: 100,
    });
  });
});
