import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { SidebarSampleContext, type SidebarSampleData } from "@/lib/sidebar-sample-context";

const mockUseGetProjectSettings = vi.fn();

vi.mock("@/api/generated", () => ({
  useGetProjectSettings: (id: number, options: unknown) => mockUseGetProjectSettings(id, options),
}));

import { useProjectColor } from "./useProjectColor";

describe("useProjectColor", () => {
  it("returns color from settings", () => {
    mockUseGetProjectSettings.mockReturnValue({
      data: [{ key: "color", value: "ff79c6" }],
    });
    expect(renderHook(() => useProjectColor(1)).result.current).toBe("ff79c6");
  });

  it("returns default color when no color setting exists", () => {
    mockUseGetProjectSettings.mockReturnValue({
      data: [{ key: "branch_prefix", value: "feat/" }],
    });
    expect(renderHook(() => useProjectColor(1)).result.current).toBe("3b82f6");
  });

  it("returns default color when settings are undefined", () => {
    mockUseGetProjectSettings.mockReturnValue({ data: undefined });
    expect(renderHook(() => useProjectColor(1)).result.current).toBe("3b82f6");
  });

  it("reads a sample project's color from the preview, without fetching", () => {
    mockUseGetProjectSettings.mockReturnValue({ data: undefined });
    const sample = { projectColors: new Map([[-1, "f97316"]]) } as unknown as SidebarSampleData;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SidebarSampleContext.Provider value={sample}>{children}</SidebarSampleContext.Provider>
    );
    expect(renderHook(() => useProjectColor(-1), { wrapper }).result.current).toBe("f97316");
    expect(mockUseGetProjectSettings).toHaveBeenLastCalledWith(-1, {
      query: { staleTime: Infinity, enabled: false },
    });
  });
});
