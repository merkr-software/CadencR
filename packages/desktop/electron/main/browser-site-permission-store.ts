import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { z } from "zod";
import { translateUi as t } from "../../src/shared/ui-i18n";
import {
  BROWSER_SITE_PERMISSIONS,
  BROWSER_SITE_PERMISSION_DECISIONS,
  type BrowserSitePermission,
  type BrowserSitePermissionDecision,
} from "./browser-types";

const storedDecisionSchema = z.object({
  partition: z.string().min(1),
  origin: z.url(),
  permission: z.enum(BROWSER_SITE_PERMISSIONS),
  decision: z.enum(BROWSER_SITE_PERMISSION_DECISIONS).exclude(["ask"]),
});

const storedFileSchema = z.object({
  version: z.literal(1),
  decisions: z.array(storedDecisionSchema),
});

type StoredDecision = z.infer<typeof storedDecisionSchema>;

/** Persistent website permission decisions for Normal browser profiles. */
export class BrowserSitePermissionStore {
  private decisions: StoredDecision[] | null = null;

  constructor(private readonly filePath = defaultStorePath()) {}

  get(
    partition: string,
    origin: string,
    permission: BrowserSitePermission,
  ): BrowserSitePermissionDecision {
    return (
      this.load().find(
        (entry) =>
          entry.partition === partition &&
          entry.origin === origin &&
          entry.permission === permission,
      )?.decision ?? "ask"
    );
  }

  set(
    partition: string,
    origin: string,
    permission: BrowserSitePermission,
    decision: BrowserSitePermissionDecision,
  ): void {
    this.setMany(partition, origin, [[permission, decision]]);
  }

  setMany(
    partition: string,
    origin: string,
    updates: ReadonlyArray<readonly [BrowserSitePermission, BrowserSitePermissionDecision]>,
  ): void {
    const updatedPermissions = new Set(updates.map(([permission]) => permission));
    const decisions = this.load().filter(
      (entry) =>
        entry.partition !== partition ||
        entry.origin !== origin ||
        !updatedPermissions.has(entry.permission),
    );
    for (const [permission, decision] of updates) {
      if (decision !== "ask") decisions.push({ partition, origin, permission, decision });
    }
    this.write(decisions);
  }

  deleteOrigin(partition: string, origin: string): void {
    const decisions = this.load().filter(
      (entry) => entry.partition !== partition || entry.origin !== origin,
    );
    this.write(decisions);
  }

  private load(): StoredDecision[] {
    if (this.decisions) return this.decisions;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.decisions = storedFileSchema.parse(parsed).decisions;
    } catch (error) {
      if (isMissingFile(error)) this.decisions = [];
      else
        throw new Error(
          t(
            "workspace.browser.site.readPermissionsFailed",
            "Could not read saved browser site permissions.",
          ),
          { cause: error },
        );
    }
    return this.decisions;
  }

  private write(decisions: StoredDecision[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(storedFileSchema.parse({ version: 1, decisions }), null, 2),
    );
    fs.renameSync(temporaryPath, this.filePath);
    this.decisions = decisions;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === "ENOENT"
  );
}

function defaultStorePath(): string {
  return path.join(app.getPath("userData"), "browser-site-permissions.json");
}
