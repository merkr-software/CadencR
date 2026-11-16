import { describe, expect, it } from "vitest";
import type { Display } from "electron";
import { parseNotchProbe, resolveNotchPlacements } from "./notch-geometry";

function display(
  id: number,
  bounds: { x: number; y: number; width: number; height: number },
  menuBar: number,
  internal: boolean,
): Display {
  return {
    id,
    bounds,
    workArea: { ...bounds, y: bounds.y + menuBar, height: bounds.height - menuBar },
    internal,
  } as Display;
}

const builtIn = display(1, { x: 0, y: 0, width: 2056, height: 1329 }, 39, true);
const external = display(2, { x: 2056, y: -200, width: 2560, height: 1440 }, 25, false);

describe("parseNotchProbe", () => {
  it("keeps only notched screens and derives the cutout", () => {
    const probed = parseNotchProbe(
      JSON.stringify([
        { x: 0, y: 0, width: 2056, height: 1329, top: 38, leftEnd: 918, rightStart: 1138 },
        { x: 2056, y: 89, width: 2560, height: 1440, top: 0, leftEnd: 0, rightStart: 0 },
      ]),
    );
    expect(probed).toEqual([
      { x: 0, y: 0, width: 2056, height: 1329, notchWidth: 220, notchHeight: 38 },
    ]);
  });

  it("rejects unexpected output", () => {
    expect(() => parseNotchProbe('{"nope":1}')).toThrow();
  });
});

describe("resolveNotchPlacements", () => {
  it("hugs the probed hardware notch, matching Cocoa coordinates", () => {
    const [placement] = resolveNotchPlacements(
      [external, builtIn],
      builtIn,
      [{ x: 0, y: 0, width: 2056, height: 1329, notchWidth: 220, notchHeight: 38 }],
      "builtin_always",
    );
    expect(placement).toMatchObject({ notchWidth: 220, notchHeight: 38, hardware: true });
    expect(placement.display.id).toBe(1);
  });

  it("falls back to the menu-bar heuristic when the probe could not run", () => {
    const [placement] = resolveNotchPlacements(
      [external, builtIn],
      external,
      null,
      "builtin_always",
    );
    expect(placement).toMatchObject({ hardware: true, notchHeight: 39 });
    expect(placement.display.id).toBe(1);
  });

  it("draws a virtual notch on the primary display when nothing is notched", () => {
    const [placement] = resolveNotchPlacements([external], external, [], "builtin_always");
    expect(placement).toMatchObject({ hardware: false, notchHeight: 25 });
    expect(placement.display.id).toBe(2);
  });

  it("uses only the primary display even while a built-in notch is connected", () => {
    const [placement] = resolveNotchPlacements([builtIn, external], external, null, "primary");
    expect(placement).toMatchObject({ display: external, hardware: false, notchHeight: 25 });
  });

  it("measures the hardware and virtual islands independently in both mode", () => {
    // With the external display primary, Cocoa's origin moves to its bottom edge.
    const placements = resolveNotchPlacements(
      [external, builtIn],
      external,
      [{ x: 0, y: 111, width: 2056, height: 1329, notchWidth: 220, notchHeight: 38 }],
      "both",
    );
    expect(placements).toMatchObject([
      { display: { id: 1 }, hardware: true, notchWidth: 220, notchHeight: 38 },
      { display: { id: 2 }, hardware: false, notchWidth: 184, notchHeight: 25 },
    ]);
  });

  it("creates only one placement when the built-in display is also primary", () => {
    expect(resolveNotchPlacements([builtIn, external], builtIn, null, "both")).toHaveLength(1);
  });

  it.each(["builtin_always", "both", "primary"] as const)(
    "falls back to one primary island with the lid closed in %s mode",
    (mode) => {
      expect(resolveNotchPlacements([external], external, [], mode)).toMatchObject([
        { display: { id: 2 }, hardware: false },
      ]);
    },
  );

  it("keeps builtin always on an unnotched built-in display", () => {
    const unnotched = display(3, builtIn.bounds, 24, true);
    expect(
      resolveNotchPlacements([unnotched, external], external, [], "builtin_always"),
    ).toMatchObject([{ display: { id: 3 }, hardware: false }]);
  });

  it("measures a hardware notch on the primary display in primary mode", () => {
    expect(resolveNotchPlacements([builtIn, external], builtIn, null, "primary")).toMatchObject([
      { display: { id: 1 }, hardware: true, notchHeight: 39 },
    ]);
  });

  it.each([
    { targetScale: 1, expectedWidth: 440 },
    { targetScale: 2, expectedWidth: 220 },
    { targetScale: 1.5, expectedWidth: 293 },
  ])(
    "matches the cutout's physical width on a $targetScale× display without resizing peeks",
    ({ targetScale, expectedWidth }) => {
      const retina = { ...builtIn, scaleFactor: 2 };
      const target = { ...external, scaleFactor: targetScale };
      const [placement] = resolveNotchPlacements(
        [target, retina],
        target,
        [{ x: 0, y: 111, width: 2056, height: 1329, notchWidth: 220, notchHeight: 38 }],
        "primary",
      );
      expect(placement).toMatchObject({
        display: target,
        compactWidth: expectedWidth,
        notchWidth: 184,
        hardware: false,
      });
    },
  );

  it("keeps the virtual width as the reference when no hardware notch is connected", () => {
    const [placement] = resolveNotchPlacements([external], external, [], "primary");
    expect(placement.compactWidth).toBe(184);
  });
});
