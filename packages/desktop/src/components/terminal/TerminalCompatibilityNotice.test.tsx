import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";

const mocks = vi.hoisted(() => ({ phone: false, warning: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: mocks.warning, message: mocks.message } }));
vi.mock("@/lib/form-factor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/form-factor")>()),
  getPhoneShellSnapshot: () => mocks.phone,
}));

type NoticeModule = typeof import("@/components/terminal-core/terminal-compatibility-notice");
type ComponentModule = typeof import("./TerminalCompatibilityNotice");

let notice: NoticeModule;
let TerminalCompatibilityNotice: ComponentModule["TerminalCompatibilityNotice"];

beforeEach(async () => {
  // Fresh module state per test: the notice is once per session.
  vi.resetModules();
  localStorage.clear();
  mocks.warning.mockClear();
  mocks.message.mockClear();
  notice = await import("@/components/terminal-core/terminal-compatibility-notice");
  ({ TerminalCompatibilityNotice } = await import("./TerminalCompatibilityNotice"));
});

describe("compatibility terminal notice", () => {
  it("keeps the toast on desktop and shows no inline notice there", () => {
    mocks.phone = false;
    notice.reportTerminalCompatibility("No WebGPU adapter");
    expect(mocks.warning).toHaveBeenCalledWith(
      "Using the compatibility terminal",
      expect.objectContaining({ id: "terminal-compatibility", description: "No WebGPU adapter" }),
    );
  });

  it("shows an inline notice instead of a toast in the phone layout", () => {
    mocks.phone = true;
    render(<TerminalCompatibilityNotice />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => notice.reportTerminalCompatibility("No WebGPU adapter"));
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Using the compatibility terminal");
    expect(screen.getByText("No WebGPU adapter")).toBeInTheDocument();
  });

  it("reports once per session", () => {
    mocks.phone = false;
    notice.reportTerminalCompatibility("first");
    notice.reportTerminalCompatibility("second");
    expect(mocks.warning).toHaveBeenCalledTimes(1);
  });

  it("dismisses with a 44px close and remembers it on this device", async () => {
    mocks.phone = true;
    const { user, unmount } = render(<TerminalCompatibilityNotice />);
    act(() => notice.reportTerminalCompatibility("No WebGPU adapter"));
    const close = screen.getByRole("button", { name: /dismiss compatibility terminal notice/i });
    expect(close).toHaveClass("size-11");
    await user.click(close);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(localStorage.getItem("cadencr.terminalCompatibilityNoticeDismissed")).toBe("1");
    unmount();

    // A new session on the same device: the fallback is reported again, the notice stays hidden.
    vi.resetModules();
    notice = await import("@/components/terminal-core/terminal-compatibility-notice");
    ({ TerminalCompatibilityNotice } = await import("./TerminalCompatibilityNotice"));
    render(<TerminalCompatibilityNotice />);
    act(() => notice.reportTerminalCompatibility("No WebGPU adapter"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says a dismissal holds until the next reload when storage is blocked", async () => {
    mocks.phone = true;
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { user } = render(<TerminalCompatibilityNotice />);
    act(() => notice.reportTerminalCompatibility("No WebGPU adapter"));
    await user.click(
      screen.getByRole("button", { name: /dismiss compatibility terminal notice/i }),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(mocks.message).toHaveBeenCalledWith(
      "Hidden until the next reload",
      expect.objectContaining({ id: "terminal-compatibility" }),
    );
    setItem.mockRestore();
  });
});
