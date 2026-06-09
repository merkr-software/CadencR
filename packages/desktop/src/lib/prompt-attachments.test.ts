import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ACCEPT,
  classifyAttachment,
  decodeBase64Utf8,
  formatTextAttachmentsForPrompt,
  getExtension,
} from "./prompt-attachments";

describe("classifyAttachment", () => {
  it("classifies images by MIME type", () => {
    expect(classifyAttachment("x", "image/png")).toEqual({ kind: "image", mimeType: "image/png" });
    expect(classifyAttachment("x", "image/webp")).toEqual({
      kind: "image",
      mimeType: "image/webp",
    });
  });

  it("classifies images by extension when MIME is missing", () => {
    expect(classifyAttachment("photo.JPG")).toEqual({ kind: "image", mimeType: "image/jpeg" });
  });

  it.each([["data.csv"], ["sheet.tsv"], ["notes.MD"], ["config.json"], ["log.txt"]])(
    "classifies %s as text",
    (name) => {
      expect(classifyAttachment(name)).toEqual({ kind: "text" });
    },
  );

  it("treats CSV as text regardless of the browser MIME guess", () => {
    expect(classifyAttachment("data.csv", "application/vnd.ms-excel")).toEqual({ kind: "text" });
    expect(classifyAttachment("data.csv", "text/csv")).toEqual({ kind: "text" });
  });

  it("falls back to text for any text/* MIME", () => {
    expect(classifyAttachment("noext", "text/plain")).toEqual({ kind: "text" });
  });

  it("rejects unsupported files", () => {
    expect(classifyAttachment("doc.pdf", "application/pdf")).toEqual({ kind: "unsupported" });
    expect(classifyAttachment("archive.zip")).toEqual({ kind: "unsupported" });
  });
});

describe("getExtension", () => {
  it("returns the lowercased trailing extension", () => {
    expect(getExtension("A.CSV")).toBe("csv");
    expect(getExtension("noext")).toBe("noext");
  });
});

describe("ATTACHMENT_ACCEPT", () => {
  it("includes image MIME types and text extensions", () => {
    expect(ATTACHMENT_ACCEPT).toContain("image/png");
    expect(ATTACHMENT_ACCEPT).toContain(".csv");
    expect(ATTACHMENT_ACCEPT).toContain(".tsv");
  });
});

describe("decodeBase64Utf8", () => {
  it("decodes UTF-8 content", () => {
    // "a,é\n1,2" encoded as UTF-8 base64.
    const base64 = btoa(String.fromCharCode(...new TextEncoder().encode("a,é\n1,2")));
    expect(decodeBase64Utf8(base64)).toBe("a,é\n1,2");
  });
});

describe("formatTextAttachmentsForPrompt", () => {
  it("returns the text unchanged when there are no files", () => {
    expect(formatTextAttachmentsForPrompt("hello", [])).toBe("hello");
  });

  it("appends each file as a fenced block labelled with its name", () => {
    const out = formatTextAttachmentsForPrompt("summarize this", [
      { fileName: "data.csv", text: "a,b\n1,2" },
    ]);
    expect(out).toBe("summarize this\n\nAttached file `data.csv`:\n```csv\na,b\n1,2\n```");
  });

  it("drops empty typed text and still includes the file", () => {
    const out = formatTextAttachmentsForPrompt("", [{ fileName: "x.txt", text: "hi" }]);
    expect(out).toBe("Attached file `x.txt`:\n```txt\nhi\n```");
  });

  it("grows the fence so backticks in content can't break out", () => {
    const out = formatTextAttachmentsForPrompt("", [{ fileName: "x.md", text: "```\ncode\n```" }]);
    expect(out).toContain("````md\n```\ncode\n```\n````");
  });
});
