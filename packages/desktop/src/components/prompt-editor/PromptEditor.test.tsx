import { createRef } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@/test-utils";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import type { PromptCommandPolicy } from "@/lib/prompt-command-policy";

const SLASH_ANYWHERE_POLICY: PromptCommandPolicy = {
  slashCommandPlacement: "anywhere",
  skillReferenceTrigger: "slash",
  userShell: true,
};
const SLASH_AT_START_POLICY: PromptCommandPolicy = {
  slashCommandPlacement: "prompt_start",
  skillReferenceTrigger: "slash",
  userShell: true,
};
const DOLLAR_SKILLS_POLICY: PromptCommandPolicy = {
  slashCommandPlacement: "prompt_start",
  skillReferenceTrigger: "dollar",
  userShell: true,
};

vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: <T,>(value: T): T => value,
}));

vi.mock("@/api/generated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/generated")>();
  return {
    ...actual,
    useListConversationReferences: vi.fn(() => ({
      data: [
        {
          feature_id: 42,
          feature_title: "Authentication work",
          project_name: "Cadencr",
          feature_status: "active",
        },
      ],
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
    })),
  };
});

describe("PromptEditor", () => {
  it("renders with placeholder text", () => {
    render(<PromptEditor placeholder="Type here..." />);
    expect(screen.getByText("Type here...")).toBeInTheDocument();
  });

  it("refuses typing while disabled and accepts it again once re-enabled", () => {
    const { rerender } = render(<PromptEditor disabled />);
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "false");

    rerender(<PromptEditor />);
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true");

    rerender(<PromptEditor disabled />);
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "false");
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

  it("hides a leading bang while preserving shell command serialization", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} promptCommandPolicy={SLASH_AT_START_POLICY} />);

    await act(async () => {
      ref.current!.setText("!printf shell-ok");
    });

    const prefix = screen.getByRole("textbox").querySelector('[data-shell-command-prefix="true"]');
    expect(prefix).not.toBeNull();
    expect(prefix).toHaveClass("w-0", "text-transparent");
    expect(ref.current!.getText()).toBe("!printf shell-ok");
  });

  it("clears shell mode without clearing the command", async () => {
    const ref = createRef<PromptEditorHandle>();
    const onChange = vi.fn();
    render(
      <PromptEditor ref={ref} onChange={onChange} promptCommandPolicy={SLASH_AT_START_POLICY} />,
    );

    await act(async () => {
      ref.current!.setText("!git status --short");
    });
    await act(async () => {
      ref.current!.clearShellCommandMode();
    });

    expect(ref.current!.getText()).toBe("git status --short");
    expect(
      screen.getByRole("textbox").querySelector('[data-shell-command-prefix="true"]'),
    ).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith("git status --short");
  });

  it("shows a shell-specific placeholder for a bare bang", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} promptCommandPolicy={SLASH_AT_START_POLICY} />);

    await act(async () => {
      ref.current!.setText("!");
    });

    expect(screen.getByText("Type a shell command…")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveClass("text-transparent", "caret-primary");
    expect(ref.current!.getText()).toBe("!");

    await act(async () => {
      ref.current!.clearShellCommandMode();
    });
    expect(ref.current!.getText()).toBe("");
    expect(screen.queryByText("Type a shell command…")).not.toBeInTheDocument();
  });

  it("leaves bangs outside the first character as ordinary prompt text", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} />);

    await act(async () => {
      ref.current!.setText("explain !important");
    });

    expect(ref.current!.getText()).toBe("explain !important");
    expect(
      screen.getByRole("textbox").querySelector('[data-shell-command-prefix="true"]'),
    ).toBeNull();
  });

  it("leaves a leading bang visible when user shell commands are unsupported", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} />);

    await act(async () => {
      ref.current!.setText("!printf ordinary-text");
    });

    expect(ref.current!.getText()).toBe("!printf ordinary-text");
    expect(
      screen.getByRole("textbox").querySelector('[data-shell-command-prefix="true"]'),
    ).toBeNull();
  });

  it("restores the visible bang when switching to an unsupported provider", async () => {
    const ref = createRef<PromptEditorHandle>();
    const { rerender } = render(
      <PromptEditor ref={ref} promptCommandPolicy={SLASH_AT_START_POLICY} />,
    );
    await act(async () => {
      ref.current!.setText("!printf ordinary-text");
    });

    await act(async () => {
      rerender(<PromptEditor ref={ref} />);
    });

    expect(ref.current!.getText()).toBe("!printf ordinary-text");
    expect(
      screen.getByRole("textbox").querySelector('[data-shell-command-prefix="true"]'),
    ).toBeNull();
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
    render(
      <PromptEditor
        ref={ref}
        slashCommands={slashCommands}
        slashCommandsLoading={false}
        promptCommandPolicy={DOLLAR_SKILLS_POLICY}
      />,
    );

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
    render(
      <PromptEditor
        ref={ref}
        slashCommands={slashCommands}
        slashCommandsLoading={false}
        promptCommandPolicy={SLASH_AT_START_POLICY}
      />,
    );

    await act(async () => {
      ref.current!.setText("first do this then /brain");
    });

    // Slash commands (/) only trigger at the very start of the prompt.
    expect(screen.queryByText("/superpowers:brainstorming")).not.toBeInTheDocument();
  });

  it("shows Claude slash commands mid-prompt", async () => {
    const ref = createRef<PromptEditorHandle>();
    const slashCommands = [
      {
        name: "review",
        description: "Review the current changes",
        kind: "command" as const,
      },
      {
        name: "cadencr:review",
        description: "Run the Cadencr review workflow",
        kind: "cadencr" as const,
      },
    ];
    render(
      <PromptEditor
        ref={ref}
        slashCommands={slashCommands}
        slashCommandsLoading={false}
        promptCommandPolicy={SLASH_ANYWHERE_POLICY}
      />,
    );

    await act(async () => {
      ref.current!.setText("please /rev");
    });

    expect(screen.getByText("/review")).toBeInTheDocument();
    expect(screen.queryByText("/cadencr:review")).not.toBeInTheDocument();
  });

  it.each([
    ["slash anywhere", SLASH_ANYWHERE_POLICY],
    ["slash at start", SLASH_AT_START_POLICY],
  ])("does not offer dollar skills with %s policy", async (_name, promptCommandPolicy) => {
    const ref = createRef<PromptEditorHandle>();
    const slashCommands = [
      {
        name: "review",
        description: "Review the current changes",
        kind: "skill" as const,
      },
    ];
    render(
      <PromptEditor
        ref={ref}
        slashCommands={slashCommands}
        slashCommandsLoading={false}
        promptCommandPolicy={promptCommandPolicy}
      />,
    );

    await act(async () => {
      ref.current!.setText("please $rev");
    });

    expect(screen.queryByText("$review")).not.toBeInTheDocument();
  });

  it("keeps Codex skills out of the slash-command menu", async () => {
    const ref = createRef<PromptEditorHandle>();
    const slashCommands = [
      { name: "review-command", description: "Command", kind: "command" as const },
      { name: "review-skill", description: "Skill", kind: "skill" as const },
    ];
    render(
      <PromptEditor
        ref={ref}
        slashCommands={slashCommands}
        slashCommandsLoading={false}
        promptCommandPolicy={DOLLAR_SKILLS_POLICY}
      />,
    );

    await act(async () => {
      ref.current!.setText("/review");
    });

    expect(screen.getByText("/review-command")).toBeInTheDocument();
    expect(screen.queryByText("/review-skill")).not.toBeInTheDocument();
  });

  it.each([
    ["slash anywhere", SLASH_ANYWHERE_POLICY, "please /rev", "command", "please /review "],
    ["slash at start", SLASH_AT_START_POLICY, "/rev", "command", "/review "],
    ["dollar skill", DOLLAR_SKILLS_POLICY, "use $rev", "skill", "use $review "],
  ] as const)(
    "serializes a selected %s suggestion",
    async (_name, promptCommandPolicy, input, kind, expected) => {
      const ref = createRef<PromptEditorHandle>();
      render(
        <PromptEditor
          ref={ref}
          slashCommands={[{ name: "review", description: "Review changes", kind }]}
          slashCommandsLoading={false}
          promptCommandPolicy={promptCommandPolicy}
        />,
      );

      await act(async () => {
        ref.current!.setText(input);
      });
      await act(async () => {
        fireEvent.mouseDown(screen.getByText(`${kind === "skill" ? "$" : "/"}review`));
      });

      expect(ref.current!.getText()).toBe(expected);
    },
  );

  it("closes an open menu when the command policy changes", async () => {
    const ref = createRef<PromptEditorHandle>();
    const onArrowDown = vi.fn(() => null);
    const props = {
      ref,
      onArrowDown,
      slashCommands: [{ name: "review", description: "Review changes", kind: "skill" as const }],
      slashCommandsLoading: false,
    };
    const { rerender } = render(
      <PromptEditor {...props} promptCommandPolicy={SLASH_AT_START_POLICY} />,
    );

    await act(async () => {
      ref.current!.setText("/rev");
    });
    expect(screen.getByText("/review")).toBeInTheDocument();

    rerender(<PromptEditor {...props} promptCommandPolicy={DOLLAR_SKILLS_POLICY} />);
    expect(screen.queryByText("/review")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" });

    expect(onArrowDown).toHaveBeenCalledOnce();
  });

  it("selects a conversation with @@ and serializes its stable feature reference", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} mentionFeatureId={7} />);

    await act(async () => {
      ref.current!.setText("Compare @@auth");
    });
    await act(async () => {
      fireEvent.mouseDown(await screen.findByText("Authentication work"));
    });

    expect(ref.current!.getText()).toBe(
      "Compare [@@Cadencr / Authentication work](cadencr-conversation:feature/42) ",
    );
    expect(
      screen.getByRole("textbox").querySelector('[data-conversation-feature-id="42"]'),
    ).not.toBeNull();
  });

  it("restores serialized conversation references as editor tokens", async () => {
    const ref = createRef<PromptEditorHandle>();
    render(<PromptEditor ref={ref} />);
    await act(async () => {
      ref.current!.setText(
        "Read [@@Cadencr / Authentication work](cadencr-conversation:feature/42)",
      );
    });
    expect(
      screen.getByRole("textbox").querySelector('[data-conversation-feature-id="42"]'),
    ).not.toBeNull();
  });
});
