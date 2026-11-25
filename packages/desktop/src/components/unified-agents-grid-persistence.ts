import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";
import type { UnifiedAgentEntry } from "@/api/generated";

const MIN_ROW_HEIGHT = 420;
const MAX_ROW_HEIGHT = 1200;
// v3: rekey rows by *row index* instead of session IDs. Previously the key
// embedded the row's session IDs (`columns:3|sessions:42,17,89`), so any
// agent churn — creation, archive, pin, sort, filter — produced a brand-new
// key and the saved height/width was effectively unreachable. Row index is
// stable across that churn: row 0 stays row 0 no matter what's in it.
const ROW_HEIGHTS_KEY = "unified_agents_row_heights_v3";
const ROW_WIDTHS_KEY = "unified_agents_row_widths_v2";

export type RowLayoutKey = string;
export type RowHeightMap = Record<RowLayoutKey, number>;
export type RowWidthLayouts = Record<RowLayoutKey, PanelLayout>;
export type PanelLayout = Record<string, number>;

export function loadRowHeights(): RowHeightMap {
  return loadJson(ROW_HEIGHTS_KEY, parseUnifiedAgentsRowHeights, () =>
    translateUi(
      "agents.overview.rows.loadHeightsError",
      "Could not load saved agent grid heights.",
    ),
  );
}

export function loadRowWidths(): RowWidthLayouts {
  return loadJson(ROW_WIDTHS_KEY, parseUnifiedAgentsRowWidths, () =>
    translateUi("agents.overview.rows.loadWidthsError", "Could not load saved agent grid widths."),
  );
}

function loadJson<T>(key: string, parse: (value: unknown) => T, failureMessage: () => string): T {
  const fallback = parse(undefined);
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? parse(JSON.parse(raw) as unknown) : fallback;
  } catch (error: unknown) {
    notifyPersistenceError(failureMessage(), error);
    return fallback;
  }
}

export function saveRowHeights(rowHeights: RowHeightMap): void {
  saveJson(ROW_HEIGHTS_KEY, rowHeights, () =>
    translateUi("agents.overview.rows.saveHeightsError", "Could not save agent grid heights."),
  );
}

export function saveRowWidths(rowWidths: RowWidthLayouts): void {
  saveJson(ROW_WIDTHS_KEY, rowWidths, () =>
    translateUi("agents.overview.rows.saveWidthsError", "Could not save agent grid widths."),
  );
}

function saveJson(key: string, value: unknown, failureMessage: () => string): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error: unknown) {
    notifyPersistenceError(failureMessage(), error);
  }
}

export function clampRowHeight(height: number): number {
  return Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, Math.round(height)));
}

export function getRowLayoutKey(rowIndex: number, columns: number): RowLayoutKey {
  return buildUnifiedAgentsRowLayoutKey(columns, rowIndex);
}

export function getAgentPanelId(entry: UnifiedAgentEntry): string {
  return buildUnifiedAgentPanelId(entry.project.id, entry.feature.id, entry.session.sessionDbId);
}

export function getStoredRowWidthLayout(
  rowAgents: UnifiedAgentEntry[],
  layout: PanelLayout | undefined,
): PanelLayout | undefined {
  if (!layout) return undefined;
  const panelIds = rowAgents.map(getAgentPanelId);
  return panelIds.every((panelId) => typeof layout[panelId] === "number") ? layout : undefined;
}

function notifyPersistenceError(message: string, error: unknown): void {
  console.error(message, error);
  window.queueMicrotask(() => toast.error(message));
}

export function buildUnifiedAgentsRowLayoutKey(columns: number, rowIndex: number): string {
  return `columns:${columns}|row:${rowIndex}`;
}

export function buildUnifiedAgentPanelId(
  projectId: number,
  featureId: number,
  sessionDbId: number,
): string {
  return `agent-${projectId}-${featureId}-${sessionDbId}`;
}

export function parseUnifiedAgentsRowHeights(value: unknown): RowHeightMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce<RowHeightMap>((accumulator, [key, height]) => {
    if (typeof height === "number" && Number.isFinite(height)) {
      accumulator[key] = clampRowHeight(height);
    }
    return accumulator;
  }, {});
}

export function parseUnifiedAgentsRowWidths(value: unknown): RowWidthLayouts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce<RowWidthLayouts>((accumulator, [rowKey, layout]) => {
    const parsedLayout = parsePanelLayout(layout);
    if (parsedLayout) accumulator[rowKey] = parsedLayout;
    return accumulator;
  }, {});
}

function parsePanelLayout(value: unknown): PanelLayout | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const layout = Object.entries(value).reduce<PanelLayout>((accumulator, [panelId, size]) => {
    if (typeof size === "number" && Number.isFinite(size) && size >= 0 && size <= 100) {
      accumulator[panelId] = size;
    }
    return accumulator;
  }, {});
  return Object.keys(layout).length > 0 ? layout : undefined;
}
