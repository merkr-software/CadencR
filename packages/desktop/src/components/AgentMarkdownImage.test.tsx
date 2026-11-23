import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";
import { render } from "@/test-utils";
import { Markdown } from "@/components/Markdown";
import { useImageLightboxStore } from "@/stores/image-lightbox-store";
import { AgentImageScope, isLocalImageSource } from "./AgentMarkdownImage";

const mocks = vi.hoisted(() => ({
  customInstance: vi.fn(),
  createObjectURL: vi.fn(() => "blob:agent-image"),
  revokeObjectURL: vi.fn(),
}));

vi.mock("@/api/client", () => ({ customInstance: mocks.customInstance }));

beforeEach(() => {
  mocks.customInstance.mockReset();
  mocks.customInstance.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: mocks.createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: mocks.revokeObjectURL,
  });
});

afterEach(() => {
  useImageLightboxStore.getState().close();
  useImageLightboxStore.setState({ open: false, images: [], index: 0 });
});

/** A service error as the client interceptor hands it on: body already decoded. */
function serviceError(status: number, code: string, error: string): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    config,
    null,
    {
      data: { error, code },
      status,
      statusText: "",
      headers: {},
      config,
    },
  );
}

function renderChat(markdown: string) {
  return render(
    <AgentImageScope featureId={7}>
      <Markdown content={markdown} />
    </AgentImageScope>,
  );
}

function requestedSources(): unknown[] {
  return mocks.customInstance.mock.calls.map(([config]) => config.params?.src);
}

describe("agent chat images", () => {
  it("loads a screenshot posted by absolute path through the service, not off the page origin", async () => {
    // Over remote access `/tmp/…` would resolve against the service origin;
    // the element must only ever see the object URL.
    renderChat("QA done:\n\n![After the fix](/tmp/qa/after.png)");

    const image = await screen.findByAltText("After the fix");
    expect(image).toHaveAttribute("src", "blob:agent-image");
    expect(mocks.customInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/api/features/7/agent-image",
        params: { src: "/tmp/qa/after.png" },
        responseType: "blob",
      }),
    );
  });

  it("hands relative and percent-encoded sources to the service as the renderer received them", async () => {
    renderChat("![rel](docs/qa/shot.png)\n\n![spaced](</tmp/qa/my shot.png>)");

    await screen.findByAltText("rel");
    await screen.findByAltText("spaced");
    expect(requestedSources()).toEqual(
      expect.arrayContaining(["docs/qa/shot.png", "/tmp/qa/my%20shot.png"]),
    );
  });

  it("names a missing screenshot with the service's reason, and does not retry it", async () => {
    mocks.customInstance.mockRejectedValue(
      serviceError(404, "NOT_FOUND", "Not found: /tmp/qa/gone.png"),
    );

    renderChat("![Gone](/tmp/qa/gone.png)");

    const notice = await screen.findByTitle("Not found: /tmp/qa/gone.png");
    expect(notice).toHaveTextContent("Gone");
    expect(screen.queryByRole("img")).toBeNull();
    expect(mocks.customInstance).toHaveBeenCalledTimes(1);
  });

  it("retries once when the message showing the image was not persisted yet", async () => {
    mocks.customInstance
      .mockRejectedValueOnce(serviceError(403, "IMAGE_NOT_REFERENCED", "Not referenced"))
      .mockResolvedValueOnce(new Blob(["png"], { type: "image/png" }));

    renderChat("![Fresh](/tmp/qa/fresh.png)");

    expect(await screen.findByAltText("Fresh", {}, { timeout: 2000 })).toHaveAttribute(
      "src",
      "blob:agent-image",
    );
    expect(mocks.customInstance).toHaveBeenCalledTimes(2);
  });

  it("leaves web images and non-image files to a plain element, without a request", () => {
    renderChat("![Remote](https://example.com/a.png)\n\n![Notes](notes.txt)");

    expect(screen.getByAltText("Remote")).toHaveAttribute("src", "https://example.com/a.png");
    expect(screen.getByAltText("Notes")).toHaveAttribute("src", "notes.txt");
    expect(screen.queryByRole("button", { name: /Full screen/ })).toBeNull();
    expect(mocks.customInstance).not.toHaveBeenCalled();
  });

  it("opens a loaded local agent image full screen in the lightbox and releases its blob on close", async () => {
    let urlSeq = 0;
    mocks.createObjectURL.mockImplementation(() => `blob:agent-image-${++urlSeq}`);
    const view = renderChat("![After the fix](/tmp/qa/my%20shot.png)");

    await screen.findByAltText("After the fix");
    fireEvent.click(screen.getByRole("button", { name: "Full screen: After the fix" }));

    const state = useImageLightboxStore.getState();
    expect(state.open).toBe(true);
    expect(state.images).toHaveLength(1);
    expect(state.images[0]).toMatchObject({
      alt: "After the fix",
      fileName: "my shot.png",
      mediaType: "image/png",
      src: "blob:agent-image-2",
    });
    expect(state.images[0]?.blob).toBeUndefined();

    // Unmounting the virtualized row revokes the inline URL, not the lightbox's own URL.
    view.unmount();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:agent-image-1");
    expect(mocks.revokeObjectURL).not.toHaveBeenCalledWith("blob:agent-image-2");

    useImageLightboxStore.getState().close();
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:agent-image-2");
    expect(useImageLightboxStore.getState().images).toEqual([]);
  });

  it("opens an inline data URL image full screen with its MIME type", () => {
    const dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/";
    renderChat(`![Inline chart](${dataUrl})`);

    fireEvent.click(screen.getByRole("button", { name: "Full screen: Inline chart" }));

    const state = useImageLightboxStore.getState();
    expect(state.open).toBe(true);
    expect(state.images[0]).toMatchObject({
      src: dataUrl,
      alt: "Inline chart",
      mediaType: "image/jpeg",
    });
  });

  it("hides the floating expand pill on short/tiny images while keeping them clickable", async () => {
    renderChat("![Short badge](/tmp/qa/banner.png)");

    const img = await screen.findByAltText("Short badge");
    const button = screen.getByRole("button", { name: "Full screen: Short badge" });
    expect(button.querySelector("svg")).not.toBeNull();

    Object.defineProperty(img, "naturalWidth", { value: 110, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 20, configurable: true });
    fireEvent.load(img);
    expect(button.querySelector("svg")).toBeNull();
  });

  it("drops the fullscreen button if a local image fails to decode", async () => {
    renderChat("![Corrupt](/tmp/qa/corrupt.png)");

    const img = await screen.findByAltText("Corrupt");
    fireEvent.error(img);

    expect(screen.queryByRole("button", { name: /Full screen/ })).toBeNull();
    expect(screen.getByTitle("Could not display this image.")).toBeInTheDocument();
  });

  it("does not wrap a linked image badge in a fullscreen button", async () => {
    renderChat("[![Build](/tmp/qa/badge.png)](https://ci.example.com)");

    await screen.findByAltText("Build");
    expect(screen.queryByRole("button", { name: /Full screen/ })).toBeNull();
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://ci.example.com");
  });
});

describe("isLocalImageSource", () => {
  it.each(["/tmp/shot.png", "docs/qa/shot.PNG", "./diagram.svg", "file:///tmp/shot.png"])(
    "treats %s as an image on the host",
    (src) => {
      expect(isLocalImageSource(src)).toBe(true);
    },
  );

  it.each([
    "https://example.com/a.png",
    "//cdn.example.com/a.png",
    "data:image/png;base64,AAAA",
    "blob:abc",
    "/tmp/notes.txt",
  ])("leaves %s alone", (src) => {
    expect(isLocalImageSource(src)).toBe(false);
  });
});
