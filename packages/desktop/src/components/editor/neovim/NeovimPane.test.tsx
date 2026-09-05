import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Key/mouse encoding, scrollback and the draw loop now live inside `Terminal`
// (celeritty), tested at the package level — NeovimPane only owns the
// socket and the transport bridge, so that is all this file mocks.
interface CelerittyTerminalMockResult {
  terminal: undefined;
  status: "loading" | "ready" | "error";
  errorMessage: string | null;
}
const celerittyTerminalMock = vi.fn<() => CelerittyTerminalMockResult>(() => ({
  terminal: undefined,
  status: "ready",
  errorMessage: null,
}));
vi.mock("@/components/terminal-core", () => ({
  useCelerittyTerminal: (...args: unknown[]) => celerittyTerminalMock(...(args as [])),
}));

const connectMock = vi.fn();
vi.mock("./useNeovimWebSocket", () => ({
  useNeovimWebSocket: vi.fn(() => ({
    connect: connectMock,
    write: vi.fn(),
    resize: vi.fn(),
    detach: vi.fn(),
    isConnected: true,
    lastError: null as string | null,
  })),
}));

vi.mock("./useNeovimTransport", () => ({
  useNeovimTransport: vi.fn(() => ({
    transport: { write: vi.fn(), resize: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
    deliverData: vi.fn(),
    deliverClose: vi.fn(),
  })),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    theme: {
      xterm: {
        background: "#000",
        foreground: "#fff",
        cursor: "#fff",
        cursorAccent: "#000",
        selectionBackground: "#333",
        selectionForeground: "#fff",
        selectionInactiveBackground: "#222",
        black: "#000",
        red: "#f00",
        green: "#0f0",
        yellow: "#ff0",
        blue: "#00f",
        magenta: "#f0f",
        cyan: "#0ff",
        white: "#fff",
        brightBlack: "#555",
        brightRed: "#f55",
        brightGreen: "#5f5",
        brightYellow: "#ff5",
        brightBlue: "#55f",
        brightMagenta: "#f5f",
        brightCyan: "#5ff",
        brightWhite: "#fff",
      },
    },
  }),
}));

const { default: NeovimPane } = await import("./NeovimPane");

describe("NeovimPane", () => {
  it("connects to the feature's neovim session on mount", () => {
    render(<NeovimPane featureId={1} />);
    expect(connectMock).toHaveBeenCalled();
  });

  it("renders a focusable surface once ready", () => {
    render(<NeovimPane featureId={1} />);
    expect(screen.getByRole("application")).toBeInTheDocument();
  });
});

describe("NeovimPane error state", () => {
  afterEach(() => {
    celerittyTerminalMock.mockReturnValue({
      terminal: undefined,
      status: "ready",
      errorMessage: null,
    });
  });

  it("shows the terminal's error message instead of a silent blank pane", () => {
    // `mockReturnValue`, not `...Once`: mounting sets `connected`, which
    // re-renders, so the hook is called twice and a one-shot mock would be
    // consumed by the first pass and report "ready" on the second.
    celerittyTerminalMock.mockReturnValue({
      terminal: undefined,
      status: "error",
      errorMessage: "WebGPU is unavailable",
    });
    render(<NeovimPane featureId={1} />);
    expect(screen.getByText(/WebGPU is unavailable/)).toBeInTheDocument();
  });
});
