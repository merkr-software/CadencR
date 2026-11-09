import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@/test-utils";
import { useSetting, type Setting } from "@/hooks/useSetting";
import { useGetAutoNamePrompt } from "@/api/generated";
import { AutoNamePromptSetting, storedAutoNamePrompt } from "./AutoNamePromptSetting";

vi.mock("@/hooks/useSetting", () => ({
  useSetting: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useGetAutoNamePrompt: vi.fn(),
}));

const DEFAULT_PROMPT = "You are a feature naming assistant.";
const setValue = vi.fn<Setting["setValue"]>().mockResolvedValue(true);

function mockSetting(value: string | null): void {
  vi.mocked(useSetting).mockReturnValue({
    value,
    setValue,
    isLoading: false,
    isFetched: true,
    isSaving: false,
  });
}

describe("storedAutoNamePrompt", () => {
  it("stores the default and blank prompts as empty so they follow the built-in", () => {
    expect(storedAutoNamePrompt(DEFAULT_PROMPT, DEFAULT_PROMPT)).toBe("");
    expect(storedAutoNamePrompt(`  ${DEFAULT_PROMPT}\n`, DEFAULT_PROMPT)).toBe("");
    expect(storedAutoNamePrompt("   ", DEFAULT_PROMPT)).toBe("");
  });

  it("stores an edited prompt verbatim", () => {
    expect(storedAutoNamePrompt(`${DEFAULT_PROMPT} Use French.`, DEFAULT_PROMPT)).toBe(
      `${DEFAULT_PROMPT} Use French.`,
    );
  });
});

describe("AutoNamePromptSetting", () => {
  beforeEach(() => {
    setValue.mockClear();
    vi.mocked(useGetAutoNamePrompt).mockReturnValue({
      data: { default_prompt: DEFAULT_PROMPT },
      error: null,
    } as unknown as ReturnType<typeof useGetAutoNamePrompt>);
  });

  it("pre-fills the built-in prompt and offers no reset while it is in use", () => {
    mockSetting(null);
    render(<AutoNamePromptSetting />);

    expect(screen.getByRole("textbox", { name: /auto-naming system prompt/i })).toHaveValue(
      DEFAULT_PROMPT,
    );
    expect(screen.queryByRole("button", { name: "Reset naming prompt" })).not.toBeInTheDocument();
  });

  it("saves additions to the prompt on blur, not per keystroke", async () => {
    mockSetting(null);
    const user = userEvent.setup();
    render(<AutoNamePromptSetting />);

    const field = screen.getByRole("textbox", { name: /auto-naming system prompt/i });
    await user.click(field);
    await user.keyboard("{End} Use French.");
    expect(setValue).not.toHaveBeenCalled();

    await user.tab();
    expect(setValue).toHaveBeenCalledTimes(1);
    expect(setValue).toHaveBeenCalledWith(`${DEFAULT_PROMPT} Use French.`);
  });

  it("does not rewrite the setting when the prompt is unchanged", async () => {
    mockSetting(null);
    const user = userEvent.setup();
    render(<AutoNamePromptSetting />);

    await user.click(screen.getByRole("textbox", { name: /auto-naming system prompt/i }));
    await user.tab();

    expect(setValue).not.toHaveBeenCalled();
  });

  it("saves a pending edit when unmounted before blur", async () => {
    mockSetting(null);
    const user = userEvent.setup();
    const { unmount } = render(<AutoNamePromptSetting />);

    await user.click(screen.getByRole("textbox", { name: /auto-naming system prompt/i }));
    await user.keyboard("{End} Use French.");
    unmount();

    expect(setValue).toHaveBeenCalledWith(`${DEFAULT_PROMPT} Use French.`);
  });

  it("shows a custom prompt and resets it back to the built-in", async () => {
    mockSetting("Name sessions in French.");
    const user = userEvent.setup();
    render(<AutoNamePromptSetting />);

    const field = screen.getByRole("textbox", { name: /auto-naming system prompt/i });
    expect(field).toHaveValue("Name sessions in French.");

    await user.click(screen.getByRole("button", { name: "Reset naming prompt" }));

    expect(setValue).toHaveBeenCalledWith("");
    expect(field).toHaveValue(DEFAULT_PROMPT);
  });

  it("surfaces a failure to load the default prompt", () => {
    mockSetting(null);
    vi.mocked(useGetAutoNamePrompt).mockReturnValue({
      data: undefined,
      error: new Error("boom"),
    } as unknown as ReturnType<typeof useGetAutoNamePrompt>);
    render(<AutoNamePromptSetting />);

    expect(screen.getByText("Failed to load the default naming prompt.")).toBeInTheDocument();
  });
});
