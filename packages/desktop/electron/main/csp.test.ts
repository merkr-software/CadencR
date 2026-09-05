import { describe, expect, it } from "vitest";
import { rendererCsp, resolveRendererCspDevelopment } from "./csp";

describe("rendererCsp", () => {
  it("uses a hardened production policy", () => {
    const csp = rendererCsp(true);

    expect(csp).toContain("script-src 'self'");
    const scriptSrcLine = csp.split("; ").find((line) => line.startsWith("script-src"));
    expect(scriptSrcLine).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("127.0.0.1:5005");
    expect(csp).not.toContain("127.0.0.1:1420");
    expect(csp).toContain("http://127.0.0.1:5004");
    expect(csp).toContain("object-src 'none'");
  });

  it("allows Vite dev endpoints only for development", () => {
    const csp = rendererCsp(false);

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("http://127.0.0.1:5005");
    expect(csp).toContain("ws://127.0.0.1:1420");
  });

  it("allows the configured development endpoints instead of the default ports", () => {
    const development = resolveRendererCspDevelopment({
      VITE_API_URL: "http://127.0.0.1:5100",
      VITE_FRONTEND_PORT: "1421",
    });
    const csp = rendererCsp(false, development);

    expect(development.frontendPort).toBe(1421);
    expect(csp).toContain("http://127.0.0.1:5100");
    expect(csp).toContain("ws://127.0.0.1:5100");
    expect(csp).toContain("http://127.0.0.1:1421");
    expect(csp).toContain("ws://127.0.0.1:1421");
    expect(csp).not.toContain("127.0.0.1:5005");
    expect(csp).not.toContain("127.0.0.1:1420");
  });

  it("ignores configured development endpoints in production", () => {
    const csp = rendererCsp(true, {
      apiUrl: "https://api.example.com",
      rendererUrl: "https://app.example.com",
    });

    expect(csp).not.toContain("example.com");
    expect(csp).toContain("http://127.0.0.1:5004");
  });

  it("allows wasm execution when packaged", () => {
    const csp = rendererCsp(true);
    expect(csp).toContain("'wasm-unsafe-eval'");
  });

  it("allows wasm execution in development", () => {
    const csp = rendererCsp(false, {
      apiUrl: "http://127.0.0.1:5005",
      rendererUrl: "http://127.0.0.1:1420",
    });
    expect(csp).toContain("'wasm-unsafe-eval'");
  });

  it("allows data: URIs in connect-src for celeritty's inlined wasm fetch", () => {
    const packaged = rendererCsp(true);
    const dev = rendererCsp(false, {
      apiUrl: "http://127.0.0.1:5005",
      rendererUrl: "http://127.0.0.1:1420",
    });
    const connectSrcLine = (csp: string) =>
      csp.split("; ").find((line) => line.startsWith("connect-src"));

    expect(connectSrcLine(packaged)).toContain("data:");
    expect(connectSrcLine(dev)).toContain("data:");
  });

  it("keeps the packaged script-src free of unsafe-eval and unsafe-inline", () => {
    // wasm-unsafe-eval is a narrower grant than unsafe-eval: it only allows
    // compiling WebAssembly, not evaluating arbitrary JS strings. Losing this
    // assertion would silently widen the packaged CSP.
    const csp = rendererCsp(true);
    const scriptSrcLine = csp.split("; ").find((line) => line.startsWith("script-src"));
    expect(scriptSrcLine).not.toContain("'unsafe-eval'");
    expect(scriptSrcLine).not.toContain("'unsafe-inline'");
  });
});
