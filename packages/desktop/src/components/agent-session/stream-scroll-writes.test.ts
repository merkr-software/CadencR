import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

/** Every module that moves the agent stream's scroll position, writer excepted. */
const STREAM_SCROLL_MODULES = [
  ...readdirSync(__dirname)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => path.join(__dirname, name)),
  path.join(SRC, "components/AgentStream.tsx"),
  path.join(SRC, "hooks/useConversationSearch.ts"),
  path.join(SRC, "lib/conversation-search/highlight.ts"),
].filter((file) => !file.endsWith("stream-scroll-writer.ts"));

/** A method call on anything but the writer (`writer.x(` / `streamScrollWriterFor(el).x(`). */
function callOutsideWriter(method: string): RegExp {
  return new RegExp(`(?<!(?:writer|streamScrollWriterFor\\(\\w+\\)))\\??\\.${method}\\(`);
}

/** Raw ways to move a scroller, outside the writer. */
const RAW_WRITES: ReadonlyArray<[string, RegExp]> = [
  ["scrollTop assignment", /\.scrollTop\s*(?:[-+]?=)(?!=)/],
  ["scrollTo call", callOutsideWriter("scrollTo")],
  ["scrollBy call", callOutsideWriter("scrollBy")],
  ["scrollToIndex call", callOutsideWriter("scrollToIndex")],
  ["scrollBy override", /defineProperty\([^)]*["']scrollBy["']/],
];

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("agent stream scroll writes", () => {
  it("all go through StreamScrollWriter, which knows their intent", () => {
    const offenders: string[] = [];
    for (const file of STREAM_SCROLL_MODULES) {
      const code = codeOnly(readFileSync(file, "utf8"));
      for (const [label, pattern] of RAW_WRITES) {
        if (pattern.test(code)) offenders.push(`${path.relative(SRC, file)}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
