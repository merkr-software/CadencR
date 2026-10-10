import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useGetFeatureSettings, useGetWorkspaceSetting } from "@/api/generated";

import { useAutoLayoutActive } from "./auto-layout-mode";

vi.mock("@/api/generated", () => ({
  useGetWorkspaceSetting: vi.fn(),
  useGetFeatureSettings: vi.fn(),
}));

interface QueryState {
  data?: unknown;
  isLoading?: boolean;
  error?: unknown;
}

function mockQueries(workspace: QueryState, feature: QueryState): void {
  const query = ({ data, isLoading = false, error = null }: QueryState): unknown => ({
    data,
    isLoading,
    error,
  });
  vi.mocked(useGetWorkspaceSetting).mockReturnValue(
    query(workspace) as ReturnType<typeof useGetWorkspaceSetting>,
  );
  vi.mocked(useGetFeatureSettings).mockReturnValue(
    query(feature) as ReturnType<typeof useGetFeatureSettings>,
  );
}

const FEATURE = 4;

describe("useAutoLayoutActive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is on when nothing is set", () => {
    mockQueries({ data: { value: null } }, { data: null });
    expect(renderHook(() => useAutoLayoutActive(FEATURE)).result.current.active).toBe(true);
  });

  it("stays off while either setting is loading", () => {
    mockQueries({ isLoading: true }, { data: null });
    expect(renderHook(() => useAutoLayoutActive(FEATURE)).result.current.active).toBe(false);
  });

  it("stays off and reports the error when the workspace default can't be read", () => {
    const error = new Error("boom");
    mockQueries({ error }, { data: null });
    const { result } = renderHook(() => useAutoLayoutActive(FEATURE));
    expect(result.current).toMatchObject({ active: false, error });
  });

  it("stays off when the feature override can't be read", () => {
    mockQueries({ data: { value: null } }, { error: new Error("boom") });
    expect(renderHook(() => useAutoLayoutActive(FEATURE)).result.current.active).toBe(false);
  });

  it("stays off when its queries are disabled", () => {
    mockQueries({}, {});
    expect(renderHook(() => useAutoLayoutActive(FEATURE, false)).result.current.active).toBe(false);
  });
});
