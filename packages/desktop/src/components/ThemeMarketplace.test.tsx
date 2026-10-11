import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test-utils";
import { ThemeMarketplace } from "./ThemeMarketplace";
const mocks = vi.hoisted(() => ({ state: vi.fn(), mutate: vi.fn() }));
vi.mock("@/hooks/useThemeMarketplace", () => ({ useThemeMarketplace: mocks.state }));
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));
describe("damaged managed theme diagnostics", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.state.mockReturnValue({
      inventory: {
        data: [
          {
            id: "damaged",
            name: "Damaged",
            version: "1.0.0",
            sha256: "",
            active: false,
            theme: null,
            error: "immutable payload changed",
            error_code: "MANAGED_THEME_INVALID",
          },
        ],
        isLoading: false,
        isError: false,
      },
      catalog: {
        data: { verified: false, index: null, recommended_versions: {} },
        isLoading: false,
        isFetching: false,
      },
      refresh: { isPending: false },
      mutation: { isPending: false, mutate: mocks.mutate },
      recovery: { isPending: false },
    });
  });
  it("shows corruption and permits confirmed removal, but never applies or duplicates it", () => {
    render(<ThemeMarketplace />);
    expect(screen.getByText(/immutable payload changed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate theme" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Duplicate to author project" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove theme…" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal and built-in fallback" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { kind: "remove", id: "damaged", confirmFallback: true },
      expect.any(Object),
    );
  });
});
