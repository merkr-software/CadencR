import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { Feature } from "@/api/generated";
import { SidebarRowActionsProvider, useSidebarRowActions } from "./SidebarRowActionsProvider";

interface MutationOptions {
  mutation: { onSuccess: () => void; onError: (error: unknown) => void };
}

const mocks = vi.hoisted(() => ({
  pin: vi.fn(),
  status: vi.fn(),
  deleteFeature: vi.fn(),
  navigate: vi.fn(),
  invalidate: vi.fn(),
  pinOptions: null as MutationOptions | null,
  projectFeatures: [] as Feature[],
  activeFeatureId: null as number | null,
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useUpdateFeaturePinned: (options: MutationOptions) => {
    mocks.pinOptions = options;
    return { mutate: mocks.pin };
  },
  useUpdateFeatureStatus: () => ({ mutate: mocks.status }),
  useDeleteFeature: () => ({ mutate: mocks.deleteFeature }),
  useListFeatures: () => ({ data: mocks.projectFeatures }),
  useListFeatureWorktrees: () => ({ data: [] }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@/hooks/useRouteFeatureIds", () => ({
  useRouteFeatureIds: () => ({ projectId: null, featureId: mocks.activeFeatureId }),
}));
vi.mock("@/hooks/useArchiveFeatureAction", () => ({ useArchiveFeatureAction: () => vi.fn() }));
vi.mock("@/lib/queryClient", () => ({ invalidateByUrlPrefix: mocks.invalidate }));
vi.mock("@/components/useFeatureArchiveConfirmation", () => ({
  useFeatureArchiveConfirmation: (id: number | null) => ({
    action: id == null ? null : "archive",
    cleanup: {},
    feature: undefined,
  }),
}));
// The dialogs have their own suites: surface which conversation they confirm,
// and confirm a delete the way ConfirmDialog does (closing in the same click).
vi.mock("@/components/FeatureArchiveDialogs", () => ({
  FeatureArchiveDialogs: ({
    projectId,
    confirmFeatureId,
    onClose,
    onDelete,
  }: {
    projectId: number;
    confirmFeatureId: number | null;
    onClose: () => void;
    onDelete: (featureId: number) => void;
  }) =>
    confirmFeatureId == null ? null : (
      <button
        onClick={() => {
          onDelete(confirmFeatureId);
          onClose();
        }}
      >{`confirm ${confirmFeatureId} in ${projectId}`}</button>
    ),
}));

const feature = { id: 12, project_id: 3, status: "active" } as Feature;

function ActionButtons() {
  const actions = useSidebarRowActions();
  if (!actions) return <p>no actions</p>;
  return (
    <>
      <button onClick={() => actions.togglePin(12, false)}>unpin</button>
      <button onClick={() => actions.archiveOrDelete(feature)}>archive</button>
      <button onClick={() => actions.unarchive(12)}>unarchive</button>
    </>
  );
}

describe("SidebarRowActionsProvider", () => {
  beforeEach(() => {
    mocks.pin.mockClear();
    mocks.status.mockClear();
    mocks.deleteFeature.mockClear();
    mocks.navigate.mockClear();
    mocks.invalidate.mockClear();
    mocks.projectFeatures = [];
    mocks.activeFeatureId = null;
  });

  it("gives rows outside it no actions", () => {
    render(<ActionButtons />);
    expect(screen.getByText("no actions")).toBeInTheDocument();
  });

  it("writes the pin column and refreshes the feature lists once confirmed", async () => {
    const { user } = render(
      <SidebarRowActionsProvider>
        <ActionButtons />
      </SidebarRowActionsProvider>,
    );
    await user.click(screen.getByText("unpin"));
    expect(mocks.pin).toHaveBeenCalledWith({ id: 12, data: { pinned: false } });
    expect(mocks.invalidate).not.toHaveBeenCalled();
    mocks.pinOptions?.mutation.onSuccess();
    expect(mocks.invalidate).toHaveBeenCalledWith(expect.anything(), "/api/features");
  });

  it("confirms an archive in the conversation's own project", async () => {
    const { user } = render(
      <SidebarRowActionsProvider>
        <ActionButtons />
      </SidebarRowActionsProvider>,
    );
    expect(screen.queryByText(/confirm/)).not.toBeInTheDocument();
    await user.click(screen.getByText("archive"));
    expect(screen.getByText("confirm 12 in 3")).toBeInTheDocument();
  });

  it("unarchives through the status column", async () => {
    const { user } = render(
      <SidebarRowActionsProvider>
        <ActionButtons />
      </SidebarRowActionsProvider>,
    );
    await user.click(screen.getByText("unarchive"));
    expect(mocks.status).toHaveBeenCalledWith({ id: 12, data: { status: "active" } });
  });

  it("leaves a deleted open conversation for its neighbour once the dialog has closed", async () => {
    mocks.activeFeatureId = 12;
    mocks.projectFeatures = [11, 12, 13].map((id) => ({ ...feature, id }));
    const { user } = render(
      <SidebarRowActionsProvider>
        <ActionButtons />
      </SidebarRowActionsProvider>,
    );
    await user.click(screen.getByText("archive"));
    await user.click(screen.getByText("confirm 12 in 3"));
    expect(screen.queryByText(/confirm/)).not.toBeInTheDocument();
    const [variables, options] = mocks.deleteFeature.mock.calls[0] as [
      { id: number },
      { onSuccess: () => void },
    ];
    expect(variables).toEqual({ id: 12 });
    options.onSuccess();
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { projectId: "3", featureId: "13" } }),
    );
  });
});
