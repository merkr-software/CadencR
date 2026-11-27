import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { FeatureTopBar } from "./FeatureTopBar";

const mocks = vi.hoisted(() => ({ isMobile: false, controllerMounts: 0, controllerRenders: 0 }));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mocks.isMobile }));
vi.mock("@/api/generated", () => ({
  useGetFeature: () => ({ data: { id: 1, title: "My Test Feature", label: "Review" } }),
  useAutoNameFeature: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useFeatureTitle", () => ({
  useFeatureTitle: () => ({ title: null, isAutoNaming: false }),
}));
vi.mock("@/hooks/useWorktreeSetup", () => ({ useWorktreeSetup: () => null }));
vi.mock("./useFeatureSettingsShortcuts", () => ({ useFeatureSettingsShortcuts: vi.fn() }));
vi.mock("@/components/SidebarContext", () => ({
  // A phone's drawer is closed while a conversation shows.
  useSidebarCollapsed: () => ({ collapsed: mocks.isMobile, setCollapsed: vi.fn() }),
}));
vi.mock("@/stores/session-status-selectors", () => ({
  useFeatureStatus: () => ({ status: "idle", kind: null }),
}));
vi.mock("@/components/ProjectBadge", () => ({ ProjectBadge: () => null }));
vi.mock("./FeatureSettingsPopover", () => ({
  FeatureSettingsPopover: () => <div data-testid="feature-settings" />,
}));
vi.mock("./custom-actions/CustomActionsLauncher", () => ({
  CustomActionsLauncher: () => <div data-testid="custom-actions-launcher" />,
}));
vi.mock("./branch-chip/BranchChip", () => ({
  BranchChip: () => <div data-testid="branch-chip" />,
}));

// The controller's state lives in React state, so a remount would lose it.
vi.mock("@/components/git-actions/useGitActionController", async () => {
  const { useEffect, useState } = await vi.importActual<typeof import("react")>("react");
  return {
    useGitActionController: () => {
      const [activeDialog, setActiveDialog] = useState<string | null>(null);
      mocks.controllerRenders += 1;
      useEffect(() => {
        mocks.controllerMounts += 1;
      }, []);
      return {
        state: {},
        activities: {},
        pickerOpen: false,
        setPickerOpen: vi.fn(),
        runAction: (action: string) => {
          setActiveDialog(action);
          return true;
        },
        dialogs: { activeDialog },
      };
    },
  };
});
vi.mock("@/components/git-actions/GitActionControls", () => ({
  GitActionControls: ({ onAction }: { onAction: (action: string) => void }) => (
    <button type="button" data-testid="git-action-button" onClick={() => onAction("commit")}>
      Commit
    </button>
  ),
}));
vi.mock("@/components/git-actions/GitActionDialogs", () => ({
  GitActionDialogs: ({ activeDialog }: { activeDialog: string | null }) =>
    activeDialog === "commit" ? <div role="dialog" aria-label="Commit changes" /> : null,
}));
vi.mock("@/components/phone-header/PhoneFeatureMoreSheet", () => ({
  PhoneFeatureMoreSheet: () => (
    <button type="button" aria-label="Conversation actions">
      …
    </button>
  ),
}));

describe("FeatureTopBar layouts", () => {
  beforeEach(() => {
    mocks.isMobile = false;
    mocks.controllerMounts = 0;
    mocks.controllerRenders = 0;
  });

  it("renders the desktop header's branch chip, custom actions and Git button", () => {
    render(<FeatureTopBar featureId={1} projectId={2} />);
    expect(screen.getByTestId("branch-chip")).toBeInTheDocument();
    expect(screen.getByTestId("custom-actions-launcher")).toBeInTheDocument();
    expect(screen.getByTestId("git-action-button")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conversation actions" })).toBeNull();
  });

  it("is one phone line: menu, title and …, with no branch chip or settings", () => {
    mocks.isMobile = true;
    const { container } = render(<FeatureTopBar featureId={1} projectId={2} />);
    expect(container.querySelector("[data-phone-feature-header]")).toHaveClass("h-11");
    expect(screen.getByRole("heading", { name: "My Test Feature" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversation actions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
    expect(screen.queryByTestId("branch-chip")).toBeNull();
    expect(screen.queryByTestId("feature-settings")).toBeNull();
    expect(screen.queryByTestId("git-action-button")).toBeNull();
  });

  it("keeps an open commit dialog and the Git controller across a layout flip", () => {
    const view = render(<FeatureTopBar featureId={1} projectId={2} />);
    fireEvent.click(screen.getByTestId("git-action-button"));
    expect(screen.getByRole("dialog", { name: "Commit changes" })).toBeInTheDocument();

    mocks.isMobile = true;
    view.rerender(<FeatureTopBar featureId={1} projectId={2} />);
    expect(screen.getByRole("button", { name: "Conversation actions" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Commit changes" })).toBeInTheDocument();

    mocks.isMobile = false;
    view.rerender(<FeatureTopBar featureId={1} projectId={2} />);
    expect(screen.getByTestId("git-action-button")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Commit changes" })).toBeInTheDocument();
    expect(mocks.controllerMounts).toBe(1);
  });

  it.each([false, true])(
    "keeps the Git controller out of header re-renders (phone: %s)",
    (phone) => {
      mocks.isMobile = phone;
      const view = render(<FeatureTopBar featureId={1} projectId={2} />);
      const renders = mocks.controllerRenders;
      // A stream delta re-renders the header chain with the same props.
      view.rerender(<FeatureTopBar featureId={1} projectId={2} />);
      view.rerender(<FeatureTopBar featureId={1} projectId={2} />);
      expect(mocks.controllerRenders).toBe(renders);
    },
  );
});
