import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { AssistMenu } from "./AssistMenu";
import { ComposerContextProvider, type ComposerContextValue } from "./ComposerContext";

function renderMenu(overrides: Partial<ComposerContextValue> = {}) {
  const value = {
    sessionId: 9,
    editor: { focus: vi.fn(), getText: () => "", setText: vi.fn(), insertText: vi.fn() },
    sessionInfo: {
      runtimeProvider: "claude_code",
      runtimeSessionId: "runtime-42",
      projectPath: "/tmp/repo",
      isRunning: false,
      onPause: vi.fn(),
    },
    ...overrides,
  } as unknown as ComposerContextValue;
  return render(
    <ComposerContextProvider value={value}>
      <AssistMenu />
    </ComposerContextProvider>,
  );
}

describe("AssistMenu", () => {
  it("shows the session details in one click", async () => {
    const { user } = renderMenu();
    await user.click(screen.getByRole("button", { name: "More composer actions" }));
    expect(await screen.findByText("runtime-42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Copy launch command/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("goes from the details to the keys & syntax and back", async () => {
    const { user } = renderMenu();
    await user.click(screen.getByRole("button", { name: "More composer actions" }));
    await user.click(await screen.findByRole("button", { name: "Keys & syntax" }));
    expect(screen.getByText("Composer keys & syntax")).toBeInTheDocument();
    expect(screen.getByText("/cadencr:side")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Session" }));
    expect(await screen.findByText("runtime-42")).toBeInTheDocument();
  });

  it("opens straight on the keys before a session exists", async () => {
    const { user } = renderMenu({ sessionInfo: undefined, sessionId: undefined });
    await user.click(screen.getByRole("button", { name: "More composer actions" }));
    expect(await screen.findByText("Composer keys & syntax")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session" })).not.toBeInTheDocument();
  });
});
