import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { z } from "zod";
import { isPersistentProfileId } from "./browser-profiles";
import {
  BrowserScopeAggregateFailure,
  BrowserScopeFailure,
  browserErrorMessage,
} from "./browser-scope-failure";

export interface RestorableBrowserTab {
  title: string;
  defaultTitle?: true;
  url: string;
  sessionProfileId: string;
  pinned: boolean;
}

export interface RestorableBrowserScope {
  tabs: RestorableBrowserTab[];
  activeIndex: number;
}

interface PersistedBrowserTabs {
  version: 1;
  scopes: Record<string, RestorableBrowserScope>;
}

const EMPTY_DATA: PersistedBrowserTabs = { version: 1, scopes: {} };
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCOPES = 500;
export const MAX_RESTORABLE_TABS_PER_SCOPE = 100;
const MAX_TITLE_LENGTH = 256;
const MAX_URL_LENGTH = 4096;

const persistedTabSchema = z
  .object({
    title: z.string(),
    defaultTitle: z.literal(true).optional(),
    url: z.string(),
    sessionProfileId: z.string(),
    pinned: z.boolean(),
  })
  .strict()
  .transform((tab, context): RestorableBrowserTab => {
    if (
      !isPersistentProfileId(tab.sessionProfileId) ||
      tab.sessionProfileId === "fresh" ||
      tab.sessionProfileId === "feature"
    ) {
      context.addIssue({ code: "custom", message: "Invalid persistent Browser profile." });
      return z.NEVER;
    }
    const url = safeRestorableUrl(tab.url);
    if (!url) {
      context.addIssue({ code: "custom", message: "Invalid restorable Browser URL." });
      return z.NEVER;
    }
    const title = tab.title.replace(/\s+/g, " ").trim();
    return {
      title: (title || "New tab").slice(0, MAX_TITLE_LENGTH),
      ...(tab.defaultTitle || !title ? { defaultTitle: true as const } : {}),
      url,
      sessionProfileId: tab.sessionProfileId,
      pinned: tab.pinned,
    };
  });

const persistedScopeSchema = z
  .object({
    tabs: z.array(persistedTabSchema).max(MAX_RESTORABLE_TABS_PER_SCOPE),
    activeIndex: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((scope, context) => {
    const valid =
      scope.tabs.length === 0 ? scope.activeIndex === 0 : scope.activeIndex < scope.tabs.length;
    if (!valid) context.addIssue({ code: "custom", message: "Invalid active Browser tab." });
  });

const persistedDataSchema = z
  .object({
    version: z.literal(1),
    scopes: z.record(z.string(), persistedScopeSchema),
  })
  .strict()
  .superRefine((data, context) => {
    if (Object.keys(data.scopes).length > MAX_SCOPES) {
      context.addIssue({ code: "custom", message: "Too many Browser scopes." });
    }
    for (const key of Object.keys(data.scopes)) {
      const scopeId = Number(key);
      if (!isScopeId(scopeId) || String(scopeId) !== key) {
        context.addIssue({ code: "custom", message: "Invalid Browser scope id." });
      }
    }
  });

/** Atomic, serialized storage for normal Browser tabs grouped by feature scope. */
export class BrowserTabSessionStore {
  private data: PersistedBrowserTabs | null = null;
  private loadPromise: Promise<PersistedBrowserTabs> | null = null;
  private queueTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = defaultSessionPath()) {}

  async loadScope(scopeId: number): Promise<RestorableBrowserScope | null> {
    assertScopeId(scopeId);
    const scope = (await this.load()).scopes[String(scopeId)];
    return scope ? cloneScope(scope) : null;
  }

  replaceScope(scopeId: number, scope: RestorableBrowserScope | null): Promise<void> {
    assertScopeId(scopeId);
    return this.enqueue(async () => {
      const current = await this.load();
      const scopes = { ...current.scopes };
      if (!scope || scope.tabs.length === 0) delete scopes[String(scopeId)];
      else scopes[String(scopeId)] = parseScope(scope);
      const next = { version: 1 as const, scopes };
      assertStructuralBounds(next);
      await this.write(next);
      this.data = next;
    });
  }

  flush(): Promise<void> {
    return this.queueTail;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queueTail.then(operation);
    this.queueTail = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<PersistedBrowserTabs> {
    if (this.data) return this.data;
    this.loadPromise ??= this.read().catch((error: unknown) => {
      this.loadPromise = null;
      throw error;
    });
    const loaded = await this.loadPromise;
    this.data = loaded;
    return loaded;
  }

  private async read(): Promise<PersistedBrowserTabs> {
    let content: string;
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > MAX_FILE_BYTES) {
        throw storageLimitError();
      }
      content = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return cloneData(EMPTY_DATA);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new BrowserScopeFailure({ kind: "tabSession", reason: "corrupt" }, { cause: error });
    }
    return parseData(parsed);
  }

  private async write(data: PersistedBrowserTabs): Promise<void> {
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) {
      throw storageLimitError();
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
        throw new BrowserScopeAggregateFailure(
          {
            kind: "tabSession",
            reason: "cleanupFailed",
            diagnostics: [browserErrorMessage(error), browserErrorMessage(cleanupError)],
          },
          [error, cleanupError],
        );
      }
      throw error;
    }
  }
}

function parseData(value: unknown): PersistedBrowserTabs {
  const result = persistedDataSchema.safeParse(value);
  if (!result.success) throw invalidData();
  return cloneData(result.data);
}

function parseScope(value: unknown): RestorableBrowserScope {
  const result = persistedScopeSchema.safeParse(value);
  if (!result.success) throw invalidData();
  return cloneScope(result.data);
}

function safeRestorableUrl(value: string): string | null {
  if (value === "about:blank") return value;
  if (value.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  const sanitized = parsed.toString();
  if (sanitized.length > MAX_URL_LENGTH) return null;
  return sanitized;
}

function assertStructuralBounds(data: PersistedBrowserTabs): void {
  if (Object.keys(data.scopes).length > MAX_SCOPES) {
    throw new BrowserScopeFailure({ kind: "tabSession", reason: "scopeLimit" });
  }
}

function assertScopeId(scopeId: number): void {
  if (!isScopeId(scopeId)) throw new Error("Invalid Browser scope id.");
}

function isScopeId(scopeId: number): boolean {
  return Number.isSafeInteger(scopeId) && scopeId >= 0;
}

function cloneData(data: PersistedBrowserTabs): PersistedBrowserTabs {
  return {
    version: 1,
    scopes: Object.fromEntries(
      Object.entries(data.scopes).map(([key, scope]) => [key, cloneScope(scope)]),
    ),
  };
}

function cloneScope(scope: RestorableBrowserScope): RestorableBrowserScope {
  return { tabs: scope.tabs.map((tab) => ({ ...tab })), activeIndex: scope.activeIndex };
}

function invalidData(): Error {
  return new BrowserScopeFailure({ kind: "tabSession", reason: "invalid" });
}

function storageLimitError(): Error {
  return new BrowserScopeFailure({ kind: "tabSession", reason: "storageLimit" });
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultSessionPath(): string {
  return path.join(app.getPath("userData"), "browser-tabs.json");
}
