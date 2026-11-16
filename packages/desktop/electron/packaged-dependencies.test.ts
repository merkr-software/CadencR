import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

// electron-builder copies every `dependencies` entry, with its whole tree, into
// app.asar. Renderer libraries are bundled by Vite and belong in
// devDependencies: celeritty + streamdown (→ mermaid, cytoscape, katex) once
// grew the asar from ~2 MB to 129 MB. Only what the main process loads at
// runtime may live here.
const MAIN_PROCESS_RUNTIME_DEPENDENCIES = [
  // Read via require.resolve in electron/main/splash.ts.
  "@fontsource-variable/figtree",
  "dotenv",
  "electron-updater",
];

describe("packaged dependencies", () => {
  it("ships only main-process runtime dependencies in the asar", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(MAIN_PROCESS_RUNTIME_DEPENDENCIES);
  });
});
