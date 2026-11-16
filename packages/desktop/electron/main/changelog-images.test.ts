import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getVersion: () => "0.1.0" } }));

import { fetchChangelogImage, resolveChangelogImageUrl } from "./changelog-images";

const RAW = "https://raw.githubusercontent.com/merkr-software/cadencr";

describe("resolveChangelogImageUrl", () => {
  it.each([
    [`${RAW}/v0.14.0/docs/changelog/shot.png`, `${RAW}/v0.14.0/docs/changelog/shot.png`],
    [
      "https://github.com/merkr-software/cadencr/blob/v0.14.0/docs/changelog/shot.png?raw=true",
      `${RAW}/v0.14.0/docs/changelog/shot.png`,
    ],
    [
      "https://github.com/merkr-software/cadencr/raw/main/docs/changelog/shot.png",
      `${RAW}/main/docs/changelog/shot.png`,
    ],
    ["https://raw.githubusercontent.com/Merkr-Software/Cadencr/main/a.png", `${RAW}/main/a.png`],
  ])("maps %s to the raw file", (src, expected) => {
    expect(resolveChangelogImageUrl(src)).toBe(expected);
  });

  it.each([
    ["another repository", "https://raw.githubusercontent.com/someone/else/main/a.png"],
    ["another host", "https://example.com/merkr-software/cadencr/main/a.png"],
    [
      "a look-alike host",
      "https://raw.githubusercontent.com.evil.dev/merkr-software/cadencr/main/a.png",
    ],
    ["plain http", "http://raw.githubusercontent.com/merkr-software/cadencr/main/a.png"],
    ["credentials", "https://user:pw@raw.githubusercontent.com/merkr-software/cadencr/main/a.png"],
    ["a traversal out of the repo", `${RAW}/../../someone/else/main/a.png`],
    ["a github.com page that isn't a file", "https://github.com/merkr-software/cadencr/issues/1"],
    ["a ref with no path", `${RAW}/main`],
    ["a relative path", "docs/changelog/shot.png"],
  ])("rejects %s", (_label, src) => {
    expect(resolveChangelogImageUrl(src)).toBeNull();
  });
});

describe("fetchChangelogImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(() => Promise.resolve(response));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("returns the bytes and type of a repository image without following redirects", async () => {
    const fetchMock = stubFetch(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } }),
    );

    const image = await fetchChangelogImage(`${RAW}/v1/fresh.png`);

    expect(image.mimeType).toBe("image/png");
    expect([...image.data]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${RAW}/v1/fresh.png`,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("refuses sources outside the repository without touching the network", async () => {
    const fetchMock = stubFetch(new Response(null));

    await expect(fetchChangelogImage("https://example.com/a.png")).rejects.toThrow(
      "Only images committed to the merkr-software/cadencr repository can be shown.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing file with its HTTP status", async () => {
    stubFetch(new Response("404: Not Found", { status: 404 }));

    await expect(fetchChangelogImage(`${RAW}/v1/missing.png`)).rejects.toThrow(
      "GitHub returned HTTP 404 for this image.",
    );
  });

  it("refuses an image whose declared size is over the limit", async () => {
    stubFetch(
      new Response("x", {
        headers: { "Content-Type": "image/png", "Content-Length": String(11 * 1024 * 1024) },
      }),
    );

    await expect(fetchChangelogImage(`${RAW}/v1/huge.png`)).rejects.toThrow(
      "Image is too large to display.",
    );
  });

  it("stops reading an undeclared body once it passes the limit", async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    stubFetch(new Response(body, { headers: { "Content-Type": "image/png" } }));

    await expect(fetchChangelogImage(`${RAW}/v1/endless.png`)).rejects.toThrow(
      "Image is too large to display.",
    );
    expect(pulls).toBeLessThan(5);
  });

  it("rejects a file that isn't an image", async () => {
    stubFetch(new Response("<html>", { headers: { "Content-Type": "text/html" } }));

    await expect(fetchChangelogImage(`${RAW}/v1/page.html`)).rejects.toThrow(
      "Unsupported image type: text/html.",
    );
  });
});
