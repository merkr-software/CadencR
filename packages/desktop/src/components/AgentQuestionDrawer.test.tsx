import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { invokeRegisteredHotkey } from "@/test/hotkeys";
import { AgentQuestionDrawer } from "./AgentQuestionDrawer";
import { parseAskUserQuestions } from "@/lib/agent-question-parser";
import type { AgentQuestion } from "@/types/agent-question";

vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: vi.fn(),
}));

const mockedUseHotkeys = vi.mocked(useHotkeys);

interface RegisteredHotkey {
  callback: (event: KeyboardEvent) => void;
  hotkey: string;
  ignoreInputs?: boolean;
}

function registeredHotkeys(): RegisteredHotkey[] {
  return mockedUseHotkeys.mock.calls.flatMap(([definitions]) =>
    definitions.map((definition) => ({
      callback: (event: KeyboardEvent) =>
        invokeRegisteredHotkey(definition.callback, String(definition.hotkey), event),
      hotkey: String(definition.hotkey),
      ignoreInputs: definition.options?.ignoreInputs,
    })),
  );
}

function findRegisteredHotkey(hotkey: string): RegisteredHotkey {
  const match = registeredHotkeys().find((definition) => definition.hotkey === hotkey);
  if (!match) throw new Error(`Expected hotkey ${hotkey} to be registered`);
  return match;
}

const simpleQuestion: AgentQuestion = {
  question: "What is your name?",
};

const questionWithOptions: AgentQuestion = {
  question: "Choose a color",
  options: [{ label: "Red" }, { label: "Blue" }],
};

const multiSelectQuestion: AgentQuestion = {
  question: "Pick multiple",
  options: [{ label: "Option A" }, { label: "Option B" }, { label: "Option C" }],
  multiSelect: true,
};

describe("AgentQuestionDrawer", () => {
  const onSubmit = vi.fn();

  beforeEach(() => {
    onSubmit.mockClear();
    mockedUseHotkeys.mockClear();
  });

  it("does not render when closed", () => {
    const { container } = render(
      <AgentQuestionDrawer questions={[simpleQuestion]} onSubmit={onSubmit} open={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders question text when open", () => {
    render(<AgentQuestionDrawer questions={[simpleQuestion]} onSubmit={onSubmit} open />);
    expect(screen.getByText("What is your name?")).toBeInTheDocument();
  });

  it("renders option buttons for question with options", () => {
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    const buttons = screen.getAllByRole("button");
    const redBtn = buttons.find((b) => b.textContent?.includes("Red"));
    const blueBtn = buttons.find((b) => b.textContent?.includes("Blue"));
    expect(redBtn).toBeTruthy();
    expect(blueBtn).toBeTruthy();
  });

  it("submits selected option on submit click", async () => {
    const user = userEvent.setup();
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    const buttons = screen.getAllByRole("button");
    const redBtn = buttons.find((b) => b.textContent?.includes("Red"))!;
    await user.click(redBtn);
    const submitBtns = screen.getAllByRole("button");
    const submitBtn = submitBtns.find(
      (b) => b.textContent?.includes("Submit") || b.textContent?.includes("Next"),
    );
    expect(submitBtn).toBeTruthy();
    await user.click(submitBtn!);
    expect(onSubmit).toHaveBeenCalledWith([["Red"]]);
  });

  it("allows multiple selections in multiSelect mode", async () => {
    const user = userEvent.setup();
    render(<AgentQuestionDrawer questions={[multiSelectQuestion]} onSubmit={onSubmit} open />);
    const buttons = screen.getAllByRole("button");
    const optABtn = buttons.find((b) => b.textContent?.includes("Option A"))!;
    const optBBtn = buttons.find((b) => b.textContent?.includes("Option B"))!;
    await user.click(optABtn);
    await user.click(optBBtn);
    const submitBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("Submit") || b.textContent?.includes("Next"))!;
    await user.click(submitBtn);
    expect(onSubmit).toHaveBeenCalledWith([["Option A", "Option B"]]);
  });

  it("submits provider option ids when labels are duplicated", async () => {
    const user = userEvent.setup();
    const question: AgentQuestion = {
      question: "Choose",
      options: [
        { id: "first", label: "Same" },
        { id: "second", label: "Same" },
      ],
    };
    render(<AgentQuestionDrawer questions={[question]} onSubmit={onSubmit} open />);

    await user.click(screen.getAllByRole("button", { name: /Same/i })[1]);
    await user.click(screen.getByRole("button", { name: /Submit/i }));

    expect(onSubmit).toHaveBeenCalledWith([["second"]]);
  });

  it("shows Other option button", () => {
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    const buttons = screen.getAllByRole("button");
    const otherBtn = buttons.find((b) => b.textContent?.includes("Other"));
    expect(otherBtn).toBeTruthy();
  });

  it("shows text input after clicking Other", async () => {
    const user = userEvent.setup();
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    const buttons = screen.getAllByRole("button");
    const otherBtn = buttons.find((b) => b.textContent?.includes("Other"))!;
    await user.click(otherBtn);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("dims the digit badges while the Other free-text input is focused", async () => {
    const user = userEvent.setup();
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    // Digit badge is shown while options are selectable by number.
    expect(screen.getByText("1")).toBeInTheDocument();

    const otherBtn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Other"))!;
    await user.click(otherBtn);
    await user.click(screen.getByRole("textbox"));

    // With the input focused, the 1-9 selectors are inert, so badges show "-".
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });

  it("re-enables the digit badges on the next question after submitting Other via Enter", async () => {
    // Regression: submitting the "Other" free-text via Enter unmounts the input
    // before its onBlur fires, so the freeTextFocused flag leaked as `true` into
    // the next question — leaving the 1-9 badges dimmed (showing "-") even though
    // "Other" was never selected. resetState must clear the flag.
    const user = userEvent.setup();
    render(
      <AgentQuestionDrawer
        questions={[questionWithOptions, questionWithOptions]}
        onSubmit={onSubmit}
        open
      />,
    );

    // Q1: open "Other", focus + type into the free-text input, submit with Enter.
    const otherBtn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Other"))!;
    await user.click(otherBtn);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.type(input, "custom answer{Enter}");

    // Q2 is now shown with no input focused, so the digit badges must be active.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.queryByText("-")).toBeNull();
  });

  it("keeps Other after submitting via Enter until the backend confirms", async () => {
    // Same leak, but on the last question: resetState runs after onSubmit, and the
    // drawer stays mounted (open) showing question 1 again, so the badges must reset.
    const user = userEvent.setup();
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);

    const otherBtn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Other"))!;
    await user.click(otherBtn);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.type(input, "custom answer{Enter}");

    expect(onSubmit).toHaveBeenCalledWith([["custom answer"]]);
    expect(screen.getByRole("textbox")).toHaveValue("custom answer");
  });

  it("shows first question when multiple questions provided", () => {
    render(
      <AgentQuestionDrawer
        questions={[simpleQuestion, questionWithOptions]}
        onSubmit={onSubmit}
        open
      />,
    );
    expect(screen.getByText("What is your name?")).toBeInTheDocument();
  });

  it("shows preview when an option with preview is selected", async () => {
    const user = userEvent.setup();
    const questionWithPreview: AgentQuestion = {
      question: "Pick one",
      options: [{ label: "Alpha", preview: "┌───┐\n│ A │\n└───┘" }, { label: "Beta" }],
    };
    render(<AgentQuestionDrawer questions={[questionWithPreview]} onSubmit={onSubmit} open />);
    expect(screen.queryByText(/┌───┐/)).toBeNull();
    const alphaBtn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Alpha"))!;
    await user.click(alphaBtn);
    expect(screen.getByText(/┌───┐/)).toBeInTheDocument();
  });

  it("registers digit hotkeys (no Mod) and Mod+O for Other", () => {
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    const hotkeyStrings = registeredHotkeys().map((definition) => definition.hotkey);
    // Digit hotkeys without modifier
    expect(hotkeyStrings).toEqual(
      expect.arrayContaining(["1", "2", "3", "4", "5", "6", "7", "8", "9"]),
    );
    // cmd+O for Other
    expect(hotkeyStrings).toContain("Mod+O");
    // No cmd+digit hotkeys remain (those are reserved for the sidebar)
    expect(hotkeyStrings.some((s) => /Mod\+\d/.test(s))).toBe(false);
  });

  it("registers digit hotkeys so they do not fire while typing in the Other input", () => {
    // Regression: typing a number in the free-text "Other" input must insert
    // the digit, not select/toggle an option. Digit hotkeys must ignore inputs.
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(findRegisteredHotkey(digit).ignoreInputs).toBe(true);
    }
  });

  it("does not select options from AZERTY physical digit keys unless they emit digits", () => {
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    const preventDefault = vi.fn();

    act(() => {
      findRegisteredHotkey("1").callback({
        code: "Digit1",
        key: "&",
        preventDefault,
      } as unknown as KeyboardEvent);
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.getByText("Red").closest("button")).not.toHaveClass("border-primary");

    act(() => {
      findRegisteredHotkey("Shift+1").callback({
        code: "Digit1",
        key: "1",
        preventDefault,
      } as unknown as KeyboardEvent);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(screen.getByText("Red").closest("button")).toHaveClass("border-primary");
  });

  it("selects the second option from the digit character, not the AZERTY é key", () => {
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    const preventDefault = vi.fn();

    act(() => {
      findRegisteredHotkey("Shift+2").callback({
        code: "Digit2",
        key: "é",
        preventDefault,
      } as unknown as KeyboardEvent);
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.getByText("Blue").closest("button")).not.toHaveClass("border-primary");

    act(() => {
      findRegisteredHotkey("Shift+2").callback({
        code: "Digit2",
        key: "2",
        preventDefault,
      } as unknown as KeyboardEvent);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(screen.getByText("Blue").closest("button")).toHaveClass("border-primary");
  });

  it("invoking Escape closes the question gate", () => {
    const onCancel = vi.fn();
    render(
      <AgentQuestionDrawer
        questions={[questionWithOptions]}
        onSubmit={onSubmit}
        onCancel={onCancel}
        open
      />,
    );
    const handler = findRegisteredHotkey("Escape").callback as unknown as (e: {
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => void;
    handler({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders a dismiss button when onCancel is provided and calls it on click", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentQuestionDrawer
        questions={[questionWithOptions]}
        onSubmit={onSubmit}
        onCancel={onCancel}
        open
      />,
    );
    const dismissButton = screen.getByRole("button", { name: /dismiss question/i });
    await user.click(dismissButton);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not render a dismiss button when onCancel is omitted", () => {
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    expect(screen.queryByRole("button", { name: /dismiss question/i })).toBeNull();
  });

  it("blurs the option button after click so Enter can validate", async () => {
    const user = userEvent.setup();
    render(<AgentQuestionDrawer questions={[questionWithOptions]} onSubmit={onSubmit} open />);
    const redBtn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Red"))!;
    await user.click(redBtn);
    // After clicking an option, the button must not retain focus — otherwise pressing
    // Enter would re-trigger its onClick (toggling) instead of validating the form.
    expect(document.activeElement).not.toBe(redBtn);
  });
});

describe("parseAskUserQuestions", () => {
  it("parses multiSelect from tool input", () => {
    const result = parseAskUserQuestions({
      questions: [
        {
          question: "Pick languages",
          multiSelect: true,
          options: [{ label: "TypeScript" }, { label: "Rust" }],
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].multiSelect).toBe(true);
  });

  it("prefers questions array over duplicated single-question fields", () => {
    const result = parseAskUserQuestions({
      question: "What exact file path should you edit?",
      options: [{ label: "src/main.rs" }],
      questions: [
        {
          question: "What exact file path should you edit?",
          multiple: false,
          options: [{ label: "src/main.rs" }, { label: "Other file" }],
        },
        {
          question: "Which mode should you use?",
          multiple: false,
          options: [{ label: "minimal" }, { label: "moderate" }],
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0].question).toBe("What exact file path should you edit?");
    expect(result[1].question).toBe("Which mode should you use?");
  });

  it("supports OpenCode multiple flag for multi-select questions", () => {
    const result = parseAskUserQuestions({
      questions: [
        {
          question: "Pick options",
          multiple: true,
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    });

    expect(result[0].multiSelect).toBe(true);
  });

  it("parses preview from options", () => {
    const result = parseAskUserQuestions({
      question: "Pick one",
      options: [{ label: "A", preview: "diagram" }],
    });
    expect(result[0].options?.[0].preview).toBe("diagram");
  });

  it("preserves provider option ids", () => {
    const result = parseAskUserQuestions({
      question: "Pick one",
      options: [{ id: "option-1", label: "A" }],
    });
    expect(result[0].options?.[0].id).toBe("option-1");
  });

  it("defaults multiSelect to false", () => {
    const result = parseAskUserQuestions({ question: "Hello?" });
    expect(result[0].multiSelect).toBe(false);
  });
});
