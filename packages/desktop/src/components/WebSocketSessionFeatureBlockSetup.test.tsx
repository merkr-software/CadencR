import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceActivityProvider,
  createWorkspaceActivity,
  type WorkspaceActivityController,
} from "@/components/workspace-pool/workspace-activity";
import { defaultFeatureState } from "@/stores/editor-helpers";
import { useEditorStore } from "@/stores/editor-store";
import type { EditorTab } from "@/stores/editor-store-types";
import type { TabKind } from "@/stores/feature-layout-schema";
import { HIDDEN_SIDE_TABS_GRACE_MS } from "./useAgentFirstNonAgentWork";
import { useNonAgentTabReadiness } from "./WebSocketSessionFeatureBlockSetup";

const FEATURE_ID = 4;
/** The grace, then the idle period the close waits for (a timer in this DOM). */
const PAST_GRACE_MS = HIDDEN_SIDE_TABS_GRACE_MS + 6_000;

interface Props {
  focusedTabId: TabKind;
  requestedFocusTab: TabKind | undefined;
  requestedFocusPending: boolean;
}

function renderReadiness(activity: WorkspaceActivityController, initialProps: Props) {
  return renderHook(
    (props: Props) =>
      useNonAgentTabReadiness({
        embedded: false,
        featureId: FEATURE_ID,
        sessionId: "ws-feature-4",
        ...props,
      }),
    {
      initialProps,
      wrapper: ({ children }: { children: ReactNode }) => (
        <WorkspaceActivityProvider value={activity}>{children}</WorkspaceActivityProvider>
      ),
    },
  );
}

function frames(count: number): void {
  for (let frame = 0; frame < count; frame += 1) act(() => void vi.advanceTimersByTime(20));
}

function openEditorTab(tab: Partial<EditorTab>): void {
  const editorTab: EditorTab = {
    filePath: "/repo/a.ts",
    fileName: "a.ts",
    disambiguatedName: "a.ts",
    isDirty: false,
    cursorPosition: { line: 1, col: 1 },
    ...tab,
  };
  useEditorStore.setState({
    features: {
      [FEATURE_ID]: {
        ...defaultFeatureState,
        panes: { main: { tabs: [editorTab], activeFilePath: editorTab.filePath } },
      },
    },
  });
}

const ON_AGENT: Props = {
  focusedTabId: "agent",
  requestedFocusTab: undefined,
  requestedFocusPending: false,
};

describe("side tabs of a hidden workspace and its editor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    useEditorStore.setState({ features: {} });
  });

  /** Open the side tabs, hide the workspace, let the grace pass. */
  function hideOpenWorkspace(): ReturnType<typeof renderReadiness> {
    const activity = createWorkspaceActivity(true);
    const view = renderReadiness(activity, ON_AGENT);
    frames(10);
    expect(view.result.current.workEnabled).toBe(true);
    act(() => activity.set(false));
    act(() => void vi.advanceTimersByTime(PAST_GRACE_MS));
    return view;
  }

  it("close when the editor holds nothing unsaved", () => {
    openEditorTab({ isDirty: false });
    expect(hideOpenWorkspace().result.current.workEnabled).toBe(false);
  });

  it("stay open while a tab has unsaved edits, and close once it is saved", () => {
    openEditorTab({ isDirty: true });
    const view = hideOpenWorkspace();
    expect(view.result.current.workEnabled).toBe(true);

    openEditorTab({ isDirty: false });
    act(() => void vi.advanceTimersByTime(PAST_GRACE_MS));
    expect(view.result.current.workEnabled).toBe(false);
  });

  it("stay open while an untitled buffer is open", () => {
    openEditorTab({ filePath: "untitled://1234", fileName: "Untitled" });
    expect(hideOpenWorkspace().result.current.workEnabled).toBe(true);
  });
});

describe("a tab requested by the navigation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens the side tabs at once while the request is pending", () => {
    const { result } = renderReadiness(createWorkspaceActivity(true), {
      focusedTabId: "agent",
      requestedFocusTab: "terminal",
      requestedFocusPending: true,
    });
    expect(result.current.workEnabled).toBe(true);
    expect(result.current.tabReady.terminal).toBe(true);
  });

  it("no longer counts once applied: shown on its agent, the gate opens a paint later", () => {
    const activity = createWorkspaceActivity(false);
    const { result } = renderReadiness(activity, {
      focusedTabId: "agent",
      requestedFocusTab: "terminal",
      requestedFocusPending: false,
    });

    act(() => activity.set(true));
    expect(result.current.workEnabled).toBe(false);
    frames(1);
    expect(result.current.workEnabled).toBe(true);
  });
});
