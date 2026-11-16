import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@/test-utils";
import type { PluginTabSummary } from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import {
  pendingUpdateFixture,
  serviceError,
  stagedUpdateTab,
  tabFixture,
} from "./custom-tabs-fixtures";
import { CustomTabsSection } from "./CustomTabsSection";

const mocks = vi.hoisted(() => ({
  tabs: [] as PluginTabSummary[],
  fresh: null as PluginTabSummary | null,
  listCalls: 0,
  consent: vi.fn(),
  discard: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(vi.fn(), actual.toast, { error: mocks.toastError }) };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(() => Promise.resolve()),
  useSearch: ({ select }: { select: (search: Record<string, unknown>) => unknown }) => select({}),
}));

vi.mock("@/api/generated", async (importOriginal) => {
  const { useMutation, useQuery } = await import("@tanstack/react-query");
  return {
    ...(await importOriginal<typeof import("@/api/generated")>()),
    usePluginTabList: () =>
      useQuery({
        queryKey: ["/api/plugin-tabs"],
        queryFn: () => {
          mocks.listCalls += 1;
          return mocks.tabs;
        },
      }),
    getPluginTabListQueryOptions: (params: { project_id: number }) => ({
      queryKey: ["/api/plugin-tabs", params],
      queryFn: () => [],
    }),
    getPluginTabGetQueryOptions: (id: string) => ({
      queryKey: [`/api/plugin-tabs/${id}`],
      queryFn: () => mocks.fresh,
    }),
    useListProjects: () => useQuery({ queryKey: ["/api/projects"], queryFn: () => [] }),
    usePluginTabSetEnablement: () => useMutation({ mutationFn: vi.fn() }),
    usePluginTabConsent: () => useMutation({ mutationFn: mocks.consent }),
    useDiscardManagedTabUpdate: () => useMutation({ mutationFn: mocks.discard }),
    usePluginTabWorkspace: () => useMutation({ mutationFn: vi.fn() }),
    usePluginTabAuthoring: () => useMutation({ mutationFn: vi.fn() }),
  };
});

/** The app's own client: custom tab refreshes invalidate it (`refreshPluginTabReads`). */
function renderSection() {
  return render(<CustomTabsSection />, { queryClient });
}

async function openReview() {
  const view = renderSection();
  await screen.findByRole("button", { name: /Changed files graph/, expanded: true });
  const notice = screen.getByText(/keeps running until you allow it/).closest("[role=status]");
  if (!(notice instanceof HTMLElement)) throw new Error("no update notice");
  await view.user.click(within(notice).getByRole("button", { name: "Review permissions" }));
  return { ...view, dialog: await screen.findByRole("dialog") };
}

describe("a staged marketplace update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    mocks.tabs = [stagedUpdateTab()];
    mocks.fresh = null;
    mocks.listCalls = 0;
    mocks.consent.mockResolvedValue({});
    mocks.discard.mockResolvedValue(true);
  });

  it("names the waiting update on the collapsed card", async () => {
    const { user } = renderSection();
    const card = await screen.findByRole("button", { name: /Changed files graph/, expanded: true });
    expect(within(card).queryByText(/ready — review permissions/)).toBeNull();
    await user.click(card);
    expect(within(card).getByText(/ready — review permissions/)).toHaveTextContent(
      "Update 0.2.0 ready — review permissions",
    );
  });

  it("offers only discarding an update Cadencr blocks, and says why", async () => {
    mocks.tabs = [
      stagedUpdateTab({
        pending_update: pendingUpdateFixture({ blocked_reason: "Uploads repository contents." }),
      }),
    ];
    const { user } = renderSection();
    const notice = (
      await screen.findByText(/is blocked by Cadencr: Uploads repository contents\.$/)
    ).closest("[role=status]");
    if (!(notice instanceof HTMLElement)) throw new Error("no update notice");
    expect(within(notice).queryByRole("button", { name: "Review permissions" })).toBeNull();
    await user.click(within(notice).getByRole("button", { name: "Keep current version" }));
    await waitFor(() => expect(mocks.discard).toHaveBeenCalled());
  });

  it("reviews what the update would run and accepts it at the update's hash", async () => {
    const { user, dialog } = await openReview();
    expect(within(dialog).getByText("Update “Changed files graph” to 0.2.0?")).toBeInTheDocument();
    expect(within(dialog).getByText("workspace:read")).toBeInTheDocument();
    expect(within(dialog).getByText("Native code")).toBeInTheDocument();
    expect(within(dialog).getByText(/keeps running/)).toHaveTextContent("0.1.0");
    const allow = within(dialog).getByRole("button", { name: "Allow and update" });
    expect(allow).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /I trust this code/ }));
    const before = mocks.listCalls;
    await user.click(allow);
    await waitFor(() =>
      expect(mocks.consent.mock.calls[0]?.[0]).toEqual({
        id: "graph",
        data: { permissions_hash: "hash-update", trusts_code: true },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(mocks.listCalls).toBeGreaterThan(before));
  });

  it("reloads the update when it changed during the review", async () => {
    mocks.consent.mockRejectedValueOnce(
      serviceError(409, "MANAGED_TAB_UPDATE_CHANGED", "another update was staged"),
    );
    mocks.fresh = stagedUpdateTab({
      pending_update: pendingUpdateFixture({
        version: "0.3.0",
        permissions_hash: "hash-newer",
        access_level: "ui",
        backend: null,
      }),
    });
    const { user, dialog } = await openReview();
    await user.click(within(dialog).getByRole("checkbox", { name: /I trust this code/ }));
    await user.click(within(dialog).getByRole("button", { name: "Allow and update" }));
    const fresh = await screen.findByRole("dialog");
    expect(await within(fresh).findByText(/A different update was staged/)).toBeInTheDocument();
    expect(within(fresh).getByText("Update “Changed files graph” to 0.3.0?")).toBeInTheDocument();
    await user.click(within(fresh).getByRole("button", { name: "Allow and update" }));
    await waitFor(() =>
      expect(mocks.consent.mock.calls[1]?.[0]).toMatchObject({
        data: { permissions_hash: "hash-newer", trusts_code: false },
      }),
    );
  });

  it("closes the review when the update is gone", async () => {
    mocks.consent.mockRejectedValueOnce(serviceError(409, "MANAGED_TAB_UPDATE_CHANGED", "gone"));
    mocks.fresh = tabFixture({ managed: true, pending_update: null });
    const { user, dialog } = await openReview();
    await user.click(within(dialog).getByRole("checkbox", { name: /I trust this code/ }));
    await user.click(within(dialog).getByRole("button", { name: "Allow and update" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.consent).toHaveBeenCalledTimes(1);
  });

  it("closes the review with an explanation when the update is blocked", async () => {
    mocks.consent.mockRejectedValueOnce(
      serviceError(403, "PLUGIN_TAB_BLOCKED", "graph 0.2.0 is on the revocation list"),
    );
    const { user, dialog } = await openReview();
    await user.click(within(dialog).getByRole("checkbox", { name: /I trust this code/ }));
    await user.click(within(dialog).getByRole("button", { name: "Allow and update" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.toastError).toHaveBeenCalledWith("“Changed files graph” is blocked by Cadencr", {
      description: "graph 0.2.0 is on the revocation list",
    });
    expect(mocks.consent).toHaveBeenCalledTimes(1);
  });

  it("keeps the current version by discarding the update, then refetches", async () => {
    const { user } = renderSection();
    await screen.findByRole("button", { name: /Changed files graph/, expanded: true });
    const before = mocks.listCalls;
    mocks.tabs = [tabFixture({ managed: true })];
    await user.click(screen.getByRole("button", { name: "Keep current version" }));
    await waitFor(() => expect(mocks.discard.mock.calls[0]?.[0]).toEqual({ id: "graph" }));
    await waitFor(() => expect(mocks.listCalls).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Keep current version" })).toBeNull(),
    );
    expect(mocks.consent).not.toHaveBeenCalled();
  });
});
