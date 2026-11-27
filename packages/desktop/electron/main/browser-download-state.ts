import type { DownloadItem } from "electron";
import { sanitizeBrowserDownloadFilename } from "./browser-download-path";
import type { BrowserDownload, BrowserDownloadState } from "./browser-types";

interface DownloadSnapshotInput {
  id: string;
  tabId: string;
  scopeId: number;
  private: boolean;
  filename: string;
  destination: string;
  state: BrowserDownloadState;
}

export function snapshotFromDownloadItem(
  item: DownloadItem,
  input: DownloadSnapshotInput,
  now: number,
): BrowserDownload {
  const total = item.getTotalBytes();
  const received = Math.max(0, item.getReceivedBytes());
  const terminal = !["progressing", "paused", "interrupted"].includes(input.state);
  const canResume = (input.state === "paused" || input.state === "interrupted") && item.canResume();
  return {
    id: input.id,
    tabId: input.tabId,
    scopeId: input.scopeId,
    filename: input.filename,
    destination: input.destination,
    state: input.state,
    receivedBytes: received,
    totalBytes: total > 0 ? total : null,
    bytesPerSecond: terminal ? 0 : Math.max(0, item.getCurrentBytesPerSecond()),
    percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null,
    canPause: input.state === "progressing",
    canResume,
    canCancel: !terminal,
    private: input.private,
    startedAt: new Date(item.getStartTime() * 1000 || now).toISOString(),
    ...(terminal ? { finishedAt: new Date(now).toISOString() } : {}),
    ...(input.state === "failed"
      ? { errorReason: "interrupted" as const, error: "The download was interrupted." }
      : {}),
  };
}

export function aggregateDownloadPercent(active: BrowserDownload[]): number | null {
  if (active.length === 0 || active.some((entry) => entry.totalBytes === null)) return null;
  const total = active.reduce((sum, entry) => sum + (entry.totalBytes ?? 0), 0);
  const received = active.reduce((sum, entry) => sum + entry.receivedBytes, 0);
  return total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
}

export function doneDownloadState(
  state: "completed" | "cancelled" | "interrupted",
): BrowserDownloadState {
  return state === "interrupted" ? "failed" : state;
}

export function downloadErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function safeDownloadFilename(item: DownloadItem): string {
  try {
    return sanitizeBrowserDownloadFilename(item.getFilename());
  } catch (error) {
    console.warn("Could not read rejected Browser download filename:", error);
    return "download";
  }
}

export function failedBrowserDownload(input: {
  id: string;
  tabId: string;
  scopeId: number;
  filename: string;
  destination: string;
  private: boolean;
  now: number;
  error: unknown;
}): BrowserDownload {
  const timestamp = new Date(input.now).toISOString();
  return {
    id: input.id,
    tabId: input.tabId,
    scopeId: input.scopeId,
    filename: input.filename,
    destination: input.destination,
    state: "failed",
    receivedBytes: 0,
    totalBytes: null,
    bytesPerSecond: 0,
    percent: null,
    canPause: false,
    canResume: false,
    canCancel: false,
    private: input.private,
    startedAt: timestamp,
    finishedAt: timestamp,
    ...downloadFailure(input.error, "startFailed"),
  };
}

export function downloadFailure(
  cause: unknown,
  reason: "startFailed" | "failed",
): Pick<BrowserDownload, "error" | "errorReason"> {
  if (cause instanceof Error && cause.message) {
    return { error: cause.message, errorReason: undefined };
  }
  return {
    error: reason === "startFailed" ? "Download could not start" : "Download failed",
    errorReason: reason,
  };
}
