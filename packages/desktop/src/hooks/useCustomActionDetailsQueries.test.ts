// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CustomAction, CustomActionVariable } from "@/api/generated";
import {
  useCustomActionRuns,
  useCustomActionVariableDrafts,
} from "./useCustomActionDetailsQueries";

const storedVariables = vi.hoisted(() => ({
  data: undefined as CustomActionVariable[] | undefined,
}));
const refetchRuns = vi.hoisted(() => vi.fn());

vi.mock("@/api/generated", () => ({
  useGetCustomActionVariables: () => ({ data: storedVariables.data }),
  useGetCustomActionRuns: () => ({ data: [], refetch: refetchRuns }),
}));

function makeAction(lastRun: CustomAction["last_run"]): CustomAction {
  return {
    id: 6,
    name: "Deploy preview",
    command: "deploy ${ENV}",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    position: 0,
    scope: "project",
    project_id: 1,
    run_in_terminal: false,
    variable_names: ["ENV"],
    last_run: lastRun,
  };
}

describe("useCustomActionVariableDrafts", () => {
  beforeEach((): void => {
    storedVariables.data = undefined;
  });

  it("shows a stored value that loads after the panel mounted", (): void => {
    const { result, rerender } = renderHook(() => useCustomActionVariableDrafts(6, 1));
    expect(result.current.valueOf("ENV")).toBe("");

    storedVariables.data = [{ var_name: "ENV", value: "staging" }];
    rerender();

    expect(result.current.valueOf("ENV")).toBe("staging");
    // Untouched: blurring the field must not write anything back.
    expect(result.current.isDirty("ENV")).toBe(false);
  });

  it("is dirty only while the edit differs from the stored value", (): void => {
    storedVariables.data = [{ var_name: "ENV", value: "staging" }];
    const { result } = renderHook(() => useCustomActionVariableDrafts(6, 1));

    act(() => result.current.setDraft("ENV", "prod"));
    expect(result.current.valueOf("ENV")).toBe("prod");
    expect(result.current.isDirty("ENV")).toBe(true);

    act(() => result.current.setDraft("ENV", "staging"));
    expect(result.current.isDirty("ENV")).toBe(false);
  });
});

describe("useCustomActionRuns", () => {
  beforeEach((): void => {
    refetchRuns.mockClear();
  });

  it("refetches the run history when the action's last run changes", (): void => {
    const { rerender } = renderHook(({ action }) => useCustomActionRuns(action, 1), {
      initialProps: { action: makeAction(null) },
    });
    expect(refetchRuns).not.toHaveBeenCalled();

    // A run started elsewhere (schedule, API) surfaces through the list query.
    rerender({ action: makeAction({ exit_code: null, ended_at: null }) });
    expect(refetchRuns).toHaveBeenCalledTimes(1);

    rerender({ action: makeAction({ exit_code: 0, ended_at: "2026-01-01T00:01:00Z" }) });
    expect(refetchRuns).toHaveBeenCalledTimes(2);

    rerender({ action: makeAction({ exit_code: 0, ended_at: "2026-01-01T00:01:00Z" }) });
    expect(refetchRuns).toHaveBeenCalledTimes(2);
  });
});
