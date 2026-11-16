import { afterEach, describe, expect, it } from "vitest";

import { shouldBypassAppClose } from "@/hooks/useAppClose";
import {
  setReplacedTabs,
  showBuiltinTab,
  useBuiltinTabFallbacks,
} from "@/lib/plugin-tabs/builtin-fallback";
import { useEditorStore } from "@/stores/editor-store";
import { useTerminalStore } from "@/hooks/useTerminalState";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import {
  ROOT_LEAF_ID,
  type FeatureLayoutState,
  type TabKind,
} from "@/stores/feature-layout-schema";

const FEATURE_ID = 42;

function layoutWithFocusedTab(tab: TabKind): FeatureLayoutState {
  return {
    version: 1,
    splitRoot: { type: "leaf", id: ROOT_LEAF_ID, tabIds: [tab], activeTabId: tab },
    focusedPaneId: ROOT_LEAF_ID,
    appliedLayoutId: null,
  };
}

function setLayout(tab: TabKind): void {
  useFeatureLayoutStore.setState({ features: { [FEATURE_ID]: layoutWithFocusedTab(tab) } });
}

function setEditorBuffers(hasBuffers: boolean): void {
  useEditorStore.setState({
    features: {
      [FEATURE_ID]: {
        splitTree: { type: "leaf", id: "p" },
        panes: {
          p: {
            tabs: hasBuffers
              ? [
                  {
                    filePath: "/tmp/a.ts",
                    fileName: "a.ts",
                    disambiguatedName: "a.ts",
                    isDirty: false,
                    cursorPosition: { line: 1, col: 1 },
                  },
                ]
              : [],
            activeFilePath: hasBuffers ? "/tmp/a.ts" : null,
          },
        },
        activePaneId: "p",
        sidebarVisible: false,
      },
    },
  });
}

function setTerminalPanes(hasPanes: boolean): void {
  useTerminalStore.setState({
    features: {
      [FEATURE_ID]: {
        isOpen: hasPanes,
        isMinimized: false,
        root: hasPanes ? { type: "leaf", id: "pane-1" } : null,
      },
    },
  });
}

afterEach(() => {
  useEditorStore.setState({ features: {} });
  useTerminalStore.setState({ features: {} });
  useFeatureLayoutStore.setState({ features: {} });
});

describe("shouldBypassAppClose", () => {
  it("returns false when featureId is null", () => {
    setLayout("editor");
    setEditorBuffers(true);
    expect(shouldBypassAppClose(null)).toBe(false);
  });

  it("bypasses (true) when editor is focused and has buffers", () => {
    setLayout("editor");
    setEditorBuffers(true);
    setTerminalPanes(false);
    expect(shouldBypassAppClose(FEATURE_ID)).toBe(true);
  });

  it("does NOT bypass (false) when editor is focused but empty — even if a terminal pane exists in the same feature (regression)", () => {
    setLayout("editor");
    setEditorBuffers(false);
    setTerminalPanes(true);
    expect(shouldBypassAppClose(FEATURE_ID)).toBe(false);
  });

  it("bypasses (true) when terminal is focused and has panes", () => {
    setLayout("terminal");
    setEditorBuffers(false);
    setTerminalPanes(true);
    expect(shouldBypassAppClose(FEATURE_ID)).toBe(true);
  });

  it("does NOT bypass (false) when terminal is focused but no panes — even if the editor has buffers", () => {
    setLayout("terminal");
    setEditorBuffers(true);
    setTerminalPanes(false);
    expect(shouldBypassAppClose(FEATURE_ID)).toBe(false);
  });

  it("does NOT bypass (false) when a non-owning tab (e.g. agent) is focused", () => {
    setLayout("agent");
    setEditorBuffers(true);
    setTerminalPanes(true);
    expect(shouldBypassAppClose(FEATURE_ID)).toBe(false);
  });

  it("does NOT bypass (false) when a custom tab holds the focused built-in's place", () => {
    setLayout("terminal");
    setTerminalPanes(true);
    setReplacedTabs(FEATURE_ID, { terminal: "sh" }, { terminal: "sh" });
    expect(shouldBypassAppClose(FEATURE_ID)).toBe(false);
    showBuiltinTab(FEATURE_ID, "terminal");
    expect(shouldBypassAppClose(FEATURE_ID)).toBe(true);
    useBuiltinTabFallbacks.setState({ replaced: {}, shown: {} });
  });

  it("does NOT bypass (false) when feature is not hydrated in the layout store", () => {
    setEditorBuffers(true);
    setTerminalPanes(true);
    // No layout entry for FEATURE_ID — getFocusedTabForFeature returns undefined.
    expect(shouldBypassAppClose(FEATURE_ID)).toBe(false);
  });
});
