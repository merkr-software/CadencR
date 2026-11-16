// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { resolveGateSurface } from "@/lib/pending-gate-surface";

function icon(featureId: number, surface: string, host: HTMLElement = document.body): void {
  const el = document.createElement("button");
  el.setAttribute("data-gate-trigger", "");
  el.setAttribute("data-gate-feature-id", String(featureId));
  el.setAttribute("data-gate-surface", surface);
  host.appendChild(el);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("resolveGateSurface", () => {
  it("prefers the first listed surface that renders the conversation", () => {
    icon(7, "tree");
    icon(7, "for-me");
    expect(resolveGateSurface(7, ["for-me", "tree"])).toBe("for-me");
    expect(resolveGateSurface(7, [null, "rail", "tree"])).toBe("tree");
  });

  it("falls back to any surface that renders it, then to the sheet", () => {
    icon(7, "tree");
    expect(resolveGateSurface(7, ["rail"])).toBe("tree");
    expect(resolveGateSurface(8, ["tree"])).toBe("sheet");
  });

  it("ignores rows of a collapsed (inert) sidebar", () => {
    const inert = document.createElement("aside");
    inert.setAttribute("inert", "");
    document.body.appendChild(inert);
    icon(7, "tree", inert);
    expect(resolveGateSurface(7, ["tree"])).toBe("sheet");
  });
});
