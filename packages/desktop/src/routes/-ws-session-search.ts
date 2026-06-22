import { isTabKind, type TabKind } from "@/stores/feature-layout-schema";

export interface WsSessionSearch {
  cwd: string;
  featureId: number;
  projectId: number;
  focusTab?: TabKind;
}

export function validateWsSessionSearch(search: Record<string, unknown>): WsSessionSearch {
  if (typeof search.cwd !== "string" || !search.cwd) {
    throw new Error("cwd search param is required for WebSocket sessions");
  }
  const featureId = Number(search.featureId);
  const projectId = Number(search.projectId);
  if (!Number.isInteger(featureId) || featureId <= 0) {
    throw new Error("featureId search param is required for WebSocket sessions");
  }
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error("projectId search param is required for WebSocket sessions");
  }
  const focusTab = isTabKind(search.focusTab) ? search.focusTab : undefined;
  return focusTab
    ? { cwd: search.cwd, featureId, projectId, focusTab }
    : { cwd: search.cwd, featureId, projectId };
}
