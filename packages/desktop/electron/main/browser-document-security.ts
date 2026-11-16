import type { WebContents } from "electron";

const revisions = new WeakMap<WebContents, number>();

export function browserDocumentRevision(contents: WebContents): number {
  return revisions.get(contents) ?? 0;
}

export function invalidateBrowserDocument(contents: WebContents): void {
  revisions.set(contents, browserDocumentRevision(contents) + 1);
}

/** Prevent Electron's deferred execution from running a script in a replacement page. */
export function executeBrowserScript(contents: WebContents, script: string): Promise<unknown> {
  const expectedUrl = JSON.stringify(contents.getURL());
  return contents.executeJavaScript(
    `if (location.href !== ${expectedUrl}) { throw new Error("Browser page changed before script execution."); }\n${script}`,
    true,
  );
}
