import { describe, expect, it } from "vitest";
import { buildHtmlPreviewDocument, buildSvgPreviewDocument } from "./editor-preview-document";

const hostile = `<html><head><base href="https://evil.test/">
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'">
<script>fetch('http://127.0.0.1:5005/api/remote/pairing-code')</script></head>
<body><img src="https://evil.test/pixel"><iframe src="https://evil.test"></iframe></body></html>`;

describe.each([
  ["HTML", buildHtmlPreviewDocument],
  ["SVG", buildSvgPreviewDocument],
] as const)("%s preview CSP", (_name, build) => {
  it("places its restrictive policy before all untrusted markup", () => {
    const doc = build(hostile);
    const policy = doc.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i)?.[1];
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("worker-src 'none'");
    expect(policy).toContain("img-src data: blob:");
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(doc.indexOf("connect-src 'none'")).toBeLessThan(doc.indexOf(hostile));
    // A later policy can restrict this policy further, but CSP cannot widen it.
    expect(doc).toContain(hostile);
  });
});
