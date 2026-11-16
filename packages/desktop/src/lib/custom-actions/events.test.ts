import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getGetCustomActionRunsQueryKey,
  getListCustomActionsQueryKey,
  getListFeatureActivityQueryKey,
} from "@/api/generated";
import { applyCustomActionEvent } from "./events";

const announceFinishedRun = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./launch", () => ({ announceFinishedRun }));

describe("applyCustomActionEvent", () => {
  let client: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new QueryClient();
    invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    announceFinishedRun.mockClear();
  });

  it("refreshes every action list when an action changed", () => {
    applyCustomActionEvent(client, { kind: "changed", action_id: 4 });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: getListCustomActionsQueryKey(),
    });
  });

  it("refreshes only the run history while output streams", () => {
    applyCustomActionEvent(client, { kind: "run_output", action_id: 4, feature_id: 9, run_id: 2 });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: getGetCustomActionRunsQueryKey(4, { feature_id: 9 }),
    });
  });

  it("refreshes history, status and activity and announces a finished run", () => {
    applyCustomActionEvent(client, {
      kind: "run_finished",
      action_id: 4,
      feature_id: 9,
      run_id: 2,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getGetCustomActionRunsQueryKey(4, { feature_id: 9 }),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: getListCustomActionsQueryKey({ feature_id: 9 }),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: getListFeatureActivityQueryKey() });
    expect(announceFinishedRun).toHaveBeenCalledWith(2);
  });

  it("refreshes everything custom-action related after a lagged stream", () => {
    applyCustomActionEvent(client, {});
    expect(invalidate).toHaveBeenCalledOnce();
    const [filters] = invalidate.mock.calls[0] as [
      { predicate: (q: { queryKey: unknown[] }) => boolean },
    ];
    expect(filters.predicate({ queryKey: ["/api/custom-actions/4/runs"] })).toBe(true);
    expect(filters.predicate({ queryKey: ["/api/features/activity"] })).toBe(false);
  });
});
