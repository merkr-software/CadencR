import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@/test-utils";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { DEFAULT_SIDEBAR_CONFIG, SIDEBAR_SETTING_KEYS } from "@/lib/sidebar-config";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useSidebarPreviewStore } from "@/stores/sidebar-preview-store";
import { SidebarConfigProvider } from "./SidebarConfigProvider";
import { SidebarDisplayOptionsForm } from "./SidebarDisplayOptions";

interface WriteCallbacks {
  onSuccess: () => void;
  onError: (error: unknown) => void;
}

const mocks = vi.hoisted(() => ({
  writes: [] as { key: string; value: string }[],
  confirm: [] as WriteCallbacks[],
  batches: [] as Record<string, string | null>[],
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setWorkspaceSetting: (key: string, data: { value: string }) =>
    new Promise((resolve, reject) => {
      mocks.writes.push({ key, value: data.value });
      mocks.confirm.push({ onSuccess: () => resolve({ value: data.value }), onError: reject });
    }),
  useSetWorkspaceSettingsBatch: () => ({
    mutate: ({ data }: { data: { values: Record<string, string | null> } }) =>
      mocks.batches.push(data.values),
    isPending: false,
  }),
}));

type User = ReturnType<typeof render>["user"];

/** Every group after Essentials starts folded. */
async function openGroup(user: User, name: string): Promise<void> {
  await user.click(screen.getByRole("button", { name }));
}

function clientWith(values: Record<string, string>): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  for (const key of SIDEBAR_SETTING_KEYS) {
    client.setQueryData(getGetWorkspaceSettingQueryKey(key), { value: values[key] ?? null });
  }
  return client;
}

beforeEach(() => {
  mocks.writes = [];
  mocks.confirm = [];
  mocks.batches = [];
  useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
});

describe("SidebarDisplayOptionsForm", () => {
  it("shows the stored values and applies a change once the write is confirmed", async () => {
    const { user } = render(<SidebarDisplayOptionsForm />, {
      queryClient: clientWith({ sidebar_density: "compact" }),
    });
    const density = screen.getByRole("radiogroup", { name: "Density" });
    expect(within(density).getByRole("radio", { name: "Compact" })).toBeChecked();

    await user.click(within(density).getByRole("radio", { name: "Spacious" }));
    await waitFor(() =>
      expect(mocks.writes).toEqual([{ key: "sidebar_density", value: "spacious" }]),
    );
    expect(within(density).getByRole("radio", { name: "Compact" })).toBeChecked();

    await act(async () => mocks.confirm[0]?.onSuccess());
    await waitFor(() =>
      expect(within(density).getByRole("radio", { name: "Spacious" })).toBeChecked(),
    );
  });

  it("keeps the stored value when the write fails", async () => {
    const { user } = render(<SidebarDisplayOptionsForm />, {
      queryClient: clientWith({ sidebar_density: "compact" }),
    });
    const density = screen.getByRole("radiogroup", { name: "Density" });
    await user.click(within(density).getByRole("radio", { name: "Spacious" }));
    await waitFor(() => expect(mocks.confirm).toHaveLength(1));
    await act(async () => mocks.confirm[0]?.onError(new Error("disk full")));
    expect(within(density).getByRole("radio", { name: "Compact" })).toBeChecked();
  });

  it("switches row elements off", async () => {
    const { user } = render(<SidebarDisplayOptionsForm />, { queryClient: clientWith({}) });
    await openGroup(user, "Rows");
    await user.click(screen.getByRole("checkbox", { name: "Diff stats" }));
    await waitFor(() =>
      expect(mocks.writes).toEqual([{ key: "sidebar_row_diff", value: "false" }]),
    );
  });

  it("resets every option, the legacy logo switch included, in one write", async () => {
    const { user } = render(<SidebarDisplayOptionsForm />, { queryClient: clientWith({}) });
    await user.click(screen.getByRole("button", { name: /Reset/ }));
    expect(mocks.batches).toHaveLength(1);
    expect(mocks.batches[0]).toMatchObject({ sidebar_density: null, sidebar_provider_logos: null });
  });

  it("shows the essentials and folds the other groups", async () => {
    const { user } = render(<SidebarDisplayOptionsForm />, { queryClient: clientWith({}) });
    expect(screen.getByRole("radiogroup", { name: "Density" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Gate popover" })).not.toBeInTheDocument();
    await openGroup(user, "Attention");
    expect(screen.getByRole("button", { name: "Attention" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("radiogroup", { name: "Gate popover" })).toBeInTheDocument();
  });

  it("names the option under the pointer, so the sidebar outlines what it changes", async () => {
    const { user } = render(<SidebarDisplayOptionsForm />, { queryClient: clientWith({}) });
    await user.hover(screen.getByRole("radio", { name: "Relative" }));
    expect(useSidebarPreviewStore.getState().highlight).toBe("time");
    // The gaps between rows keep the last option instead of flickering it off.
    fireEvent.pointerOver(screen.getByRole("group"));
    expect(useSidebarPreviewStore.getState().highlight).toBe("time");
    await user.unhover(screen.getByRole("group"));
    expect(useSidebarPreviewStore.getState().highlight).toBeNull();
  });

  it("holds the controls until the stored values arrive", () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    render(<SidebarDisplayOptionsForm />, { queryClient: client });
    expect(screen.getByRole("group")).toBeDisabled();
    expect(screen.getByLabelText("Loading options")).toBeInTheDocument();
  });
});

describe("SidebarConfigProvider", () => {
  it("mirrors the stored options into the store the rows read", async () => {
    render(
      <SidebarConfigProvider>
        <span />
      </SidebarConfigProvider>,
      {
        queryClient: clientWith({ sidebar_row_time: "absolute", sidebar_provider_logos: "false" }),
      },
    );
    await waitFor(() => expect(useSidebarConfigStore.getState().config.time).toBe("absolute"));
    expect(useSidebarConfigStore.getState().config.provider).toBe("hidden");
  });
});

describe("SidebarDisplayOptionsForm tooltips", () => {
  it.each([
    [
      "an option",
      "Blocks",
      () => screen.getByText("Block counters"),
      "What the For me, In progress and Pinned headers show next to their name.",
    ],
    [
      "a value",
      "Attention",
      () => screen.getByRole("radio", { name: "Click" }),
      "Opens only when you click the pending icon",
    ],
    [
      "a row element",
      "Rows",
      () => screen.getByText("Ports"),
      "Ports the conversation's processes listen on, under the title. Click one to open it.",
    ],
  ])("explains %s on hover", async (_, group, target, hint) => {
    const { user } = render(<SidebarDisplayOptionsForm />, { queryClient: clientWith({}) });
    await openGroup(user, group);
    await user.hover(target());
    expect(await screen.findByRole("tooltip")).toHaveTextContent(hint);
  });
});
