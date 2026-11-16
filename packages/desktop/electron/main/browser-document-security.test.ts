import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { executeBrowserScript } from "./browser-document-security";

it("blocks a deferred script before it can mutate a replacement document", async () => {
  let queuedScript = "";
  const wc = {
    getURL: () => "http://localhost:3000/",
    executeJavaScript: vi.fn(async (script: string) => {
      queuedScript = script;
      return undefined;
    }),
  } as unknown as Electron.WebContents;
  await executeBrowserScript(wc, "globalThis.secretRead = true; 42");
  const replacement = {
    location: { href: "file:///private/secret.txt" },
    globalThis: { location: { href: "http://localhost:3000/" } },
    secretRead: false,
  };
  expect(() => vm.runInNewContext(queuedScript, replacement)).toThrow("page changed");
  expect(replacement.secretRead).toBe(false);
});

describe("script completion values", () => {
  it("retains ordinary JavaScript completion values on the authorized page", async () => {
    const page = { location: { href: "http://localhost:3000/" } };
    const wc = {
      getURL: () => page.location.href,
      executeJavaScript: vi.fn(
        async (script: string) => vm.runInNewContext(script, page) as unknown,
      ),
    } as unknown as Electron.WebContents;
    await expect(executeBrowserScript(wc, "const answer = 40; answer + 2")).resolves.toBe(42);
  });
});
