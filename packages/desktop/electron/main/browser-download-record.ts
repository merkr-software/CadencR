import type { DownloadItem } from "electron";
import {
  releaseBrowserDownloadReservation,
  removeEmptyBrowserDownloadReservation,
  type BrowserDownloadReservation,
} from "./browser-download-path";
import { downloadErrorMessage, snapshotFromDownloadItem } from "./browser-download-state";
import type { BrowserDownload } from "./browser-types";

const PROGRESS_EMIT_INTERVAL_MS = 100;

export interface BrowserDownloadIdentity {
  id: string;
  tabId: string;
  scopeId: number;
  private: boolean;
  filename: string;
  destination: string;
}

export class BrowserDownloadRecord {
  public: BrowserDownload;
  readonly terminal: Promise<void>;
  finalizing = false;
  settled = false;
  private item: DownloadItem | null;
  private reservation: BrowserDownloadReservation | null;
  private readonly releaseLease: () => Promise<void>;
  private resolveTerminal = (): void => undefined;
  private lastEmissionAt: number;

  static live(
    item: DownloadItem,
    identity: BrowserDownloadIdentity,
    reservation: BrowserDownloadReservation,
    releaseLease: () => Promise<void>,
    now: number,
  ): BrowserDownloadRecord {
    return new BrowserDownloadRecord(item, identity, reservation, releaseLease, now);
  }

  static finished(download: BrowserDownload): BrowserDownloadRecord {
    return new BrowserDownloadRecord(download);
  }

  private constructor(
    itemOrDownload: DownloadItem | BrowserDownload,
    identity?: BrowserDownloadIdentity,
    reservation?: BrowserDownloadReservation,
    releaseLease?: () => Promise<void>,
    now?: number,
  ) {
    if (isBrowserDownload(itemOrDownload)) {
      this.public = itemOrDownload;
      this.item = null;
      this.reservation = null;
      this.releaseLease = async () => undefined;
      this.lastEmissionAt = 0;
      this.terminal = Promise.resolve();
      this.finalizing = true;
      this.settled = true;
      return;
    }
    if (!identity || !reservation || !releaseLease || now === undefined) {
      throw new Error("A live download requires complete construction state.");
    }
    this.public = snapshotFromDownloadItem(
      itemOrDownload,
      { ...identity, state: "progressing" },
      now,
    );
    this.item = itemOrDownload;
    this.reservation = reservation;
    this.releaseLease = releaseLease;
    this.lastEmissionAt = now;
    this.terminal = new Promise<void>((resolve) => {
      this.resolveTerminal = resolve;
    });
  }

  get live(): boolean {
    return this.item !== null && this.public.canCancel;
  }

  pause(now: number): void {
    if (!this.item || !this.public.canPause) throw new Error("This download cannot be paused.");
    this.item.pause();
    this.refresh("paused", now);
  }

  resume(now: number): void {
    if (!this.item?.canResume()) throw new Error("This download cannot be resumed.");
    this.item.resume();
    this.refresh("progressing", now);
  }

  cancelNative(): void {
    this.item?.cancel();
  }

  handleUpdated(state: "progressing" | "interrupted", now: number): boolean {
    if (!this.item || this.finalizing) return false;
    const nextState =
      state === "interrupted" ? "interrupted" : this.item.isPaused() ? "paused" : "progressing";
    const changed = nextState !== this.public.state;
    if (!changed && now - this.lastEmissionAt < PROGRESS_EMIT_INTERVAL_MS) return false;
    this.refresh(nextState, now);
    return true;
  }

  async finalize(
    state: BrowserDownload["state"],
    now: number,
    onChange: () => void,
    cause?: unknown,
  ): Promise<void> {
    if (this.finalizing) return this.terminal;
    this.finalizing = true;
    let completionError: unknown;
    try {
      try {
        this.captureTerminal(state, now, cause);
      } finally {
        this.cleanupReservation(state);
      }
    } catch (error) {
      const combined =
        cause && error !== cause ? new AggregateError([cause, error]) : (cause ?? error);
      this.public = terminalFailure(this.public, state, combined, now);
    } finally {
      this.item = null;
      this.reservation = null;
    }
    try {
      try {
        onChange();
      } catch (error) {
        completionError = error;
      }
      try {
        await this.releaseLease();
      } catch (error) {
        this.public = terminalFailure(this.public, state, error, now);
        completionError = combineErrors(completionError, error);
        try {
          onChange();
        } catch (publicationError) {
          completionError = combineErrors(completionError, publicationError);
        }
      }
    } finally {
      this.settled = true;
      this.resolveTerminal();
    }
    if (completionError) throw completionError;
  }

  private refresh(state: BrowserDownload["state"], now: number): void {
    if (!this.item) return;
    this.public = snapshotFromDownloadItem(this.item, { ...identityOf(this.public), state }, now);
    this.lastEmissionAt = now;
  }

  private captureTerminal(state: BrowserDownload["state"], now: number, cause?: unknown): void {
    if (this.item) {
      this.public = snapshotFromDownloadItem(this.item, { ...identityOf(this.public), state }, now);
    }
    if (cause) this.public = terminalFailure(this.public, state, cause, now);
  }

  private cleanupReservation(state: BrowserDownload["state"]): void {
    if (!this.reservation) return;
    if (state === "completed") {
      releaseBrowserDownloadReservation(this.reservation);
    } else {
      removeEmptyBrowserDownloadReservation(this.reservation);
    }
  }
}

function combineErrors(previous: unknown, next: unknown): unknown {
  return previous
    ? new AggregateError([previous, next], "Download finalization cleanup failed")
    : next;
}

function identityOf(download: BrowserDownload): BrowserDownloadIdentity {
  return {
    id: download.id,
    tabId: download.tabId,
    scopeId: download.scopeId,
    private: download.private,
    filename: download.filename,
    destination: download.destination,
  };
}

function terminalFailure(
  previous: BrowserDownload,
  state: BrowserDownload["state"],
  error: unknown,
  now: number,
): BrowserDownload {
  return {
    ...previous,
    state,
    canPause: false,
    canResume: false,
    canCancel: false,
    bytesPerSecond: 0,
    finishedAt: previous.finishedAt ?? new Date(now).toISOString(),
    error: downloadErrorMessage(error, "Download failed"),
  };
}

function isBrowserDownload(value: DownloadItem | BrowserDownload): value is BrowserDownload {
  return "filename" in value && "destination" in value && "scopeId" in value;
}
