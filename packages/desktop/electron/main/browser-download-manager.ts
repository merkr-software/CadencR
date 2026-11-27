import { translateUi } from "../../src/shared/ui-i18n";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, shell, type DownloadItem, type WebContents } from "electron";
import {
  removeEmptyBrowserDownloadReservation,
  reserveBrowserDownloadPath,
  sanitizeBrowserDownloadFilename,
  type BrowserDownloadReservation,
} from "./browser-download-path";
import {
  BrowserDownloadPublisher,
  type BrowserDownloadPublisherOptions,
} from "./browser-download-publisher";
import { BrowserDownloadRecord } from "./browser-download-record";
import { settleBrowserDownloadRecords } from "./browser-download-settlement";
import { BrowserDownloadSources, type BrowserDownloadSource } from "./browser-download-sources";
import {
  aggregateDownloadPercent,
  doneDownloadState,
  failedBrowserDownload,
  safeDownloadFilename,
} from "./browser-download-state";
import { isPrivateProfile } from "./browser-session-lifecycle";
import type { ManagedTab } from "./browser-tab-events";
import type { BrowserTabLifecycle } from "./browser-tab-lifecycle";
import type { BrowserDownloadSnapshot } from "./browser-types";

const MAX_ACTIVE_DOWNLOADS = 20;
const MAX_ACTIVE_DOWNLOADS_PER_SCOPE = 10;
const MAX_FINISHED_DOWNLOADS = 50;

interface BrowserDownloadManagerOptions extends BrowserDownloadPublisherOptions {
  lifecycle: BrowserTabLifecycle;
  getDownloadsDirectory?: () => string;
  reveal?: (destination: string) => void;
  now?: () => number;
}

/** Owns Browser downloads without exposing DownloadItem or request data to the renderer. */
export class BrowserDownloadManager {
  private readonly downloads = new Map<string, BrowserDownloadRecord>();
  private readonly sources = new BrowserDownloadSources((event, item, contents) =>
    this.handleWillDownload(event, item, contents),
  );
  private readonly closingScopes = new Set<number>();
  private readonly failureCancellations = new WeakSet<BrowserDownloadRecord>();
  private readonly getDownloadsDirectory: () => string;
  private readonly revealDestination: (destination: string) => void;
  private readonly now: () => number;
  private readonly publisher: BrowserDownloadPublisher;
  private accepting = true;

  constructor(private readonly options: BrowserDownloadManagerOptions) {
    this.getDownloadsDirectory = options.getDownloadsDirectory ?? (() => app.getPath("downloads"));
    this.revealDestination =
      options.reveal ?? ((destination) => shell.showItemInFolder(destination));
    this.now = options.now ?? Date.now;
    this.publisher = new BrowserDownloadPublisher(options);
  }

  watch(tab: ManagedTab): void {
    this.sources.watch(tab);
  }

  list(scopeId: number): BrowserDownloadSnapshot {
    const downloads = [...this.downloads.values()]
      .map((entry) => entry.public)
      .filter((entry) => entry.scopeId === scopeId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const active = downloads.filter((entry) => entry.canCancel);
    return {
      scopeId,
      downloads,
      activeCount: active.length,
      aggregatePercent: aggregateDownloadPercent(active),
    };
  }

  pause(scopeId: number, id: string): BrowserDownloadSnapshot {
    this.requireLive(scopeId, id).pause(this.now());
    this.emit(scopeId);
    return this.list(scopeId);
  }

  resume(scopeId: number, id: string): BrowserDownloadSnapshot {
    this.requireLive(scopeId, id).resume(this.now());
    this.emit(scopeId);
    return this.list(scopeId);
  }

  async cancel(scopeId: number, id: string): Promise<BrowserDownloadSnapshot> {
    await this.cancelAndSettle([this.requireLive(scopeId, id)]);
    return this.list(scopeId);
  }

  reveal(scopeId: number, id: string): void {
    const record = this.requireOwned(scopeId, id);
    if (record.public.state !== "completed") {
      throw new Error(
        translateUi(
          "workspace.browser.downloads.revealIncomplete",
          "Only completed downloads can be revealed.",
        ),
      );
    }
    if (!existsSync(record.public.destination)) {
      throw new Error(
        translateUi(
          "workspace.browser.downloads.fileMissing",
          "The downloaded file is no longer at its saved destination.",
        ),
      );
    }
    this.revealDestination(record.public.destination);
  }

  clearFinished(scopeId: number): BrowserDownloadSnapshot {
    for (const [id, record] of this.downloads) {
      if (record.public.scopeId === scopeId && record.settled) this.downloads.delete(id);
    }
    this.emit(scopeId);
    return this.list(scopeId);
  }

  async closeScope<T>(scopeId: number, teardown: () => Promise<T>): Promise<T> {
    this.closingScopes.add(scopeId);
    const unsettled = [...this.downloads.values()].filter(
      (record) => record.public.scopeId === scopeId && !record.settled,
    );
    try {
      await this.cancelAndSettle(unsettled);
      for (const [id, record] of this.downloads) {
        if (record.public.scopeId === scopeId && record.public.private && record.settled) {
          this.downloads.delete(id);
        }
      }
      this.emit(scopeId);
      return await teardown();
    } finally {
      this.closingScopes.delete(scopeId);
    }
  }

  async prepareForShutdown(): Promise<void> {
    this.accepting = false;
    await this.cancelAndSettle([...this.downloads.values()].filter((entry) => !entry.settled));
  }

  resumeAfterShutdownAbort(): void {
    this.accepting = true;
  }

  activeCountsByScope(): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const record of this.downloads.values()) {
      if (!record.public.canCancel) continue;
      counts[record.public.scopeId] = (counts[record.public.scopeId] ?? 0) + 1;
    }
    return counts;
  }

  private handleWillDownload(
    event: Electron.Event,
    item: DownloadItem,
    initiatingContents: WebContents,
  ): void {
    const source = this.sources.get(initiatingContents);
    if (!this.canAccept(source, initiatingContents)) {
      event.preventDefault();
      return;
    }
    try {
      this.startDownload(item, source);
    } catch (error) {
      event.preventDefault();
      this.safelyRecordFailure(source, safeDownloadFilename(item), "Downloads", error);
    }
  }

  private canAccept(
    source: BrowserDownloadSource | undefined,
    initiatingContents: WebContents,
  ): source is BrowserDownloadSource {
    return Boolean(
      this.accepting &&
      source &&
      !this.closingScopes.has(source.scopeId) &&
      source.webContents === initiatingContents &&
      !initiatingContents.isDestroyed(),
    );
  }

  private startDownload(item: DownloadItem, source: BrowserDownloadSource): void {
    this.assertCapacity(source.scopeId);
    const filename = sanitizeBrowserDownloadFilename(item.getFilename());
    const reservation = reserveBrowserDownloadPath(this.getDownloadsDirectory(), filename);
    const reservedFilename = path.basename(reservation.path);
    let releaseLease: (() => Promise<void>) | null = null;
    try {
      releaseLease = this.options.lifecycle.acquireSessionLease(source.profile);
      // Must stay synchronous inside `will-download`; a late call opens Electron's dialog.
      item.setSavePath(reservation.path);
      this.installDownload(item, source, reservedFilename, reservation, releaseLease);
    } catch (error) {
      throw this.cleanupFailedStart(source, reservedFilename, reservation, releaseLease, error);
    }
  }

  private installDownload(
    item: DownloadItem,
    source: BrowserDownloadSource,
    filename: string,
    reservation: BrowserDownloadReservation,
    releaseLease: () => Promise<void>,
  ): void {
    const record = BrowserDownloadRecord.live(
      item,
      {
        id: randomUUID(),
        tabId: source.tabId,
        scopeId: source.scopeId,
        private: isPrivateProfile(source.profile),
        filename,
        destination: reservation.path,
      },
      reservation,
      releaseLease,
      this.now(),
    );
    this.downloads.set(record.public.id, record);
    item.on("updated", (_event, state) => this.handleUpdated(record, state));
    item.once("done", (_event, state) => {
      if (!this.failureCancellations.has(record)) {
        this.finalizeInBackground(record, doneDownloadState(state));
      }
    });
    this.emitWithTrim(source.scopeId);
  }

  private cleanupFailedStart(
    source: BrowserDownloadSource,
    filename: string,
    reservation: BrowserDownloadReservation,
    releaseLease: (() => Promise<void>) | null,
    setupError: unknown,
  ): unknown {
    let combinedError = setupError;
    try {
      removeEmptyBrowserDownloadReservation(reservation);
    } catch (cleanupError) {
      combinedError = new AggregateError(
        [combinedError, cleanupError],
        "Download setup cleanup failed",
      );
    }
    void releaseLease?.().catch((releaseError: unknown) => {
      this.safelyRecordFailure(
        source,
        filename,
        reservation.path,
        new AggregateError(
          [combinedError, releaseError],
          "Download setup and lease cleanup failed",
        ),
      );
    });
    return combinedError;
  }

  private assertCapacity(scopeId: number): void {
    const active = [...this.downloads.values()].filter((entry) => !entry.settled);
    if (
      active.length >= MAX_ACTIVE_DOWNLOADS ||
      active.filter((entry) => entry.public.scopeId === scopeId).length >=
        MAX_ACTIVE_DOWNLOADS_PER_SCOPE
    ) {
      throw new Error(
        translateUi(
          "workspace.browser.downloads.limit",
          "Too many active downloads. Finish or cancel one before starting another.",
        ),
      );
    }
  }

  private handleUpdated(record: BrowserDownloadRecord, state: "progressing" | "interrupted"): void {
    try {
      if (record.handleUpdated(state, this.now())) this.emit(record.public.scopeId);
    } catch (error) {
      this.failureCancellations.add(record);
      let cause = error;
      try {
        record.cancelNative();
      } catch (cancelError) {
        cause = new AggregateError([error, cancelError], "Download update and cancellation failed");
      }
      this.finalizeInBackground(record, "failed", cause);
    }
  }

  private async finalize(
    record: BrowserDownloadRecord,
    state: BrowserDownloadRecord["public"]["state"],
    cause?: unknown,
  ): Promise<void> {
    await record.finalize(state, this.now(), () => this.emit(record.public.scopeId), cause);
    this.failureCancellations.delete(record);
    this.emitWithTrim(record.public.scopeId);
  }

  private finalizeInBackground(
    record: BrowserDownloadRecord,
    state: BrowserDownloadRecord["public"]["state"],
    cause?: unknown,
  ): void {
    void this.finalize(record, state, cause).catch((error: unknown) => {
      this.publisher.report(error, "Download finalization failed", record.public.scopeId);
    });
  }

  private safelyRecordFailure(
    source: BrowserDownloadSource,
    filename: string,
    destination: string,
    error: unknown,
  ): void {
    try {
      const failed = failedBrowserDownload({
        id: randomUUID(),
        tabId: source.tabId,
        scopeId: source.scopeId,
        filename,
        destination,
        private: isPrivateProfile(source.profile),
        now: this.now(),
        error,
      });
      this.downloads.set(failed.id, BrowserDownloadRecord.finished(failed));
      this.emitWithTrim(source.scopeId);
    } catch (reportError) {
      this.publisher.report(reportError, "Could not report rejected download", source.scopeId);
    }
  }

  private async cancelAndSettle(records: BrowserDownloadRecord[]): Promise<void> {
    await settleBrowserDownloadRecords(records, (record, error) =>
      this.finalizeInBackground(record, error ? "failed" : "cancelled", error),
    );
  }

  private requireOwned(scopeId: number, id: string): BrowserDownloadRecord {
    const record = this.downloads.get(id);
    if (!record || record.public.scopeId !== scopeId) {
      throw new Error(
        translateUi(
          "workspace.browser.downloads.gone",
          "This download is no longer available in this Browser workspace.",
        ),
      );
    }
    return record;
  }

  private requireLive(scopeId: number, id: string): BrowserDownloadRecord {
    const record = this.requireOwned(scopeId, id);
    if (!record.live)
      throw new Error(
        translateUi("workspace.browser.downloads.finished", "This download has finished."),
      );
    return record;
  }

  private trimFinished(): Set<number> {
    const finished = [...this.downloads.entries()].filter(([, record]) => record.settled);
    const changed = new Set<number>();
    const excess = Math.max(0, finished.length - MAX_FINISHED_DOWNLOADS);
    for (const [id, record] of finished.slice(0, excess)) {
      this.downloads.delete(id);
      changed.add(record.public.scopeId);
    }
    return changed;
  }

  private emitWithTrim(scopeId: number): void {
    const scopes = this.trimFinished();
    scopes.add(scopeId);
    for (const changedScope of scopes) this.emit(changedScope);
  }

  private emit(scopeId: number): void {
    this.publisher.publish(scopeId, this.list(scopeId), this.activeCountsByScope());
  }
}
