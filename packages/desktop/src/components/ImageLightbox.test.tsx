import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";
import { openImageLightbox, useImageLightboxStore } from "@/stores/image-lightbox-store";
import { ImageLightboxHost } from "./ImageLightbox";

vi.mock("@/lib/browser-suppression", () => ({ useSuppressBrowserView: () => undefined }));

function image(id: string, src: string | null = `blob:${id}`) {
  return { id, src, alt: `Attached image ${id}`, mediaType: "image/png" };
}

afterEach(() => {
  act(() => useImageLightboxStore.setState({ open: false, images: [], index: 0 }));
});

describe("ImageLightboxHost", () => {
  it("renders nothing until an image is opened", () => {
    render(<ImageLightboxHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the selected image centred with its zoom controls", () => {
    render(<ImageLightboxHost />);

    act(() => openImageLightbox([image("a"), image("b")], 1));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByAltText("Attached image b")).toHaveAttribute("src", "blob:b");
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("updates fallback image names in the open viewer and preserves supplied alt text", async () => {
    render(<ImageLightboxHost />);
    act(() => openImageLightbox([{ ...image("a"), alt: "" }, image("b")]));

    const dialog = screen.getByRole("dialog", { name: "image" });
    expect(screen.getByRole("img", { name: "image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show image" })).toBeVisible();

    uiI18n.addResourceBundle("fr", "ui", {
      conversation: { stream: { markdownImage: { image: "illustration" } } },
    });
    try {
      await act(() => uiI18n.changeLanguage("fr"));
      expect(screen.getByRole("dialog", { name: "illustration" })).toBe(dialog);
      expect(screen.getByRole("img", { name: "illustration" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show illustration" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Show Attached image b" })).toBeVisible();
    } finally {
      await act(() => uiI18n.changeLanguage("en"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
  });

  it("steps between images with the arrow keys, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<ImageLightboxHost />);
    act(() => openImageLightbox([image("a"), image("b")], 0));

    await user.keyboard("{ArrowRight}");
    expect(useImageLightboxStore.getState().index).toBe(1);

    await user.keyboard("{ArrowRight}");
    expect(useImageLightboxStore.getState().index).toBe(0);

    await user.keyboard("{ArrowLeft}");
    expect(useImageLightboxStore.getState().index).toBe(1);
  });

  it("zooms with the keyboard and resets back to fit", async () => {
    const user = userEvent.setup();
    render(<ImageLightboxHost />);
    act(() => openImageLightbox([image("a")], 0));

    await user.keyboard("+");
    expect(screen.getByText("150%")).toBeInTheDocument();

    await user.keyboard("0");
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  // React attaches `wheel` passively at the root, so the listener has to be
  // native — and the state update must not nest one setter inside another's
  // updater, which StrictMode's double-invoke silently discarded: the gesture
  // was consumed but the image never zoomed.
  it("zooms on a trackpad wheel and stops the page zooming with it", () => {
    render(<ImageLightboxHost />);
    act(() => openImageLightbox([image("a")], 0));
    const surface = screen.getByAltText("Attached image a").parentElement as HTMLElement;

    const event = new WheelEvent("wheel", { deltaY: -300, cancelable: true, bubbles: true });
    act(() => {
      surface.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByText("212%")).toBeInTheDocument();
  });

  it("hides the navigation affordances for a single image", () => {
    render(<ImageLightboxHost />);
    act(() => openImageLightbox([image("a")], 0));

    expect(screen.queryByRole("button", { name: /Next image/ })).toBeNull();
    expect(screen.queryByText("1 of 1")).toBeNull();
  });

  it("closes on the toolbar button", async () => {
    const user = userEvent.setup();
    render(<ImageLightboxHost />);
    act(() => openImageLightbox([image("a")], 0));

    await user.click(screen.getByRole("button", { name: "Close (Esc)" }));

    expect(useImageLightboxStore.getState().open).toBe(false);
  });

  it("explains an unresolvable payload and disables the actions that need it", () => {
    render(<ImageLightboxHost />);
    act(() => openImageLightbox([image("a", null)], 0));

    expect(screen.getByText(/no longer held in memory/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy image" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save image" })).toBeDisabled();
  });
});
