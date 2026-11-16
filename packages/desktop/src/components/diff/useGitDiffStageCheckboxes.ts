import { useEffect, useMemo, useRef } from "react";
import type { FileTree } from "@pierre/trees";
import { FileStageState, type ChangedFile } from "@/api/generated";
import { useFileTreeShadowStylesheet } from "@/components/file-tree/useFileTreeShadowStylesheet";
import {
  getGitFileActionAvailability,
  type GitFileIndexAction,
  type GitFileIndexActions,
} from "./useGitFileIndexActions";
import { resolvedStageState } from "./useGitDiffFileTreeModel";
import { useGitStageControlState, type GitStageControlState } from "./useGitStageControlState";
import {
  CHECKBOX_ATTR,
  GIT_DIFF_TREE_CSS,
  GIT_DIFF_TREE_STAGE_CSS,
  LOADER_ATTR,
} from "./gitDiffTreeShadowCss";

const PATH_ATTR = "data-cadencr-stage-path";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ROW_SELECTOR = "[data-item-path][data-item-type]";

function checkboxVisualState(stageState: ReturnType<typeof resolvedStageState>): {
  checked: boolean;
  indeterminate: boolean;
} | null {
  if (stageState === FileStageState.not_applicable) return null;
  return {
    checked: stageState === FileStageState.staged || stageState === FileStageState.both,
    indeterminate: stageState === FileStageState.both,
  };
}

function ensureCheckboxInput(row: HTMLElement): HTMLInputElement {
  let input = row.querySelector<HTMLInputElement>(`input[${CHECKBOX_ATTR}]`);
  if (input) return input;
  input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute(CHECKBOX_ATTR, "");
  const icon = row.querySelector('[data-item-section="icon"]');
  if (icon) icon.before(input);
  else row.prepend(input);
  return input;
}

function stageActionLabel(path: string, action: GitFileIndexAction): string {
  return `${action === "stage" ? "Staging" : "Unstaging"} ${path}`;
}

function createLoader(path: string, action: GitFileIndexAction): HTMLSpanElement {
  const loader = document.createElement("span");
  const label = stageActionLabel(path, action);
  loader.setAttribute(LOADER_ATTR, "");
  loader.setAttribute("role", "status");
  loader.setAttribute("aria-label", label);
  loader.title = label;

  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const pathElement = document.createElementNS(SVG_NAMESPACE, "path");
  pathElement.setAttribute("d", "M21 12a9 9 0 1 1-6.219-8.56");
  svg.append(pathElement);
  loader.append(svg);
  return loader;
}

function ensureStageLoader(row: HTMLElement, path: string, action: GitFileIndexAction): void {
  row.querySelector(`input[${CHECKBOX_ATTR}]`)?.remove();
  const existing = row.querySelector<HTMLElement>(`:scope > [${LOADER_ATTR}]`);
  const label = stageActionLabel(path, action);
  if (existing) {
    if (existing.getAttribute("aria-label") !== label) existing.setAttribute("aria-label", label);
    if (existing.title !== label) existing.title = label;
    return;
  }
  const loader = createLoader(path, action);
  const icon = row.querySelector('[data-item-section="icon"]');
  if (icon) icon.before(loader);
  else row.prepend(loader);
}

function removeStageControl(row: HTMLElement): void {
  row.querySelector(`input[${CHECKBOX_ATTR}]`)?.remove();
  row.querySelector(`[${LOADER_ATTR}]`)?.remove();
}

function syncRowAdornments(
  row: HTMLElement,
  file: ChangedFile | undefined,
  controlState: GitStageControlState,
): void {
  const path = row.getAttribute("data-item-path");
  if (!path || !file) {
    removeStageControl(row);
    return;
  }
  const stageState = resolvedStageState(file);
  const visual = checkboxVisualState(stageState);
  if (!visual) {
    removeStageControl(row);
    return;
  }

  const pendingAction = controlState.pendingAction;
  if (controlState.pendingPath === path && pendingAction) {
    ensureStageLoader(row, path, pendingAction);
    return;
  }

  row.querySelector(`[${LOADER_ATTR}]`)?.remove();
  const input = ensureCheckboxInput(row);
  if (input.getAttribute(PATH_ATTR) !== path) input.setAttribute(PATH_ATTR, path);
  const label = `Stage ${path}`;
  if (input.getAttribute("aria-label") !== label) input.setAttribute("aria-label", label);
  const availability = getGitFileActionAvailability(stageState);
  const canToggle =
    (visual.checked && availability.canReset) || (!visual.checked && availability.canStage);
  const disabled = controlState.isBusy || !canToggle;
  if (input.disabled !== disabled) input.disabled = disabled;
  if (input.checked !== visual.checked) input.checked = visual.checked;
  if (input.indeterminate !== visual.indeterminate) input.indeterminate = visual.indeterminate;
}

function syncAllStageRows(
  shadowRoot: ShadowRoot,
  byPath: ReadonlyMap<string, ChangedFile>,
  controlState: GitStageControlState,
): void {
  for (const row of shadowRoot.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    syncStageRow(row, byPath, controlState);
  }
}

function syncStageRow(
  row: HTMLElement,
  byPath: ReadonlyMap<string, ChangedFile>,
  controlState: GitStageControlState,
): void {
  const path = row.getAttribute("data-item-path");
  const file = row.getAttribute("data-item-type") === "file" && path ? byPath.get(path) : undefined;
  syncRowAdornments(row, file, controlState);
}

function shadowRootOf(model: FileTree): ShadowRoot | null {
  const getContainer = model.getFileTreeContainer;
  if (typeof getContainer !== "function") return null;
  return getContainer.call(model)?.shadowRoot ?? null;
}

function collectRowsFromMutations(records: readonly MutationRecord[]): Set<HTMLElement> {
  const rows = new Set<HTMLElement>();
  for (const record of records) {
    if (record.type === "attributes" && record.target instanceof HTMLElement) {
      if (record.target.matches(ROW_SELECTOR)) rows.add(record.target);
      continue;
    }
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node instanceof HTMLElement && node.matches(ROW_SELECTOR)) rows.add(node);
      node.querySelectorAll<HTMLElement>(ROW_SELECTOR).forEach((row) => rows.add(row));
      const containingRow = node.closest<HTMLElement>(ROW_SELECTOR);
      if (
        containingRow?.querySelector(`[${LOADER_ATTR}]`) &&
        containingRow.querySelector(`input[${CHECKBOX_ATTR}]`)
      ) {
        rows.add(containingRow);
      }
    }
  }
  return rows;
}

function observeStageCheckboxRows(
  shadowRoot: ShadowRoot,
  syncRow: (row: HTMLElement) => void,
): () => void {
  const observer = new MutationObserver((records) => {
    const rows = collectRowsFromMutations(records);
    shadowRoot
      .querySelectorAll<HTMLElement>(
        `${ROW_SELECTOR}:has(> [${LOADER_ATTR}]):has(> input[${CHECKBOX_ATTR}])`,
      )
      .forEach((row) => rows.add(row));
    for (const row of rows) syncRow(row);
  });
  observer.observe(shadowRoot, {
    attributes: true,
    attributeFilter: ["data-item-path"],
    childList: true,
    subtree: true,
  });
  return () => observer.disconnect();
}

function bindStageCheckboxEvents(
  shadowRoot: ShadowRoot,
  fileByPathRef: { current: ReadonlyMap<string, ChangedFile> },
  actionsRef: { current: GitFileIndexActions },
): () => void {
  const stopCheckboxEventPropagation = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.hasAttribute(CHECKBOX_ATTR)) return;
    event.stopPropagation();
  };
  const onChange = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !target.hasAttribute(CHECKBOX_ATTR)) return;
    event.stopPropagation();
    const path = target.getAttribute(PATH_ATTR);
    if (!path) return;
    const file = fileByPathRef.current.get(path);
    if (!file) return;
    const stageState = resolvedStageState(file);
    const visual = checkboxVisualState(stageState);
    if (!visual) return;
    target.checked = visual.checked;
    target.indeterminate = visual.indeterminate;
    if (visual.checked || visual.indeterminate) {
      actionsRef.current.reset(path);
      return;
    }
    actionsRef.current.stage(path, {
      conflicted: stageState === FileStageState.conflicted,
    });
  };
  shadowRoot.addEventListener("pointerdown", stopCheckboxEventPropagation, true);
  shadowRoot.addEventListener("click", stopCheckboxEventPropagation, true);
  shadowRoot.addEventListener("change", onChange, true);
  return () => {
    shadowRoot.removeEventListener("pointerdown", stopCheckboxEventPropagation, true);
    shadowRoot.removeEventListener("click", stopCheckboxEventPropagation, true);
    shadowRoot.removeEventListener("change", onChange, true);
  };
}

/**
 * Injects stage controls into Pierre file rows (shadow DOM) and keeps them in
 * sync with Git state. The shadow observer covers rows recycled by Pierre's
 * viewport without rescanning every rendered row.
 */
export function useGitDiffStageCheckboxes(
  model: FileTree,
  files: readonly ChangedFile[],
  indexActions: GitFileIndexActions,
  enabled: boolean,
): void {
  useFileTreeShadowStylesheet(
    model,
    "data-cadencr-git-diff-tree",
    enabled ? GIT_DIFF_TREE_CSS + GIT_DIFF_TREE_STAGE_CSS : GIT_DIFF_TREE_CSS,
  );
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.file, file])), [files]);
  const controlState = useGitStageControlState(indexActions, fileByPath, enabled);
  const fileByPathRef = useRef<ReadonlyMap<string, ChangedFile>>(fileByPath);
  const controlStateRef = useRef(controlState);
  const actionsRef = useRef(indexActions);
  fileByPathRef.current = fileByPath;
  controlStateRef.current = controlState;
  actionsRef.current = indexActions;

  useEffect(() => {
    if (!enabled) {
      shadowRootOf(model)
        ?.querySelectorAll(`input[${CHECKBOX_ATTR}], [${LOADER_ATTR}]`)
        .forEach((node) => node.remove());
      return;
    }

    const sync = (): void => {
      const shadowRoot = shadowRootOf(model);
      if (shadowRoot) {
        syncAllStageRows(shadowRoot, fileByPathRef.current, controlStateRef.current);
      }
    };
    const syncRow = (row: HTMLElement): void => {
      syncStageRow(row, fileByPathRef.current, controlStateRef.current);
    };

    let detachShadow: (() => void) | null = null;
    let rafId = 0;
    let attempts = 0;
    const attach = (): void => {
      const shadowRoot = shadowRootOf(model);
      if (!shadowRoot) {
        if (++attempts < 60) rafId = requestAnimationFrame(attach);
        return;
      }
      detachShadow = bindStageCheckboxEvents(shadowRoot, fileByPathRef, actionsRef);
      sync();
      const stopObservingRows = observeStageCheckboxRows(shadowRoot, syncRow);
      const detachEvents = detachShadow;
      detachShadow = () => {
        stopObservingRows();
        detachEvents();
      };
    };

    attach();
    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      detachShadow?.();
    };
  }, [enabled, model]);

  useEffect(() => {
    if (!enabled) return;
    const shadowRoot = shadowRootOf(model);
    if (shadowRoot) syncAllStageRows(shadowRoot, fileByPath, controlState);
  }, [controlState, enabled, fileByPath, model]);
}
