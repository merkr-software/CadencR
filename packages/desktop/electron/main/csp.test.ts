import { describe, expect, it } from "vitest";
import { rendererCsp, rendererDevelopmentHeaders, resolveRendererCspDevelopment } from "./csp";

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

  it("frames only the service's HTTP origins (the visual sandbox shell)", () => {
    const frameSrc = (csp: string) => csp.split("; ").find((line) => line.startsWith("frame-src"));

    expect(frameSrc(rendererCsp(true))).toBe("frame-src http://127.0.0.1:5004");
    const development = frameSrc(rendererCsp(false));
    expect(development).toContain("http://127.0.0.1:5005");
    expect(development).not.toContain("ws:");
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

  it("sends anti-framing response headers while preserving the complete generated development policy", () => {
    const development = resolveRendererCspDevelopment({
      VITE_API_URL: "http://127.0.0.1:5106",
      VITE_FRONTEND_PORT: "1427",
    });
    const headers = rendererDevelopmentHeaders(development);
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Content-Security-Policy"]).toBe(rendererCsp(false, development));
    const directives = headers["Content-Security-Policy"].split("; ");
    expect(directives.filter((value) => value.startsWith("frame-ancestors"))).toEqual([
      "frame-ancestors 'none'",
    ]);
    expect(directives.find((value) => value.startsWith("connect-src"))).toContain(
      "ws://127.0.0.1:1427",
    );
    expect(directives.find((value) => value.startsWith("script-src"))).toContain(
      "'wasm-unsafe-eval'",
    );
    expect(directives).toContain("object-src 'none'");
  });

  it("ignores configured development endpoints in production", () => {
    const csp = rendererCsp(true, {
      apiUrl: "https://api.example.com",
      rendererUrl: "https://app.example.com",
    });

    expect(csp).not.toContain("example.com");
    expect(csp).toContain("http://127.0.0.1:5004");
  });

  it("allows same-origin and blob: workers without loosening script-src", () => {
    const csp = rendererCsp(true);
    expect(csp).toContain("worker-src 'self' blob:");
    const scriptSrcLine = csp.split("; ").find((line) => line.startsWith("script-src"));
    expect(scriptSrcLine).not.toContain("blob:");
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
