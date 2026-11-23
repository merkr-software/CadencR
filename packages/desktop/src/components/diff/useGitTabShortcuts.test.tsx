import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { FeatureLayoutProvider } from "@/components/feature-layout/FeatureLayoutContext";
import { ROOT_LEAF_ID } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { useGitTabShortcuts, type GitTabShortcutTargets } from "./useGitTabShortcuts";

const FEATURE_ID = 923;

const callbacks = {
  toggleFileList: vi.fn(),
  sendDrafts: vi.fn(),
  sendReviewThreads: vi.fn(),
  previousReview: vi.fn(),
  nextReview: vi.fn(),
};

function Harness(overrides: Partial<GitTabShortcutTargets>) {
  useGitTabShortcuts({
    enabled: true,
    isFileListCollapseLoading: false,
    isListView: false,
    isPr: false,
    canSendReviewThreads: true,
    canNavigateReviews: true,
    ...callbacks,
    ...overrides,
  });
  return <div />;
}

function seedGitLayout(): void {
  useFeatureLayoutStore.setState((state) => ({
    ...state,
    features: {
      ...state.features,
      [FEATURE_ID]: {
        version: 1,
        splitRoot: {
          type: "leaf",
          id: ROOT_LEAF_ID,
          tabIds: ["git"],
          activeTabId: "git",
        },
        focusedPaneId: ROOT_LEAF_ID,
        appliedLayoutId: null,
      },
    },
  }));
}

function dispatchMod(key: string, code: string, extras: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...extras,
  });
  window.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  seedGitLayout();
  vi.clearAllMocks();
});

afterEach(() => {
  useFeatureLayoutStore.setState((state) => {
    const features = { ...state.features };
    delete features[FEATURE_ID];
    return { ...state, features };
  });
});

describe("useGitTabShortcuts", () => {
  it("keeps Mod+Enter contextual and gives selected review threads an explicit Shift chord", () => {
    const { rerender } = render(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <Harness />
      </FeatureLayoutProvider>,
    );

    dispatchMod("Enter", "Enter");
    expect(callbacks.sendDrafts).toHaveBeenCalledOnce();
    expect(callbacks.sendReviewThreads).not.toHaveBeenCalled();

    dispatchMod("Enter", "Enter", { shiftKey: true });
    expect(callbacks.sendReviewThreads).toHaveBeenCalledOnce();

    rerender(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <Harness isPr />
      </FeatureLayoutProvider>,
    );
    dispatchMod("Enter", "Enter");
    expect(callbacks.sendReviewThreads).toHaveBeenCalledTimes(2);
  });

  it("navigates previous and next feedback by produced key on non-QWERTY layouts", () => {
    render(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <Harness />
      </FeatureLayoutProvider>,
    );

    dispatchMod("j", "KeyY", { shiftKey: true });
    dispatchMod("k", "KeyX", { shiftKey: true });

    expect(callbacks.nextReview).toHaveBeenCalledOnce();
    expect(callbacks.previousReview).toHaveBeenCalledOnce();
  });

  it("does not fire disabled navigation or repeat-trigger sends", () => {
    render(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <Harness canNavigateReviews={false} canSendReviewThreads={false} />
      </FeatureLayoutProvider>,
    );

    dispatchMod("j", "KeyJ", { shiftKey: true });
    dispatchMod("Enter", "Enter", { repeat: true });
    dispatchMod("Enter", "Enter", { shiftKey: true });

    expect(callbacks.nextReview).not.toHaveBeenCalled();
    expect(callbacks.sendDrafts).not.toHaveBeenCalled();
    expect(callbacks.sendReviewThreads).not.toHaveBeenCalled();
  });

  it("stops toggling the file list in the views that have none", () => {
    const { rerender } = render(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <Harness />
      </FeatureLayoutProvider>,
    );

    dispatchMod("e", "KeyE");
    expect(callbacks.toggleFileList).toHaveBeenCalledOnce();

    rerender(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <Harness isListView />
      </FeatureLayoutProvider>,
    );
    dispatchMod("e", "KeyE");
    expect(callbacks.toggleFileList).toHaveBeenCalledOnce();
  });

  it("lets an open dialog own Mod+Enter instead of swallowing it in the Git tab", () => {
    render(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <Harness />
        <div data-slot="dialog-content" data-state="open" role="dialog">
          <button type="button">Confirm dialog</button>
        </div>
      </FeatureLayoutProvider>,
    );
    const confirmButton = screen.getByRole("button", { name: "Confirm dialog" });
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(confirmButton.dispatchEvent(event)).toBe(true);

    expect(event.defaultPrevented).toBe(false);
    expect(callbacks.sendDrafts).not.toHaveBeenCalled();
    expect(callbacks.sendReviewThreads).not.toHaveBeenCalled();
  });

  it("is not blocked by a panel left open in a hidden workspace", () => {
    render(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <Harness />
        {/* A conversation kept mounted but hidden: its go-to-line panel is still open. */}
        <div inert>
          <div role="dialog">Go to line</div>
        </div>
      </FeatureLayoutProvider>,
    );

    dispatchMod("e", "KeyE");

    expect(callbacks.toggleFileList).toHaveBeenCalledOnce();
  });

  it("is still blocked by the same panel open in the workspace on screen", () => {
    render(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <Harness />
        <div role="dialog">Go to line</div>
      </FeatureLayoutProvider>,
    );

    dispatchMod("e", "KeyE");

    expect(callbacks.toggleFileList).not.toHaveBeenCalled();
  });
});
