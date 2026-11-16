import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentApiBaseUrl } from "./runtime-origin";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("development API transport origin", () => {
  it("uses the configured sidecar when window exists without a browser location", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("location", undefined);
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:6123/");
    expect(developmentApiBaseUrl()).toBe("http://127.0.0.1:6123");
  });

  it("uses the HTTP browser origin for the authenticated Vite proxy", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("location", { protocol: "http:", origin: "http://127.0.0.1:1427" });
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:5106");
    expect(developmentApiBaseUrl()).toBe("http://127.0.0.1:1427");
  });

  it("keeps Electron's sidecar fallback separate from browser proxy selection", () => {
    vi.stubGlobal("window", { cadencr: {} });
    vi.stubGlobal("location", { protocol: "http:", origin: "http://127.0.0.1:1427" });
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:5106");
    expect(developmentApiBaseUrl()).toBe("http://127.0.0.1:5106");
  });
});
