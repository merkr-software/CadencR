// @vitest-environment happy-dom
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useEditorStore } from "@/stores/editor-store";
import { installDiagnosticStoreObservers } from "./renderer-diagnostic-observers";
import * as diagnostics from "./renderer-diagnostics";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("coalesces editor bursts, flushes the latest state on a crash and cancels pending work on cleanup", () => {
  vi.useFakeTimers();
  useEditorStore.setState({ features: {} });
  const record = vi.spyOn(diagnostics, "recordDiagnosticEvent");
  const stop = installDiagnosticStoreObservers();
  onTestFinished(stop);
  const editorEvents = () => record.mock.calls.filter(([kind]) => kind === "editor");
  const store = useEditorStore.getState();
  for (let i = 1; i <= 20; i++) store.initFeature(i);
  expect(editorEvents()).toHaveLength(1);
  vi.advanceTimersByTime(100);
  expect(editorEvents()).toHaveLength(2);
  expect(editorEvents().at(-1)?.[1]).toMatchObject({ features: 20 });
  const pane = useEditorStore.getState().features[1].activePaneId;
  store.openUntitledBuffer(1, pane);
  diagnostics.captureDiagnosticContext();
  expect(editorEvents().at(-1)?.[1]).toMatchObject({ tabs: 1, untitled: 1 });
  expect(editorEvents()).toHaveLength(3);
  store.initFeature(21);
  stop();
  vi.runAllTimers();
  diagnostics.captureDiagnosticContext();
  expect(editorEvents()).toHaveLength(3);
});
