import type { ReactElement } from "react";
import { BotIcon, CodeIcon, GitCompareArrowsIcon, GlobeIcon, TerminalIcon } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

import {
  ROOT_LEAF_ID,
  flatLayoutState,
  type FeatureLayoutState,
} from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";

import { FeatureLayoutShell } from "./FeatureLayoutShell";
import type { FeatureTabs } from "./types";

const seenLayoutStates: Array<FeatureLayoutState | undefined> = [];

vi.mock("./TabContentRegistry", () => ({
  TabContentRegistry: ({ layoutState }: { layoutState?: FeatureLayoutState }): null => {
    seenLayoutStates.push(layoutState);
    return null;
  },
}));
vi.mock("./SplitTreeRenderer", () => ({ SplitTreeRenderer: (): null => null }));
vi.mock("@/hooks/useFeatureLayoutHydration", () => ({ useFeatureLayoutHydration: (): void => {} }));
vi.mock("@/hooks/useFeatureLayoutPersistence", () => ({
  useFeatureLayoutPersistence: (): void => {},
}));
vi.mock("@/hooks/useFeatureLayoutHotkeys", () => ({ useFeatureLayoutHotkeys: (): void => {} }));
vi.mock("@/lib/auto-layout/useAutoLayoutTarget", () => ({ useAutoLayoutTarget: (): void => {} }));

const FEATURE_ID = 11;

const tabs: FeatureTabs = {
  agent: { label: "Agent", Icon: BotIcon, content: null },
  terminal: { label: "Terminal", Icon: TerminalIcon, content: null },
  git: { label: "Git", Icon: GitCompareArrowsIcon, content: null },
  editor: { label: "Editor", Icon: CodeIcon, content: null },
  browser: { label: "Browser", Icon: GlobeIcon, content: null },
};

describe("FeatureLayoutShell", () => {
  beforeEach(() => {
    seenLayoutStates.length = 0;
    useFeatureLayoutStore.setState({ features: { [FEATURE_ID]: flatLayoutState() } });
  });

  // Regression guard for the mobile "Maximum update depth exceeded" (#185)
  // crash: with splits off we substitute a flat layout, and an unmemoized
  // substitution handed `TabContentRegistry` a new object every render, which
  // re-armed its `setVisitedTabs` effect and left a Default-lane update pending
  // at the tail of nearly every commit. Nothing about this invariant is
  // type-checked, so it needs a test.
  it("keeps the substituted flat layout referentially stable across re-renders", () => {
    // A fresh element each time, so React actually re-renders the shell —
    // re-passing the identical element lets it bail out and proves nothing.
    const shell = (): ReactElement => (
      <FeatureLayoutShell featureId={FEATURE_ID} tabs={tabs} splitsEnabled={false} />
    );
    const view = render(shell());
    view.rerender(shell());
    view.rerender(shell());

    expect(seenLayoutStates.length).toBeGreaterThanOrEqual(3);
    const [first, ...rest] = seenLayoutStates;
    expect(first).toBeDefined();
    for (const seen of rest) expect(seen).toBe(first);
  });

  it("passes the stored layout straight through when splits are enabled", () => {
    const shell = (): ReactElement => <FeatureLayoutShell featureId={FEATURE_ID} tabs={tabs} />;
    const view = render(shell());
    view.rerender(shell());

    const stored = useFeatureLayoutStore.getState().features[FEATURE_ID];
    expect(seenLayoutStates.length).toBeGreaterThanOrEqual(2);
    for (const seen of seenLayoutStates) expect(seen).toBe(stored);
  });

  it("re-derives the flat layout when the focused tab changes", () => {
    render(<FeatureLayoutShell featureId={FEATURE_ID} tabs={tabs} splitsEnabled={false} />);
    const before = seenLayoutStates.at(-1);

    act(() => {
      useFeatureLayoutStore.getState().setPaneActiveTab(FEATURE_ID, ROOT_LEAF_ID, "terminal");
    });

    const after = seenLayoutStates.at(-1);
    expect(after).not.toBe(before);
    expect(after?.splitRoot).toMatchObject({ type: "leaf", activeTabId: "terminal" });
  });
});
