import { describe, expect, it } from "vitest";
import { isMainRendererFrame, matchesRendererTarget } from "./renderer-trust";

const target = { kind: "url", value: "http://127.0.0.1:1427/" } as const;
const frame = { processId: 9, routingId: 11, url: target.value };

describe("renderer document capabilities", () => {
  it("uses the exact configured dev origin, including its port and hostname", () => {
    expect(matchesRendererTarget("http://127.0.0.1:1427/projects/1", target)).toBe(true);
    for (const url of [
      "http://127.0.0.1:1428/",
      "http://localhost:1427/",
      "http://127.0.0.2:1427/",
      "https://127.0.0.1:1427/",
      "http://user@127.0.0.1:1427/",
      "https://evil.example/",
    ])
      expect(matchesRendererTarget(url, target), url).toBe(false);
  });

  it("allows only the packaged index path, never arbitrary file documents", () => {
    const packaged = { kind: "file", value: "/Applications/Cadencr/renderer/index.html" } as const;
    expect(
      matchesRendererTarget("file:///Applications/Cadencr/renderer/index.html#/settings", packaged),
    ).toBe(true);
    for (const url of [
      "file:///tmp/evil.html",
      "file:///Applications/Cadencr/renderer/notch.html",
      "file://host/Applications/Cadencr/renderer/index.html",
      "file:///Applications/Cadencr/renderer/index.html/evil",
    ])
      expect(matchesRendererTarget(url, packaged), url).toBe(false);
  });

  it("fails closed for missing, foreign, child and navigated frames", () => {
    expect(isMainRendererFrame(frame, frame, target)).toBe(true);
    for (const sender of [
      null,
      undefined,
      { ...frame, routingId: 12 },
      { ...frame, processId: 10 },
      { ...frame, url: "https://evil.example" },
    ]) {
      expect(isMainRendererFrame(sender, frame, target)).toBe(false);
    }
    expect(isMainRendererFrame(frame, { ...frame, url: "https://evil.example" }, target)).toBe(
      false,
    );
  });
});
