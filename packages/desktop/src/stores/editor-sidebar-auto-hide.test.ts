import { beforeEach, describe, expect, it } from "vitest";

import { useEditorStore } from "./editor-store";

const FEATURE = 11;

beforeEach(() => {
  useEditorStore.setState({ features: {} });
  useEditorStore.getState().initFeature(FEATURE);
});

describe("hideSidebarBesideAgent", () => {
  it("hides the file tree and flags it as auto-hidden", () => {
    useEditorStore.getState().hideSidebarBesideAgent(FEATURE);
    expect(useEditorStore.getState().features[FEATURE]).toMatchObject({
      sidebarVisible: false,
      sidebarAutoHidden: true,
    });
  });

  it("hands control back on the user's next toggle", () => {
    useEditorStore.getState().hideSidebarBesideAgent(FEATURE);
    useEditorStore.getState().toggleSidebar(FEATURE);
    expect(useEditorStore.getState().features[FEATURE]).toMatchObject({
      sidebarVisible: true,
      sidebarAutoHidden: false,
    });
  });

  it("leaves an already hidden tree alone", () => {
    useEditorStore.getState().toggleSidebar(FEATURE);
    const before = useEditorStore.getState().features[FEATURE];
    useEditorStore.getState().hideSidebarBesideAgent(FEATURE);
    expect(useEditorStore.getState().features[FEATURE]).toBe(before);
  });
});
