import {
  DEFAULT_ARTIFACT_TYPE,
  DEFAULT_MAX_TABS,
  UNTITLED_PATH_PREFIX,
  type EditorGet,
  type EditorPaneState,
  type EditorSet,
  type EditorStore,
  type EditorTab,
} from "./editor-store-types";
import {
  DEFAULT_PANE_ID,
  defaultFeatureState,
  defaultPaneState,
  disambiguateTabNames,
  getFileName,
  updateFeature,
  updatePane,
} from "./editor-helpers";

type EditorTabActions = Pick<
  EditorStore,
  | "initFeature"
  | "openFile"
  | "closeTab"
  | "openUntitledBuffer"
  | "convertUntitledToFile"
  | "setActiveFile"
  | "renameFilePath"
  | "setDirty"
  | "setCursorPosition"
  | "openArtifact"
  | "openPhaseArtifacts"
  | "clearPendingGoToLine"
>;

function createBasicTabActions(
  set: EditorSet,
  get: EditorGet,
): Pick<EditorTabActions, "initFeature" | "openFile" | "closeTab"> {
  return {
    initFeature: (featureId) => {
      if (get().features[featureId]) return;
      set((state) =>
        updateFeature(state, featureId, {
          ...defaultFeatureState,
          splitTree: { type: "leaf", id: DEFAULT_PANE_ID },
          panes: { [DEFAULT_PANE_ID]: { ...defaultPaneState } },
        }),
      );
    },

    openFile: (featureId, paneId, filePath, maxTabs = DEFAULT_MAX_TABS, goToLine?, goToColumn?) =>
      set((state) => {
        const feature = state.features[featureId] ?? { ...defaultFeatureState };
        const next = updatePane(feature, paneId, (pane) => {
          if (pane.tabs.some((t) => t.filePath === filePath)) {
            // File already open — update pendingGoToLine if specified
            const tabs = goToLine
              ? pane.tabs.map((t) =>
                  t.filePath === filePath
                    ? { ...t, pendingGoToLine: goToLine, pendingGoToColumn: goToColumn }
                    : t,
                )
              : pane.tabs;
            return { ...pane, tabs, activeFilePath: filePath };
          }

          const fileName = getFileName(filePath);
          const newTab: EditorTab = {
            filePath,
            fileName,
            disambiguatedName: fileName,
            isDirty: false,
            cursorPosition: { line: goToLine ?? 1, col: goToColumn ?? 1 },
            pendingGoToLine: goToLine,
            pendingGoToColumn: goToColumn,
          };

          let tabs = [...pane.tabs, newTab];

          if (maxTabs > 0 && tabs.length > maxTabs) {
            const oldestNonDirtyIdx = tabs.findIndex((t) => !t.isDirty);
            if (oldestNonDirtyIdx !== -1) {
              tabs = tabs.filter((_, i) => i !== oldestNonDirtyIdx);
            }
          }

          return { tabs: disambiguateTabNames(tabs), activeFilePath: filePath };
        });
        return updateFeature(state, featureId, next);
      }),

    closeTab: (featureId, paneId, filePath) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        const next = updatePane(feature, paneId, (pane) => {
          const idx = pane.tabs.findIndex((t) => t.filePath === filePath);
          if (idx === -1) return pane;
          const tabs = disambiguateTabNames(pane.tabs.filter((t) => t.filePath !== filePath));
          let activeFilePath = pane.activeFilePath;
          if (activeFilePath === filePath) {
            activeFilePath = tabs[Math.max(0, idx - 1)]?.filePath ?? tabs[0]?.filePath ?? null;
          }
          return { tabs, activeFilePath };
        });
        return updateFeature(state, featureId, next);
      }),
  };
}

function createUntitledTabActions(
  set: EditorSet,
): Pick<EditorTabActions, "openUntitledBuffer" | "convertUntitledToFile"> {
  return {
    openUntitledBuffer: (featureId, paneId, maxTabs = DEFAULT_MAX_TABS) => {
      const newPath = `${UNTITLED_PATH_PREFIX}${crypto.randomUUID()}`;
      set((state) => {
        const feature = state.features[featureId] ?? { ...defaultFeatureState };
        const next = updatePane(feature, paneId, (pane) => {
          // Pick the next `Untitled-N` label by scanning the existing
          // untitled tabs in this pane. The numbering is per-pane, not
          // per-feature — keeps the implementation simple and matches
          // VS Code's behavior (Untitled-1 in pane A and pane B can
          // coexist; users see them in separate columns anyway).
          const used = new Set<number>();
          for (const t of pane.tabs) {
            const match = /^Untitled-(\d+)$/.exec(t.fileName);
            if (match) used.add(Number.parseInt(match[1], 10));
          }
          let n = 1;
          while (used.has(n)) n += 1;
          const fileName = `Untitled-${n}`;

          const newTab: EditorTab = {
            filePath: newPath,
            fileName,
            disambiguatedName: fileName,
            // Untitled buffers are born "dirty" — they have content (even if
            // empty) that doesn't exist on disk yet. The close-tab confirm
            // dialog then kicks in naturally and routes through the same
            // Save As flow via `editorSaveRegistry`.
            isDirty: true,
            cursorPosition: { line: 1, col: 1 },
          };

          let tabs = [...pane.tabs, newTab];
          if (tabs.length > maxTabs) {
            const oldestNonDirtyIdx = tabs.findIndex((t) => !t.isDirty);
            if (oldestNonDirtyIdx !== -1) {
              tabs = tabs.filter((_, i) => i !== oldestNonDirtyIdx);
            }
          }
          return { tabs: disambiguateTabNames(tabs), activeFilePath: newPath };
        });
        return updateFeature(state, featureId, next);
      });
      return newPath;
    },

    convertUntitledToFile: (featureId, paneId, untitledPath, newFilePath) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        const next = updatePane(feature, paneId, (pane) => {
          const idx = pane.tabs.findIndex((t) => t.filePath === untitledPath);
          if (idx === -1) return pane;

          // Destination already open in this pane: drop the untitled and
          // activate the existing tab. Avoids two tabs pointing at the same
          // file after a save-as collision.
          const existingIdx = pane.tabs.findIndex(
            (t, i) => i !== idx && t.filePath === newFilePath,
          );
          if (existingIdx !== -1) {
            const tabs = disambiguateTabNames(pane.tabs.filter((_, i) => i !== idx));
            return { tabs, activeFilePath: newFilePath };
          }

          const fileName = getFileName(newFilePath);
          const updated: EditorTab = {
            ...pane.tabs[idx],
            filePath: newFilePath,
            fileName,
            disambiguatedName: fileName,
            isDirty: false,
          };
          const tabs = disambiguateTabNames(pane.tabs.map((t, i) => (i === idx ? updated : t)));
          const activeFilePath =
            pane.activeFilePath === untitledPath ? newFilePath : pane.activeFilePath;
          return { tabs, activeFilePath };
        });
        return updateFeature(state, featureId, next);
      }),
  };
}

function createPathTabActions(
  set: EditorSet,
): Pick<EditorTabActions, "setActiveFile" | "renameFilePath"> {
  return {
    setActiveFile: (featureId, paneId, filePath) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        const next = updatePane(feature, paneId, (pane) => ({ ...pane, activeFilePath: filePath }));
        return updateFeature(state, featureId, next);
      }),

    renameFilePath: (featureId, oldPath, newPath) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        if (oldPath === newPath) return state;
        const oldPrefix = `${oldPath}/`;

        // Remap a single open tab path. Returns the same string when the
        // path is unrelated to the renamed source.
        const remap = (path: string): string => {
          if (path === oldPath) return newPath;
          if (path.startsWith(oldPrefix)) return `${newPath}/${path.slice(oldPrefix.length)}`;
          return path;
        };

        // Walk every pane; rewrite each tab's `filePath` / `fileName` and
        // the pane's `activeFilePath`. Re-runs `disambiguateTabNames` so
        // the visible tab labels stay correct after the rename. If the
        // rename collapses two tabs onto the same path (e.g. the
        // destination was already open as its own tab), drop the
        // duplicate so a file path only ever appears once per pane —
        // prefer the dirty tab to preserve unsaved work.
        let anyChanged = false;
        const nextPanes: Record<string, EditorPaneState> = {};
        for (const [paneId, pane] of Object.entries(feature.panes)) {
          let paneChanged = false;
          const seen = new Map<string, number>(); // filePath → index in newTabs
          const newTabs: EditorTab[] = [];
          for (const t of pane.tabs) {
            const nextPath = remap(t.filePath);
            const nextTab =
              nextPath === t.filePath
                ? t
                : { ...t, filePath: nextPath, fileName: getFileName(nextPath) };
            if (nextPath !== t.filePath) paneChanged = true;
            const existingIdx = seen.get(nextPath);
            if (existingIdx === undefined) {
              seen.set(nextPath, newTabs.length);
              newTabs.push(nextTab);
              continue;
            }
            // Duplicate path: keep dirty one; drop the other.
            paneChanged = true;
            const existing = newTabs[existingIdx];
            if (!existing.isDirty && nextTab.isDirty) {
              newTabs[existingIdx] = nextTab;
            }
          }
          const nextActive =
            pane.activeFilePath != null ? remap(pane.activeFilePath) : pane.activeFilePath;
          if (!paneChanged && nextActive === pane.activeFilePath) {
            nextPanes[paneId] = pane;
            continue;
          }
          anyChanged = true;
          nextPanes[paneId] = {
            ...pane,
            tabs: paneChanged ? disambiguateTabNames(newTabs) : pane.tabs,
            activeFilePath: nextActive,
          };
        }
        if (!anyChanged) return state;
        return updateFeature(state, featureId, { ...feature, panes: nextPanes });
      }),
  };
}

function createTabMetadataActions(
  set: EditorSet,
): Pick<EditorTabActions, "setDirty" | "setCursorPosition" | "clearPendingGoToLine"> {
  return {
    setDirty: (featureId, paneId, filePath, isDirty) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        const tab = feature.panes[paneId]?.tabs.find((item) => item.filePath === filePath);
        if (!tab || tab.isDirty === isDirty) return state;
        const next = updatePane(feature, paneId, (pane) => ({
          ...pane,
          tabs: pane.tabs.map((t) => (t.filePath === filePath ? { ...t, isDirty } : t)),
        }));
        return updateFeature(state, featureId, next);
      }),

    setCursorPosition: (featureId, paneId, filePath, pos) =>
      set((state) => {
        const feature = state.features[featureId];
        if (!feature) return state;
        const next = updatePane(feature, paneId, (pane) => ({
          ...pane,
          tabs: pane.tabs.map((t) => (t.filePath === filePath ? { ...t, cursorPosition: pos } : t)),
        }));
        return updateFeature(state, featureId, next);
      }),
    clearPendingGoToLine: (featureId, paneId, filePath) =>
      set((state) => {
        const feature = state.features[featureId] ?? { ...defaultFeatureState };
        const next = updatePane(feature, paneId, (pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) =>
            tab.filePath === filePath
              ? { ...tab, pendingGoToLine: undefined, pendingGoToColumn: undefined }
              : tab,
          ),
        }));
        return updateFeature(state, featureId, next);
      }),
  };
}

function createArtifactTabActions(
  set: EditorSet,
  get: EditorGet,
): Pick<EditorTabActions, "openArtifact" | "openPhaseArtifacts"> {
  return {
    openArtifact: (featureId, paneId, phaseSlug, maxTabs = DEFAULT_MAX_TABS, artifactType) =>
      set((state) => {
        const typeSuffix =
          artifactType && artifactType !== DEFAULT_ARTIFACT_TYPE ? `/${artifactType}` : "";
        const filePath = `artifact://${featureId}/${phaseSlug}${typeSuffix}`;
        const displayName =
          artifactType && artifactType !== DEFAULT_ARTIFACT_TYPE
            ? `${phaseSlug}/${artifactType} (Artifact)`
            : `${phaseSlug} (Artifact)`;
        const feature = state.features[featureId] ?? { ...defaultFeatureState };
        const next = updatePane(feature, paneId, (pane) => {
          if (pane.tabs.some((t) => t.filePath === filePath)) {
            return { ...pane, activeFilePath: filePath };
          }
          const newTab: EditorTab = {
            filePath,
            fileName: displayName,
            disambiguatedName: displayName,
            isDirty: false,
            cursorPosition: { line: 1, col: 1 },
            isArtifact: true,
            artifactFeatureId: featureId,
            artifactPhaseSlug: phaseSlug,
            artifactType,
          };
          let tabs = [...pane.tabs, newTab];
          if (tabs.length > maxTabs) {
            const oldestNonDirtyIdx = tabs.findIndex((t) => !t.isDirty);
            if (oldestNonDirtyIdx !== -1) {
              tabs = tabs.filter((_, i) => i !== oldestNonDirtyIdx);
            }
          }
          return { tabs: disambiguateTabNames(tabs), activeFilePath: filePath };
        });
        return updateFeature(state, featureId, next);
      }),

    openPhaseArtifacts: (
      featureId,
      paneId,
      phaseSlug,
      artifactTypes,
      maxTabs = DEFAULT_MAX_TABS,
    ) => {
      const { openArtifact } = get();
      for (const at of artifactTypes) {
        openArtifact(featureId, paneId, phaseSlug, maxTabs, at);
      }
      // Re-activate the first type (openArtifact leaves the last one active)
      if (artifactTypes.length > 1) {
        openArtifact(featureId, paneId, phaseSlug, maxTabs, artifactTypes[0]);
      }
    },
  };
}

export function createEditorTabActions(set: EditorSet, get: EditorGet): EditorTabActions {
  return {
    ...createBasicTabActions(set, get),
    ...createUntitledTabActions(set),
    ...createPathTabActions(set),
    ...createTabMetadataActions(set),
    ...createArtifactTabActions(set, get),
  };
}
