import { describe, expect, it } from "vitest";
import { CLI_REQUEST_FLAG, parseCliRequestArgv } from "./cli-request";

const flag = (json: unknown): string => `${CLI_REQUEST_FLAG}=${JSON.stringify(json)}`;

describe("parseCliRequestArgv", () => {
  it("returns null for a normal launch", () => {
    expect(parseCliRequestArgv(["/Applications/Cadencr.app/Contents/MacOS/Cadencr"])).toBeNull();
  });

  it("finds the request among switches Chromium adds around it", () => {
    const argv = [
      "/opt/Cadencr/cadencr",
      "--no-sandbox",
      flag({ version: 1, action: "open", path: "/repo/src/main.rs", line: 12 }),
      "--allow-file-access-from-files",
    ];
    expect(parseCliRequestArgv(argv)).toEqual({
      ok: true,
      request: { version: 1, action: "open", path: "/repo/src/main.rs", line: 12 },
    });
  });

  it.each([
    { version: 1, action: "focus" },
    { version: 1, action: "open", path: "/repo" },
    { version: 1, action: "add", path: "/repo" },
    { version: 1, action: "update" },
  ])("accepts %j", (request) => {
    expect(parseCliRequestArgv(["app", flag(request)])).toEqual({ ok: true, request });
  });

  it.each([
    ["an unknown version", { version: 2, action: "focus" }],
    ["an unknown action", { version: 1, action: "delete" }],
    ["a relative path", { version: 1, action: "open", path: "src/main.rs" }],
    ["a zero line", { version: 1, action: "open", path: "/repo/a.ts", line: 0 }],
    ["a fractional line", { version: 1, action: "open", path: "/repo/a.ts", line: 1.5 }],
    ["an extra field", { version: 1, action: "update", force: true }],
    ["a missing path", { version: 1, action: "add" }],
  ])("refuses %s", (_label, request) => {
    const parsed = parseCliRequestArgv(["app", flag(request)]);
    expect(parsed?.ok).toBe(false);
    if (parsed && !parsed.ok) expect(parsed.message).toMatch(/does not understand/);
  });

  it("reports unreadable JSON", () => {
    const parsed = parseCliRequestArgv(["app", `${CLI_REQUEST_FLAG}={not json`]);
    expect(parsed).toMatchObject({ ok: false, message: expect.stringMatching(/unreadable/) });
  });
});
