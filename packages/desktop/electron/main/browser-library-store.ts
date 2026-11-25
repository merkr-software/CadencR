import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { browserLibraryErrors } from "./browser-library-errors";
import type {
  BrowserBookmark,
  BrowserHistoryEntry,
  BrowserLibraryChange,
  BrowserOmniboxQueryResult,
} from "./browser-types";
import { MAX_BROWSER_LIBRARY_QUERY_LENGTH, MAX_BROWSER_LIBRARY_URL_LENGTH } from "./browser-types";

interface BrowserLibraryData {
  version: 1;
  history: BrowserHistoryEntry[];
  bookmarks: BrowserBookmark[];
}

type LibraryUpdate<T> = (current: BrowserLibraryData) => { next: BrowserLibraryData; result: T };

const MAX_HISTORY_ENTRIES = 250;
const MAX_BOOKMARKS = 100;
const MAX_STORED_BYTES = 512 * 1024;
const MAX_TITLE_LENGTH = 256;
const MAX_QUERY_RESULTS = 20;
const DEFAULT_QUERY_RESULTS = 8;

const EMPTY_LIBRARY: BrowserLibraryData = { version: 1, history: [], bookmarks: [] };

/**
 * Persistent, renderer-queryable browser history and bookmarks.
 *
 * The main process is the authority: renderer mutations receive confirmed
 * results only after an atomic disk replace succeeds. All operations are
 * serialized so a failed write cannot poison the queue or leak an uncommitted
 * in-memory snapshot into the next mutation.
 */
export class BrowserLibraryStore {
  private data: BrowserLibraryData | null = null;
  private loadPromise: Promise<BrowserLibraryData> | null = null;
  private queueTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = defaultLibraryPath(),
    private readonly now: () => number = () => Date.now(),
    private readonly onChanged: (change: BrowserLibraryChange) => void = () => undefined,
  ) {}

  async query(
    rawQuery: string,
    rawLimit = DEFAULT_QUERY_RESULTS,
  ): Promise<BrowserOmniboxQueryResult> {
    const data = await this.load();
    const query = rawQuery.trim().slice(0, MAX_BROWSER_LIBRARY_QUERY_LENGTH).toLocaleLowerCase();
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(MAX_QUERY_RESULTS, Math.floor(rawLimit)))
      : DEFAULT_QUERY_RESULTS;
    return {
      bookmarks: matching(data.bookmarks, query, limit),
      bookmarkCount: data.bookmarks.length,
      history: matching(data.history, query, limit),
      historyCount: data.history.length,
    };
  }

  async getBookmark(rawUrl: string): Promise<BrowserBookmark | null> {
    const url = safeLibraryUrl(rawUrl);
    const data = await this.load();
    return data.bookmarks.find((entry) => entry.url === url) ?? null;
  }

  /** Record a committed main-frame navigation, updating an existing URL in place. */
  async recordHistoryNavigation(rawUrl: string, rawTitle: string): Promise<BrowserHistoryEntry> {
    const url = safeLibraryUrl(rawUrl, "history");
    const title = safeTitle(rawTitle, url);
    return this.commit(
      (current) => {
        const previous = current.history.find((entry) => entry.url === url);
        const entry: BrowserHistoryEntry = {
          id: previous?.id ?? randomUUID(),
          url,
          title,
          visitedAt: new Date(this.now()).toISOString(),
        };
        const history = [entry, ...current.history.filter((item) => item.url !== url)];
        return { next: bounded({ ...current, history }), result: entry };
      },
      { kind: "history" },
    );
  }

  /**
   * Apply a later title event only to an existing visit. This deliberately does
   * not recreate history after the user clears/deletes it, nor bump recency.
   */
  async updateHistoryTitle(rawUrl: string, rawTitle: string): Promise<BrowserHistoryEntry | null> {
    const url = safeLibraryUrl(rawUrl, "history");
    const title = safeTitle(rawTitle, url);
    return this.commit(
      (current) => {
        const index = current.history.findIndex((entry) => entry.url === url);
        if (index < 0) return { next: current, result: null };
        if (current.history[index]?.title === title) {
          return { next: current, result: current.history[index] ?? null };
        }
        const entry = { ...current.history[index], title };
        const history = current.history.map((item, itemIndex) =>
          itemIndex === index ? entry : item,
        );
        return { next: bounded({ ...current, history }), result: entry };
      },
      { kind: "history" },
    );
  }

  removeHistoryEntry(id: string): Promise<void> {
    return this.commit(
      (current) => {
        if (!current.history.some((entry) => entry.id === id)) {
          return { next: current, result: undefined };
        }
        return {
          next: { ...current, history: current.history.filter((entry) => entry.id !== id) },
          result: undefined,
        };
      },
      { kind: "history" },
    );
  }

  clearHistory(): Promise<void> {
    return this.commit(
      (current) =>
        current.history.length === 0
          ? { next: current, result: undefined }
          : { next: { ...current, history: [] }, result: undefined },
      { kind: "history" },
    );
  }

  async setBookmark(
    rawUrl: string,
    rawTitle: string,
    bookmarked: boolean,
  ): Promise<BrowserBookmark | null> {
    const url = safeLibraryUrl(rawUrl, "bookmark");
    const title = safeTitle(rawTitle, url);
    return this.commit(
      (current) => {
        const previous = current.bookmarks.find((entry) => entry.url === url);
        if (!bookmarked) {
          if (!previous) return { next: current, result: null };
          return {
            next: { ...current, bookmarks: current.bookmarks.filter((entry) => entry.url !== url) },
            result: null,
          };
        }
        const bookmark: BrowserBookmark = {
          id: previous?.id ?? randomUUID(),
          url,
          title,
          createdAt: previous?.createdAt ?? new Date(this.now()).toISOString(),
        };
        if (previous?.title === bookmark.title) return { next: current, result: previous };
        const bookmarks = [bookmark, ...current.bookmarks.filter((entry) => entry.url !== url)];
        if (bookmarks.length > MAX_BOOKMARKS) {
          throw new Error(browserLibraryErrors.bookmarkLimit(MAX_BOOKMARKS));
        }
        return { next: bounded({ ...current, bookmarks }), result: bookmark };
      },
      { kind: "bookmark", url },
    );
  }

  private async load(): Promise<BrowserLibraryData> {
    if (this.data) return this.data;
    this.loadPromise ??= this.read().catch((error: unknown) => {
      this.loadPromise = null;
      throw error;
    });
    const loaded = await this.loadPromise;
    this.data = loaded;
    return loaded;
  }

  private commit<T>(update: LibraryUpdate<T>, change: BrowserLibraryChange): Promise<T> {
    const operation = this.queueTail.then(async () => {
      const current = await this.load();
      const { next, result } = update(current);
      if (next === current) return result;
      await this.write(next);
      this.data = next;
      this.onChanged(change);
      return result;
    });
    this.queueTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async read(): Promise<BrowserLibraryData> {
    let content: string;
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > MAX_STORED_BYTES) throw new Error(browserLibraryErrors.fileTooLarge());
      content = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return cloneLibrary(EMPTY_LIBRARY);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(browserLibraryErrors.invalidData(), {
        cause: error,
      });
    }
    return parseLibrary(parsed);
  }

  private async write(data: BrowserLibraryData): Promise<void> {
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, "utf8") > MAX_STORED_BYTES) {
      throw new Error(browserLibraryErrors.storageLimit());
    }
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      try {
        await fs.rm(temporary, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Browser library write and cleanup failed.",
        );
      }
      throw error;
    }
  }
}

function matching<T extends { title: string; url: string }>(
  items: T[],
  query: string,
  limit: number,
): T[] {
  if (!query) return items.slice(0, limit);
  const prefix: T[] = [];
  const substring: T[] = [];
  for (const item of items) {
    const url = item.url.toLocaleLowerCase();
    const title = item.title.toLocaleLowerCase();
    if (url.startsWith(query) || title.startsWith(query)) {
      if (prefix.length < limit) prefix.push(item);
    } else if ((url.includes(query) || title.includes(query)) && substring.length < limit) {
      substring.push(item);
    }
  }
  if (prefix.length >= limit) return prefix;
  return prefix.concat(substring.slice(0, limit - prefix.length));
}

function bounded(data: BrowserLibraryData): BrowserLibraryData {
  const history = data.history.slice(0, MAX_HISTORY_ENTRIES);
  const candidate = { ...data, history };
  if (serializedBytes(candidate) <= MAX_STORED_BYTES) return candidate;
  const withoutHistory = { ...data, history: [] };
  if (serializedBytes(withoutHistory) > MAX_STORED_BYTES) {
    throw new Error(browserLibraryErrors.bookmarkStorageFull());
  }
  let low = 0;
  let high = history.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes({ ...data, history: history.slice(0, middle) }) <= MAX_STORED_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { ...data, history: history.slice(0, low) };
}

function parseLibrary(value: unknown): BrowserLibraryData {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error(browserLibraryErrors.unsupportedData());
  }
  if (!Array.isArray(value.history) || !Array.isArray(value.bookmarks)) {
    throw new Error(browserLibraryErrors.invalidData());
  }
  const history = value.history.map(parseHistoryEntry).slice(0, MAX_HISTORY_ENTRIES);
  const bookmarks = value.bookmarks.map(parseBookmark).slice(0, MAX_BOOKMARKS);
  return bounded({ version: 1, history, bookmarks });
}

function parseHistoryEntry(value: unknown): BrowserHistoryEntry {
  if (!isRecord(value)) throw invalidEntry();
  const url = safeLibraryUrl(value.url);
  return {
    id: safeId(value.id),
    url,
    title: safeTitle(value.title, url),
    visitedAt: safeDate(value.visitedAt),
  };
}

function parseBookmark(value: unknown): BrowserBookmark {
  if (!isRecord(value)) throw invalidEntry();
  const url = safeLibraryUrl(value.url);
  return {
    id: safeId(value.id),
    url,
    title: safeTitle(value.title, url),
    createdAt: safeDate(value.createdAt),
  };
}

function safeLibraryUrl(value: unknown, operation?: "history" | "bookmark"): string {
  if (typeof value !== "string") throw invalidEntry();
  if (value.length > MAX_BROWSER_LIBRARY_URL_LENGTH) {
    if (operation === "history") {
      throw new Error(browserLibraryErrors.historyAddressTooLong(MAX_BROWSER_LIBRARY_URL_LENGTH));
    }
    if (operation === "bookmark") {
      throw new Error(browserLibraryErrors.bookmarkAddressTooLong(MAX_BROWSER_LIBRARY_URL_LENGTH));
    }
    throw invalidEntry();
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(browserLibraryErrors.invalidUrl());
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(browserLibraryErrors.unsupportedUrl());
  }
  parsed.username = "";
  parsed.password = "";
  const sanitized = parsed.toString();
  if (sanitized.length > MAX_BROWSER_LIBRARY_URL_LENGTH) throw invalidEntry();
  return sanitized;
}

function safeTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") throw invalidEntry();
  const normalized = value.replace(/\s+/g, " ").trim();
  return (normalized || fallback).slice(0, MAX_TITLE_LENGTH);
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw invalidEntry();
  return value;
}

function safeDate(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw invalidEntry();
  return new Date(value).toISOString();
}

function invalidEntry(): Error {
  return new Error(browserLibraryErrors.invalidEntry());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function cloneLibrary(data: BrowserLibraryData): BrowserLibraryData {
  return { ...data, history: [...data.history], bookmarks: [...data.bookmarks] };
}

function serializedBytes(data: BrowserLibraryData): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

function defaultLibraryPath(): string {
  return path.join(app.getPath("userData"), "browser-library.json");
}
