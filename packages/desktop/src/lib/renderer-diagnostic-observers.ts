import { useEditorStore } from "@/stores/editor-store";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useConnectionStatusStore } from "@/stores/connection-status-store";
import { onDiagnosticCapture, recordDiagnosticEvent } from "./renderer-diagnostics";
import { isUntitledPath, type EditorStore } from "@/stores/editor-store-types";

function editorSummary(state: EditorStore) {
  const features = Object.values(state.features);
  const panes = features.slice(0, 100).flatMap((feature) => Object.values(feature.panes));
  return {
    features: features.length,
    panes: panes.length,
    tabs: panes.reduce((sum, pane) => sum + pane.tabs.length, 0),
    untitled: panes.reduce(
      (sum, pane) => sum + pane.tabs.filter((tab) => isUntitledPath(tab.filePath)).length,
      0,
    ),
    activeTabs: panes
      .slice(0, 20)
      .map((pane) => pane.tabs.findIndex((tab) => tab.filePath === pane.activeFilePath))
      .join(","),
  };
}

export function installDiagnosticStoreObservers(): () => void {
  let lastEditor = "";
  const editor = () => {
    const summary = editorSummary(useEditorStore.getState());
    const key = JSON.stringify(summary);
    if (key === lastEditor) return;
    lastEditor = key;
    recordDiagnosticEvent("editor", summary);
  };
  const agents = () => {
    const state = useSessionStatusStore.getState();
    const statuses = Object.values(state.bySession);
    recordDiagnosticEvent("agents", {
      connected: state.isConnected,
      total: statuses.length,
      working: statuses.filter((entry) => entry.status === "agent").length,
      waiting: statuses.filter((entry) => entry.status === "question").length,
    });
  };
  let editorTimer: ReturnType<typeof setTimeout> | undefined;
  const flushEditor = () => {
    if (editorTimer === undefined) return;
    clearTimeout(editorTimer);
    editorTimer = undefined;
    editor();
  };
  const unsubscribe = [
    onDiagnosticCapture(flushEditor),
    useEditorStore.subscribe((state, previous) => {
      if (state.features !== previous.features && editorTimer === undefined)
        editorTimer = setTimeout(flushEditor, 100);
    }),
    useSessionStatusStore.subscribe((state, previous) => {
      if (state.bySession !== previous.bySession || state.isConnected !== previous.isConnected)
        agents();
    }),
    useConnectionStatusStore.subscribe((state, previous) => {
      if (state.status !== previous.status)
        recordDiagnosticEvent("connection", { status: state.status });
    }),
  ];
  editor();
  agents();
  return () => {
    clearTimeout(editorTimer);
    unsubscribe.forEach((stop) => stop());
  };
}
