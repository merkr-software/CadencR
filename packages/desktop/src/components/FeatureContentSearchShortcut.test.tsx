import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import {
  FeatureContentSearchShortcut,
  preloadContentSearch,
} from "@/components/FeatureContentSearchShortcut";
import { ROOT_LEAF_ID } from "@/stores/feature-layout-schema";
import {
  getFocusedTab,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";

vi.mock("@/components/editor/ContentSearchDialog", () => ({
  default: ({
    open,
    onOpenChange,
    onResultOpen,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onResultOpen?: () => void;
  }) =>
    open ? (
      <div role="dialog" aria-label="Content search">
        <button
          type="button"
          onClick={() => {
            onResultOpen?.();
            onOpenChange(false);
          }}
        >
          Open result
        </button>
      </div>
    ) : null,
}));

function fireContentSearchShortcut(): void {
  fireEvent.keyDown(window, { key: "F", code: "KeyF", metaKey: true, shiftKey: true });
}

describe("FeatureContentSearchShortcut", () => {
  // As a mouse-driven window does once idle: the dialog’s chunk is loaded first.
  beforeAll(async () => {
    await preloadContentSearch();
  });

  beforeEach((): void => {
    useFeatureLayoutStore.getState().resetToFlat(42);
    useFeatureLayoutStore.getState().setPaneActiveTab(42, ROOT_LEAF_ID, "agent");
  });

  it("opens content search from any feature tab", () => {
    render(<FeatureContentSearchShortcut featureId={42} projectId={7} />);

    fireContentSearchShortcut();

    expect(screen.getByRole("dialog", { name: "Content search" })).toBeInTheDocument();
  });

  it("stops duplicate global Cmd+Shift+F handlers after opening search", () => {
    const downstream = vi.fn();
    render(<FeatureContentSearchShortcut featureId={42} projectId={7} />);
    window.addEventListener("keydown", downstream, true);

    fireContentSearchShortcut();

    expect(downstream).not.toHaveBeenCalled();
    window.removeEventListener("keydown", downstream, true);
  });

  it("activates the editor tab when a content-search result opens", async () => {
    const { user } = render(<FeatureContentSearchShortcut featureId={42} projectId={7} />);
    fireContentSearchShortcut();

    await user.click(screen.getByRole("button", { name: "Open result" }));

    const layout = selectFeatureLayout(42)(useFeatureLayoutStore.getState());
    expect(getFocusedTab(layout)).toBe("editor");
  });
});
