import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, themeToCss, themeVariables } from "./theme.js";
import { connected, flush } from "./test-utils.js";
import { createThemeSnapshot } from "./testing/index.js";

const root = () => document.documentElement;

afterEach(() => {
  root().removeAttribute("style");
  root().removeAttribute("data-appearance");
  root().removeAttribute("data-cadencr-theme");
});

describe("theme application", () => {
  it("writes tokens, appearance and color-scheme onto <html>", () => {
    applyTheme(createThemeSnapshot({ tokens: { background: "#111111", "chart-1": "#00ff00" } }));
    expect(root().style.getPropertyValue("--cadencr-background")).toBe("#111111");
    expect(root().style.getPropertyValue("--cadencr-chart-1")).toBe("#00ff00");
    expect(root().dataset.appearance).toBe("dark");
    expect(root().dataset.cadencrTheme).toBe("cadencr-dark");
    expect(root().style.colorScheme).toBe("dark");

    applyTheme(
      createThemeSnapshot({ id: "light", appearance: "light", tokens: { background: "#fff" } }),
    );
    expect(root().style.getPropertyValue("--cadencr-background")).toBe("#fff");
    expect(root().style.getPropertyValue("--cadencr-chart-1")).toBe("");
    expect(root().dataset.appearance).toBe("light");
    expect(root().style.colorScheme).toBe("light");
  });

  it("refuses token names and values that could escape a declaration", () => {
    const theme = createThemeSnapshot({
      tokens: { ok: "red", "Bad Name": "red", evil: "red; } body { display:none" },
    });
    expect(themeVariables(theme)).toEqual({ "--cadencr-ok": "red" });
    expect(themeToCss(theme)).toBe(":root {\n  color-scheme: dark;\n  --cadencr-ok: red;\n}\n");
  });

  it("applies the handshake theme and every change unless disabled", async () => {
    const { host, client } = await connected();
    expect(root().style.getPropertyValue("--cadencr-primary")).toBe("#2db47d");
    host.setTheme(createThemeSnapshot({ tokens: { primary: "#087653" }, appearance: "light" }));
    await flush();
    expect(root().style.getPropertyValue("--cadencr-primary")).toBe("#087653");
    expect(root().dataset.appearance).toBe("light");
    client.close();
    host.close();
  });

  it("leaves the document alone with applyTheme: false", async () => {
    const { host, client } = await connected({}, { applyTheme: false });
    expect(root().style.getPropertyValue("--cadencr-primary")).toBe("");
    client.close();
    host.close();
  });
});
