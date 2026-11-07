import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * Older builds recorded every visited origin in `browser-origins.json` for
 * address-bar suggestions; the library's history replaced them and nothing
 * reads the file any more. It still holds browsing history, so clearing
 * history removes it as well.
 */
export async function removeLegacyOriginHistory(
  filePath: string = path.join(app.getPath("userData"), "browser-origins.json"),
): Promise<void> {
  await fs.rm(filePath, { force: true });
}
