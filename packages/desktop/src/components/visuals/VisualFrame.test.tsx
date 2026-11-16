import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import type { VisualTheme } from "@/lib/visuals/live-theme";
import { VisualFrame } from "./VisualFrame";

vi.mock("@/lib/visuals/visual-assets", () => ({
  loadVisualAssets: vi.fn(async () => ({
    fontDataUrl: "data:font/woff2;base64,AA==",
    libraries: {},
  })),
}));
vi.mock("@/lib/visuals/visual-protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/visuals/visual-protocol")>()),
  visualFrameSrc: () => "about:blank",
}));

const THEME: VisualTheme = {
  key: "1",
  snapshot: { id: "cadencr-dark", appearance: "dark", tokens: { background: "#101010" } },
  fontSans: "sans-serif",
  fontMono: "monospace",
};

interface FakeFrameWindow {
  postMessage: ReturnType<typeof vi.fn>;
}

/** happy-dom gives frames no browsing context: stand one in for the shell's window. */
function stubFrameWindow(): FakeFrameWindow {
  const frame = screen.getByTitle("Agent visual");
  const fake: FakeFrameWindow = { postMessage: vi.fn() };
  Object.defineProperty(frame, "contentWindow", { value: fake, configurable: true });
  return fake;
}

function postFrom(source: unknown, data: unknown) {
  act(() => {
    const event = new MessageEvent("message", { data });
    Object.defineProperty(event, "source", { value: source });
    window.dispatchEvent(event);
  });
}

describe("VisualFrame", () => {
  it("answers the shell's ready with the assembled document", async () => {
    render(<VisualFrame html="<p>hello</p>" theme={THEME} />);
    const frame = stubFrameWindow();
    postFrom(frame, { type: "cadencr-visual:ready" });
    await waitFor(() => expect(frame.postMessage).toHaveBeenCalledTimes(1));
    const [message, target] = frame.postMessage.mock.calls[0] as [
      { type: string; html: string },
      string,
    ];
    expect(target).toBe("*");
    expect(message.type).toBe("cadencr-visual:render");
    expect(message.html).toContain("<p>hello</p>");
    expect(message.html).toContain("--background: #101010;");
  });

  it("names each loading step: libraries, then the first paint", async () => {
    render(<VisualFrame html={'<script src="cadencr:d3"></script>'} theme={THEME} />);
    const frame = stubFrameWindow();
    expect(screen.getByText("Loading d3…")).toBeInTheDocument();
    postFrom(frame, { type: "cadencr-visual:ready" });
    expect(await screen.findByText("Rendering visual…")).toBeInTheDocument();
    postFrom(frame, { type: "cadencr-visual:size", height: 120 });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("collapses a visual that failed before painting to its error", () => {
    render(<VisualFrame html="<p>broken</p>" theme={THEME} />);
    const frame = stubFrameWindow();
    postFrom(frame, { type: "cadencr-visual:error", message: "boom" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByTitle("Agent visual")).toHaveStyle({ height: "0px" });
  });

  it("sizes the frame to the reported height, capped, and drops the loader", () => {
    render(<VisualFrame html="<p>size</p>" theme={THEME} />);
    const frame = stubFrameWindow();
    expect(screen.getByText("Preparing visual…")).toBeInTheDocument();
    postFrom(frame, { type: "cadencr-visual:size", height: 321 });
    expect(screen.getByTitle("Agent visual")).toHaveStyle({ height: "321px" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    postFrom(frame, { type: "cadencr-visual:size", height: 99_999 });
    expect(screen.getByTitle("Agent visual")).toHaveStyle({ height: "1600px" });
  });

  it("surfaces script errors once each", () => {
    render(<VisualFrame html="<p>errors</p>" theme={THEME} />);
    const frame = stubFrameWindow();
    postFrom(frame, { type: "cadencr-visual:error", message: "d3 is not defined" });
    postFrom(frame, { type: "cadencr-visual:error", message: "d3 is not defined" });
    expect(screen.getAllByText("Visual error: d3 is not defined")).toHaveLength(1);
  });

  it("ignores messages from other windows", () => {
    render(<VisualFrame html="<p>other</p>" theme={THEME} />);
    stubFrameWindow();
    postFrom(window, { type: "cadencr-visual:error", message: "spoofed" });
    expect(screen.queryByText(/spoofed/)).not.toBeInTheDocument();
  });
});
