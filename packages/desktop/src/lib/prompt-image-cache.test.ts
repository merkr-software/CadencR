// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractPromptBlobs,
  promptImageSrc,
  readPromptBlobBase64,
  resetPromptBlobCacheForTest,
  stashPromptBlob,
} from "./prompt-image-cache";
import { buildUserMessageContent, parseUserMessageContent } from "@/types/agent-types";

// 1×1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let nextObjectUrl = 0;

beforeEach(() => {
  nextObjectUrl = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:mock/${(nextObjectUrl += 1)}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  resetPromptBlobCacheForTest();
  vi.restoreAllMocks();
});

describe("extractPromptBlobs", () => {
  it("replaces base64 image payloads with a resolvable ref", () => {
    const content = buildUserMessageContent("look at this", [
      { base64: PNG_BASE64, fileName: "shot.png", kind: "image", mimeType: "image/png" },
    ]);

    const extracted = extractPromptBlobs(content);

    expect(extracted).not.toContain(PNG_BASE64);
    expect(extracted.length).toBeLessThan(content.length);
    const parsed = parseUserMessageContent(extracted);
    expect(parsed.text).toBe("look at this");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].base64).toBeUndefined();
    expect(promptImageSrc(parsed.images[0])).toBe("blob:mock/1");
  });

  it("moves non-image attachment payloads out too", () => {
    const content = buildUserMessageContent("review this", [
      { base64: "JVBERi0x", fileName: "spec.pdf", kind: "document", mimeType: "application/pdf" },
    ]);

    const parsed = parseUserMessageContent(extractPromptBlobs(content));

    expect(parsed.attachments[0]).toMatchObject({ fileName: "spec.pdf", kind: "document" });
    expect(parsed.attachments[0].base64).toBeUndefined();
    expect(parsed.attachments[0].ref).toEqual(expect.any(String));
  });

  it("is idempotent, so re-hydrating a block does not stash a second copy", () => {
    const content = buildUserMessageContent("look", [
      { base64: PNG_BASE64, fileName: "shot.png", kind: "image", mimeType: "image/png" },
    ]);

    const once = extractPromptBlobs(content);
    const twice = extractPromptBlobs(once);

    expect(twice).toBe(once);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("collapses the same payload seen under two block identities to one entry", () => {
    const first = extractPromptBlobs(
      buildUserMessageContent("live copy", [
        { base64: PNG_BASE64, fileName: "a.png", kind: "image", mimeType: "image/png" },
      ]),
    );
    const second = extractPromptBlobs(
      buildUserMessageContent("persisted copy", [
        { base64: PNG_BASE64, fileName: "a.png", kind: "image", mimeType: "image/png" },
      ]),
    );

    expect(parseUserMessageContent(first).images[0].ref).toBe(
      parseUserMessageContent(second).images[0].ref,
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  // Every PNG shares its first ~24 base64 characters and every JPEG its first
  // ~16, so a head+tail-only fingerprint collapses to `mediaType + length` —
  // two same-sized screenshots would then resolve to each other's pixels.
  it("distinguishes same-length payloads that share a format header", () => {
    const header = PNG_BASE64.slice(0, 40);
    const first = `${header}${"A".repeat(400)}${"Z".repeat(24)}`;
    const second = `${header}${"B".repeat(400)}${"Z".repeat(24)}`;

    const refs = [first, second].map(
      (payload) =>
        parseUserMessageContent(
          extractPromptBlobs(
            buildUserMessageContent("", [
              { base64: payload, fileName: "s.png", kind: "image", mimeType: "image/png" },
            ]),
          ),
        ).images[0].ref,
    );

    expect(refs[0]).not.toBe(refs[1]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("leaves plain text and non-envelope content untouched", () => {
    expect(extractPromptBlobs("just a message")).toBe("just a message");
    expect(extractPromptBlobs('[{"type":"text","text":"hi"}]')).toBe(
      '[{"type":"text","text":"hi"}]',
    );
    expect(extractPromptBlobs('[{"data":')).toBe('[{"data":');
  });

  // `"data"` alone also matches the escaped `\"data\"` a user can type, which
  // would buy a full multi-megabyte parse on every hydration pass forever.
  it("does not parse an envelope whose prose merely mentions data", () => {
    const content = buildUserMessageContent('what does "data" mean here?', []);
    expect(extractPromptBlobs(content)).toBe(content);
  });

  it("keeps the payload inline when object URLs are unavailable", () => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      throw new Error("unreachable");
    });
    // Simulate the capability check failing rather than the call throwing.
    const original = URL.createObjectURL;
    // @ts-expect-error — deliberately removing the API for this assertion.
    URL.createObjectURL = undefined;

    const content = buildUserMessageContent("look", [
      { base64: PNG_BASE64, fileName: "a.png", kind: "image", mimeType: "image/png" },
    ]);
    expect(extractPromptBlobs(content)).toBe(content);

    URL.createObjectURL = original;
  });
});

describe("readPromptBlobBase64", () => {
  it("round-trips a stashed payload so a prompt can be re-sent", async () => {
    const ref = stashPromptBlob("image/png", PNG_BASE64);
    expect(ref).not.toBeNull();

    await expect(readPromptBlobBase64(ref as string)).resolves.toBe(PNG_BASE64);
  });

  it("resolves undefined for a ref that is no longer cached", async () => {
    await expect(readPromptBlobBase64("missing")).resolves.toBeUndefined();
  });
});

describe("promptImageSrc", () => {
  it("falls back to an inline data URL when the payload was never off-loaded", () => {
    expect(promptImageSrc({ mediaType: "image/png", base64: PNG_BASE64 })).toBe(
      `data:image/png;base64,${PNG_BASE64}`,
    );
  });

  it("returns null for an evicted ref so the caller can show a placeholder", () => {
    expect(promptImageSrc({ mediaType: "image/png", ref: "gone" })).toBeNull();
  });
});
