import { createRef } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@/test-utils";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";

describe("PromptEditor", () => {
  it("renders with placeholder text", () => {
    render(<PromptEditor placeholder="Type here..." />);
    expect(screen.getByText("Type here...")).toBeInTheDocument();
  });

  it("does not format markdown syntax as rich text", async () => {
    const onChange = vi.fn();
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} onChange={onChange} />);

    await act(async () => {
      ref.current!.setText("**bold** and _italic_");
    });

    // The raw text should be preserved as-is, not converted to formatted text
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall).toContain("**bold**");
    expect(lastCall).toContain("_italic_");
  });

  it("returns raw text from getText()", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} />);

    await act(async () => {
      ref.current!.setText("# heading **bold**");
    });

    const text = ref.current!.getText();
    expect(text).toBe("# heading **bold**");
  });

  it("initializes with initialText", () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} initialText="hello world" />);

    expect(ref.current!.getText()).toBe("hello world");
  });

  it("clears editor content", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} initialText="some text" />);

    await act(async () => {
      ref.current!.clear();
    });

    expect(ref.current!.getText()).toBe("");
  });

  it("preserves multiline text as separate paragraphs", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} />);

    await act(async () => {
      ref.current!.setText("first line\n\nthird line");
    });

    expect(ref.current!.getText()).toBe("first line\n\nthird line");
    expect(screen.getByRole("textbox").querySelectorAll("p")).toHaveLength(3);
  });

  it("uses history navigation when the DOM caret is at the true start", async () => {
    const ref = createRef<PromptEditorHandle>();
    const onArrowUp = vi.fn(() => null);
    render(<PromptEditor ref={ref} onArrowUp={onArrowUp} />);

    await act(async () => {
      ref.current!.setText("first line\nsecond line");
    });

    const firstTextNode = screen
      .getByRole("textbox")
      .querySelector('[data-lexical-text="true"]')?.firstChild;
    expect(firstTextNode).not.toBeNull();

    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(firstTextNode!, 0);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });

    expect(onArrowUp).toHaveBeenCalledTimes(1);
  });

  it("reports multiline changes without extra blank lines", async () => {
    const onChange = vi.fn();
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} onChange={onChange} />);

    await act(async () => {
      ref.current!.setText("first line\nsecond line");
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
    expect(lastCall).toBe("first line\nsecond line");
  });

  it("shows slash command loading state before commands arrive", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} slashCommands={[]} slashCommandsLoading />);

    await act(async () => {
      ref.current!.setText("/");
    });

    expect(screen.getByText(/loading commands/i)).toBeInTheDocument();
  });

  it("shows matching custom commands beyond the builtin result cap", async () => {
    const ref = createRef<PromptEditorHandle>();
    const slashCommands = [
      ...Array.from({ length: 25 }, (_, index) => ({
        name: `builtin-${index}`,
        description: "Builtin command",
        kind: "command" as const,
      })),
      {
        name: "superpowers:brainstorming",
        description: "Brainstorm with superpowers",
        kind: "command" as const,
      },
    ];
    render(<PromptEditor ref={ref} slashCommands={slashCommands} slashCommandsLoading={false} />);

    await act(async () => {
      ref.current!.setText("/brain");
    });

    expect(screen.getByText("/superpowers:brainstorming")).toBeInTheDocument();
  });

  it("shows skill suggestions when $ appears mid-prompt", async () => {
    const ref = createRef<PromptEditorHandle>();
    const slashCommands = [
      {
        name: "superpowers:brainstorming",
        description: "Brainstorm with superpowers",
        kind: "skill" as const,
      },
    ];
    render(<PromptEditor ref={ref} slashCommands={slashCommands} slashCommandsLoading={false} />);

    await act(async () => {
      ref.current!.setText("first do this then $brain");
    });

    // Skills ($) can be referenced anywhere in the prompt, not just at the start.
    expect(screen.getByText("$superpowers:brainstorming")).toBeInTheDocument();
  });

  it("does not show command suggestions when / appears mid-prompt", async () => {
    const ref = createRef<PromptEditorHandle>();
    const slashCommands = [
      {
        name: "superpowers:brainstorming",
        description: "Brainstorm with superpowers",
        kind: "command" as const,
      },
    ];
    render(<PromptEditor ref={ref} slashCommands={slashCommands} slashCommandsLoading={false} />);

    await act(async () => {
      ref.current!.setText("first do this then /brain");
    });

    // Slash commands (/) only trigger at the very start of the prompt.
    expect(screen.queryByText("/superpowers:brainstorming")).not.toBeInTheDocument();
  });
});
