import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@/test-utils";
import { FeatureLayoutProvider } from "@/components/feature-layout/FeatureLayoutContext";
import { useGlobalShortcutById, useScopedShortcut, useShortcut } from "@/hooks/useShortcut";
import { runShortcutAction, useShortcutActionStore } from "@/lib/command-palette/shortcut-actions";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { ROOT_LEAF_ID, type TabKind } from "@/stores/feature-layout-schema";

const FEATURE_ID = 42;

function focusTab(activeTabId: TabKind): void {
  useFeatureLayoutStore.setState((state) => ({
    ...state,
    features: {
      ...state.features,
      [FEATURE_ID]: {
        version: 1,
        splitRoot: { type: "leaf", id: ROOT_LEAF_ID, tabIds: ["agent", "git"], activeTabId },
        focusedPaneId: ROOT_LEAF_ID,
        appliedLayoutId: null,
      },
    },
  }));
}

function FindInConversation({ onFind }: { onFind: () => void }) {
  useScopedShortcut("conversation-search", onFind, "agent");
  return null;
}

function Commit({
  onCommit,
  enabled = true,
}: {
  onCommit: (event: KeyboardEvent) => void;
  enabled?: boolean;
}) {
  useShortcut("git-commit", onCommit, { enabled });
  return null;
}

function Agents({ onOpen }: { onOpen: () => void }) {
  useGlobalShortcutById("open-unified-agents", onOpen);
  return null;
}

describe("shortcut handlers offered to the palette", () => {
  afterEach(() => useShortcutActionStore.setState({ byId: {} }));

  it("registers a listed shortcut while mounted and runs its handler with a real event", () => {
    const onCommit = vi.fn();
    const { unmount } = render(<Commit onCommit={onCommit} />);
    expect(runShortcutAction("git-commit")).toBe(true);
    expect(onCommit).toHaveBeenCalledWith(expect.any(KeyboardEvent), expect.anything());
    expect(onCommit.mock.calls[0]?.[0].target).toBe(document.body);
    unmount();
    expect(runShortcutAction("git-commit")).toBe(false);
  });

  it("stays out while disabled", () => {
    render(<Commit onCommit={vi.fn()} enabled={false} />);
    expect(runShortcutAction("git-commit")).toBe(false);
  });

  it("ignores shortcuts the palette does not list", () => {
    render(<Agents onOpen={vi.fn()} />);
    expect(useShortcutActionStore.getState().byId["open-unified-agents"]).toBeUndefined();
  });

  it("offers a tab's shortcut only while that tab has focus", () => {
    focusTab("git");
    const onFind = vi.fn();
    render(
      <FeatureLayoutProvider featureId={FEATURE_ID}>
        <FindInConversation onFind={onFind} />
      </FeatureLayoutProvider>,
    );
    expect(runShortcutAction("conversation-search")).toBe(false);
    act(() => focusTab("agent"));
    expect(runShortcutAction("conversation-search")).toBe(true);
    expect(onFind).toHaveBeenCalledTimes(1);
  });

  it("runs the newest of several hosts", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <>
        <Commit onCommit={first} />
        <Commit onCommit={second} />
      </>,
    );
    runShortcutAction("git-commit");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
