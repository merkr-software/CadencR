import { describe, expect, it } from "vitest";
import { actionTargetFromSearch, parseSchedulesSearch, scheduleActionSearch } from "./action-link";

describe("schedules action link", () => {
  it("round-trips an action target through the search params", () => {
    const search = scheduleActionSearch({ projectId: 1, featureId: 7, actionId: 3 });
    expect(search).toEqual({ action: 3, project: 1, feature: 7 });
    expect(actionTargetFromSearch(parseSchedulesSearch({ ...search }))).toEqual({
      actionId: 3,
      projectId: 1,
      featureId: 7,
    });
  });

  it("drops malformed ids and ignores an incomplete link", () => {
    expect(parseSchedulesSearch({ action: "3", project: "x", feature: -2 })).toEqual({
      action: 3,
    });
    expect(actionTargetFromSearch({ action: 3 })).toBeNull();
    expect(actionTargetFromSearch({})).toBeNull();
  });
});
