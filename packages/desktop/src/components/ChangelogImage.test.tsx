import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { render } from "@/test-utils";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { ChangelogBody } from "./ChangelogBody";
import { ChangelogImage } from "./ChangelogImage";

const SCREENSHOT =
  "https://raw.githubusercontent.com/merkr-software/cadencr/v0.14.0/docs/changelog/v0.14.0/sidebar.png";

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const mocks = vi.hoisted(() => ({
  fetchChangelogImage: vi.fn(),
  createObjectURL: vi.fn(() => "blob:changelog-image"),
  revokeObjectURL: vi.fn(),
}));

beforeEach(() => {
  mocks.fetchChangelogImage.mockReset();
  mocks.revokeObjectURL.mockClear();
  mocks.fetchChangelogImage.mockResolvedValue({
    data: new Uint8Array([137, 80, 78, 71]),
    mimeType: "image/png",
  });
  setDesktopBridgeOverrideForTests({ fetchChangelogImage: mocks.fetchChangelogImage });
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
  clearDesktopBridgeOverrideForTests();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: originalCreateObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: originalRevokeObjectURL,
  });
});

describe("ChangelogBody images", () => {
  it("renders a repository screenshot from a blob URL rather than a CSP-blocked remote <img>", async () => {
    render(
      <ChangelogBody
        state={{ kind: "markdown", markdown: `### ✨ Added\n\n![New sidebar](${SCREENSHOT})` }}
      />,
    );

    const image = await screen.findByAltText("New sidebar");
    expect(image).toHaveAttribute("src", "blob:changelog-image");
    expect(mocks.fetchChangelogImage).toHaveBeenCalledWith(SCREENSHOT);
  });

  it("revokes the object URL when the dialog body unmounts", async () => {
    const { unmount } = render(
      <ChangelogBody state={{ kind: "markdown", markdown: `![Shot](${SCREENSHOT})` }} />,
    );
    await screen.findByAltText("Shot");

    unmount();

    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:changelog-image");
  });

  it("renders an inline data: image as-is without asking the main process", () => {
    render(
      <ChangelogBody
        state={{ kind: "markdown", markdown: "![Inline](data:image/png;base64,AAAA)" }}
      />,
    );

    expect(screen.getByAltText("Inline")).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(mocks.fetchChangelogImage).not.toHaveBeenCalled();
  });

  it("keeps an HTML <img>'s explicit width", async () => {
    render(
      <ChangelogBody
        state={{ kind: "markdown", markdown: `<img src="${SCREENSHOT}" alt="Sized" width="480">` }}
      />,
    );

    const image = await screen.findByAltText("Sized");
    expect(image).toHaveAttribute("src", "blob:changelog-image");
    expect(image).toHaveAttribute("width", "480");
  });

  it("names a refused image with the main process's reason instead of a broken glyph", async () => {
    mocks.fetchChangelogImage.mockRejectedValue(
      new Error(
        "Error invoking remote method 'app:fetch-changelog-image': Error: GitHub returned HTTP 404 for this image.",
      ),
    );

    render(
      <ChangelogBody state={{ kind: "markdown", markdown: `![Missing shot](${SCREENSHOT})` }} />,
    );

    const notice = await screen.findByTitle("GitHub returned HTTP 404 for this image.");
    expect(notice).toHaveTextContent("Missing shot");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names an image that fails decoding after its bytes were fetched", async () => {
    render(
      <ChangelogBody state={{ kind: "markdown", markdown: `![Damaged shot](${SCREENSHOT})` }} />,
    );
    fireEvent.error(await screen.findByAltText("Damaged shot"));

    expect(await screen.findByTitle("Could not display this image.")).toHaveTextContent(
      "Damaged shot",
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("tries the new source when a failed image is replaced", async () => {
    const { rerender } = render(<ChangelogImage src={SCREENSHOT} alt="Shot" />);
    fireEvent.error(await screen.findByAltText("Shot"));
    await screen.findByTitle("Could not display this image.");

    rerender(<ChangelogImage src={`${SCREENSHOT}?replacement`} alt="Replacement" />);

    expect(await screen.findByAltText("Replacement")).toHaveAttribute(
      "src",
      "blob:changelog-image",
    );
    expect(screen.queryByTitle("Could not display this image.")).toBeNull();
  });
});
