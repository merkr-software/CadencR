import { describe, expect, it } from "vitest";
import {
  getFileExtension,
  getPreviewKind,
  isExcalidrawFile,
  isHtmlFile,
  isImageFile,
  isMarkdownFile,
  isSvgFile,
} from "./file-language";

describe("getFileExtension", () => {
  it("returns the trailing extension, lowercased", () => {
    expect(getFileExtension("README.MD")).toBe("md");
    expect(getFileExtension("src/foo.TSX")).toBe("tsx");
  });

  it("handles paths without extension", () => {
    expect(getFileExtension("Makefile")).toBe("makefile");
  });
});

describe("isMarkdownFile", () => {
  it.each([["notes.md"], ["Docs.MD"], ["page.mdx"]])("treats %s as markdown", (path) => {
    expect(isMarkdownFile(path)).toBe(true);
  });

  it.each([["a.html"], ["a.svg"], ["a.ts"]])("rejects %s", (path) => {
    expect(isMarkdownFile(path)).toBe(false);
  });
});

describe("isHtmlFile", () => {
  it.each([["index.html"], ["page.HTM"]])("treats %s as html", (path) => {
    expect(isHtmlFile(path)).toBe(true);
  });

  it("does not match SVG or XML", () => {
    expect(isHtmlFile("icon.svg")).toBe(false);
    expect(isHtmlFile("data.xml")).toBe(false);
  });
});

describe("isSvgFile", () => {
  it("matches .svg case-insensitively", () => {
    expect(isSvgFile("logo.svg")).toBe(true);
    expect(isSvgFile("LOGO.SVG")).toBe(true);
  });

  it("does not match other extensions", () => {
    expect(isSvgFile("logo.png")).toBe(false);
  });
});

describe("isImageFile", () => {
  it.each([
    ["a.png"],
    ["a.JPG"],
    ["a.jpeg"],
    ["a.gif"],
    ["a.webp"],
    ["a.bmp"],
    ["a.ico"],
    ["a.avif"],
  ])("treats %s as image", (path) => {
    expect(isImageFile(path)).toBe(true);
  });

  it("does not treat svg as image (rendered via SvgPreview, not the image viewer)", () => {
    expect(isImageFile("logo.svg")).toBe(false);
  });

  it.each([["doc.pdf"], ["data.json"], ["script.ts"]])("rejects non-image %s", (path) => {
    expect(isImageFile(path)).toBe(false);
  });
});

describe("isExcalidrawFile", () => {
  it.each([["diagram.excalidraw"], ["Sketch.EXCALIDRAW"], ["a/b/flow.excalidraw"]])(
    "treats %s as an excalidraw scene",
    (path) => {
      expect(isExcalidrawFile(path)).toBe(true);
    },
  );

  it.each([["notes.md"], ["scene.excalidraw.bak"], ["data.json"]])("rejects %s", (path) => {
    expect(isExcalidrawFile(path)).toBe(false);
  });
});

describe("getPreviewKind", () => {
  it("returns the right kind for each preview-capable file", () => {
    expect(getPreviewKind("README.md")).toBe("markdown");
    expect(getPreviewKind("page.mdx")).toBe("markdown");
    expect(getPreviewKind("index.html")).toBe("html");
    expect(getPreviewKind("page.HTM")).toBe("html");
    expect(getPreviewKind("logo.svg")).toBe("svg");
    expect(getPreviewKind("data/export.csv")).toBe("csv");
    expect(getPreviewKind("export.TSV")).toBe("csv");
  });

  it("returns null for files with no preview", () => {
    expect(getPreviewKind("script.ts")).toBeNull();
    expect(getPreviewKind("photo.png")).toBeNull();
    expect(getPreviewKind("Cargo.toml")).toBeNull();
  });
});
