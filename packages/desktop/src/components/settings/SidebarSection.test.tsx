import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@/test-utils";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { SIDEBAR_SETTING_KEYS } from "@/lib/sidebar-config";
import { SidebarSection } from "./SidebarSection";

const mocks = vi.hoisted(() => ({
  writes: [] as { key: string; value: string }[],
  batches: 0,
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setWorkspaceSetting: (key: string, data: { value: string }) => {
    mocks.writes.push({ key, value: data.value });
    return Promise.resolve({ value: data.value });
  },
  useSetWorkspaceSettingsBatch: () => ({
    mutate: () => {
      mocks.batches += 1;
    },
    isPending: false,
  }),
}));

function seededClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  for (const key of SIDEBAR_SETTING_KEYS) {
    client.setQueryData(getGetWorkspaceSettingQueryKey(key), {
      value: key === "sidebar_row_time" ? "absolute" : null,
    });
  }
  return client;
}

beforeEach(() => {
  mocks.writes = [];
  mocks.batches = 0;
});

describe("SidebarSection", () => {
  it("lays every option out as a described settings row", () => {
    render(<SidebarSection />, { queryClient: seededClient() });
    const time = screen.getByRole("radiogroup", { name: "Time" });
    expect(within(time).getByRole("radio", { name: "Absolute" })).toBeChecked();
    expect(screen.getByText(/Hovering a row swaps it for the row actions/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pull request" })).toBeChecked();
  });

  it("writes changes and resets from its own rows", async () => {
    const { user } = render(<SidebarSection />, { queryClient: seededClient() });
    await user.click(screen.getByRole("switch", { name: /Type to filter/ }));
    await waitFor(() =>
      expect(mocks.writes).toEqual([{ key: "sidebar_type_to_filter", value: "false" }]),
    );

    await user.click(screen.getByRole("button", { name: /Reset/ }));
    expect(mocks.batches).toBe(1);
  });
});
