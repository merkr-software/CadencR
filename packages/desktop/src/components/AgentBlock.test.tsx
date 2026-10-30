import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import { AgentBlock, buildToolResultMap } from "./AgentBlock";
import type { AgentBlockData } from "@/types/agent-block";

// Mock InlineDiffBlock to avoid complex diff rendering
vi.mock("./InlineDiffBlock", () => ({
  InlineDiffBlock: ({ filePath }: { filePath: string }) => (
    <div data-testid="inline-diff">{filePath}</div>
  ),
}));

vi.mock("@/components/ui/collapsible-block", () => ({
  CollapsibleBlock: ({
    children,
    header,
  }: {
    children: ({ showAll }: { showAll: boolean }) => React.ReactNode;
    header: React.ReactNode;
    totalCount: number;
    visibleCount: number;
  }) => (
    <div>
      <div>{header}</div>
      <div>{children({ showAll: false })}</div>
    </div>
  ),
}));

function makeBlock(overrides: Partial<AgentBlockData>): AgentBlockData {
  return {
    id: "block-1",
    type: "text",
    content: "Default content",
    ...overrides,
  };
}

describe("AgentBlock", () => {
  describe("text block", () => {
    it("renders text content via Markdown", () => {
      render(<AgentBlock block={makeBlock({ type: "text", content: "Hello world" })} />);
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
  });

  describe("truncated persisted content", () => {
    it("renders a text preview through its renderer without fetching automatically", () => {
      render(
        <AgentBlock
          block={makeBlock({
            id: "msg-42",
            type: "text",
            content: "# Preview only",
            truncatedContent: true,
          })}
        />,
      );

      expect(screen.getByRole("heading", { name: "Preview only" })).toBeInTheDocument();
      expect(screen.getByText("Truncated")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument();
    });

    it("never surfaces a truncated tool call the stream hides", () => {
      for (const toolName of ["TodoWrite", "update_plan"]) {
        const { unmount } = render(
          <AgentBlock
            block={makeBlock({
              id: `msg-${toolName}`,
              type: "tool_call",
              toolName,
              content: "{}",
              toolArgs: "{}",
              truncatedContent: true,
            })}
          />,
        );
        expect(screen.queryByText(/Truncated/)).not.toBeInTheDocument();
        unmount();
      }
    });

    it("draws a truncated prompt without the actions that would resend it cut", () => {
      const control = render(
        <AgentBlock
          block={makeBlock({
            id: "msg-49",
            type: "user_message",
            content: JSON.stringify([{ type: "text", text: "whole prompt" }]),
          })}
        />,
      );
      expect(screen.getByTitle("Copy as Markdown")).toBeInTheDocument();
      control.unmount();

      render(
        <AgentBlock
          block={makeBlock({
            id: "msg-47",
            type: "user_message",
            content: JSON.stringify([{ type: "text", text: "see screenshot" }]),
            truncatedContent: true,
          })}
        />,
      );

      expect(screen.getByText("see screenshot")).toBeInTheDocument();
      expect(screen.queryByTitle("Copy as Markdown")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument();
    });

    it("hides the truncation line under a card the policy folded", () => {
      render(
        <AgentBlock
          block={makeBlock({
            id: "msg-48",
            type: "thinking",
            content: "long thought",
            truncatedContent: true,
          })}
          verbosityMode="collapsed"
          isCollapsedByPolicy
        />,
      );

      expect(screen.queryByText(/Truncated/)).not.toBeInTheDocument();
    });

    it("states the full size the server reported", () => {
      render(
        <AgentBlock
          block={makeBlock({
            id: "msg-46",
            type: "text",
            content: "preview",
            truncatedContent: true,
            fullContentBytes: 1_468_006,
          })}
        />,
      );

      expect(screen.getByText("Truncated · 1.4 MB")).toBeInTheDocument();
    });

    it("gates a truncated file-change tool before its normal renderer", () => {
      render(
        <AgentBlock
          block={makeBlock({
            id: "msg-43",
            type: "tool_call",
            toolName: "Write",
            content: JSON.stringify({ file_path: "src/foo.ts", content: "partial" }),
            toolArgs: JSON.stringify({ file_path: "src/foo.ts", content: "partial" }),
            truncatedContent: true,
          })}
        />,
      );

      expect(screen.queryByTestId("inline-diff")).not.toBeInTheDocument();
      expect(screen.getByText("Write")).toBeInTheDocument();
      expect(screen.queryByText("partial")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument();
    });

    it("gates truncated Bash arguments but leaves truncated output on the existing path", () => {
      const call = makeBlock({
        id: "msg-44",
        type: "tool_call",
        toolName: "Bash",
        toolUseId: "bash-1",
        content: JSON.stringify({ command: "pwd" }),
        toolArgs: JSON.stringify({ command: "pwd" }),
      });
      const result = makeBlock({
        id: "msg-45",
        type: "tool_result",
        sourceToolName: "Bash",
        toolUseId: "bash-1",
        content: JSON.stringify({ output: "preview" }),
        truncatedContent: true,
      });
      const { rerender } = render(<AgentBlock block={{ ...call, truncatedContent: true }} />);
      expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument();

      rerender(<AgentBlock block={call} toolResultMap={new Map([["bash-1", result]])} />);
      expect(screen.getByText("pwd")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
    });
  });

  describe("code block", () => {
    it("renders code with language label", () => {
      render(
        <AgentBlock
          block={makeBlock({ type: "code", content: "const x = 1;", language: "typescript" })}
        />,
      );
      expect(screen.getByText("typescript")).toBeInTheDocument();
      expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    });

    it("renders code without language", () => {
      render(<AgentBlock block={makeBlock({ type: "code", content: "some code" })} />);
      expect(screen.getByText("some code")).toBeInTheDocument();
    });
  });

  describe("tool_call block", () => {
    it("renders a Bash tool call with command", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Bash",
            toolArgs: JSON.stringify({ command: "ls -la" }),
          })}
        />,
      );
      expect(screen.getByText("ls -la")).toBeInTheDocument();
    });

    it("renders a generic tool call button", async () => {
      const user = userEvent.setup();
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Grep",
            toolArgs: JSON.stringify({ pattern: "foo" }),
          })}
        />,
      );
      expect(screen.getByText("Grep")).toBeInTheDocument();
      const buttons = screen.getAllByRole("button");
      await user.click(buttons[0]);
      expect(screen.getAllByText(/foo/).length).toBeGreaterThan(0);
    });

    it("renders persisted OpenCode task output when child blocks are absent", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Task",
            toolArgs: JSON.stringify({
              description: "Find session event parsing",
              output: "task_id: ses_123\n\n<task_result>\nTop finding\n</task_result>",
            }),
            childBlocks: [],
            // DB-loaded subagents are always complete (`serverBlocksToAgentBlocks`
            // sets this). Without it the block reads as still running, and its
            // last child renders as the live streaming block.
            taskComplete: true,
          })}
        />,
      );

      expect(screen.getByText("Find session event parsing")).toBeInTheDocument();
      expect(screen.getByText("Top finding")).toBeInTheDocument();
    });

    it("returns null for TodoWrite tool", () => {
      const { container } = render(
        <AgentBlock block={makeBlock({ type: "tool_call", toolName: "TodoWrite" })} />,
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders semantic skill reads as Skill without exposing the source path", async () => {
      const user = userEvent.setup();
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Read",
            toolArgs: JSON.stringify({
              type: "read",
              command: "cat .agents/skills/db/SKILL.md",
              path: "/repo/.agents/skills/db/SKILL.md",
            }),
          })}
        />,
      );

      expect(screen.getByText("Skill")).toBeInTheDocument();
      expect(screen.getByText("db")).toBeInTheDocument();
      await user.click(screen.getByRole("button"));
      expect(screen.queryByText(/SKILL\.md/)).not.toBeInTheDocument();
    });

    it("hides internal runtime tool calls", () => {
      const { container } = render(
        <AgentBlock block={makeBlock({ type: "tool_call", toolName: "update_plan" })} />,
      );
      expect(container).toBeEmptyDOMElement();
    });

    it("renders Write tool with InlineDiffBlock", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Write",
            toolArgs: JSON.stringify({ file_path: "src/foo.ts", content: "new content" }),
          })}
        />,
      );
      expect(screen.getByTestId("inline-diff")).toBeInTheDocument();
    });

    it("renders OpenCode Write tool with camelCase filePath", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Write",
            toolArgs: JSON.stringify({ filePath: "src/opencode.ts", content: "new content" }),
          })}
        />,
      );
      expect(screen.getByTestId("inline-diff")).toHaveTextContent("src/opencode.ts");
    });

    it("renders OpenCode Edit tool with camelCase args", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Edit",
            toolArgs: JSON.stringify({
              filePath: "src/edit-opencode.ts",
              oldString: "before",
              newString: "after",
            }),
          })}
        />,
      );
      expect(screen.getByTestId("inline-diff")).toHaveTextContent("src/edit-opencode.ts");
    });

    it("renders apply_patch add-file tool with InlineDiffBlock", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "apply_patch",
            toolArgs: JSON.stringify({
              patchText: "*** Begin Patch\n*** Add File: toto.txt\n+hello\n*** End Patch\n",
            }),
          })}
        />,
      );
      expect(screen.getByTestId("inline-diff")).toHaveTextContent("toto.txt");
    });

    it("renders ApplyPatch update-file tool with InlineDiffBlock", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "ApplyPatch",
            toolArgs: JSON.stringify({
              patch_text:
                "*** Begin Patch\n*** Update File: /workspace/toto.txt\n@@\n-Hello Cadencr\n+Hello Cadencr 2\n*** End Patch",
            }),
          })}
        />,
      );
      expect(screen.getByTestId("inline-diff")).toHaveTextContent("/workspace/toto.txt");
    });

    it("renders thinking block", () => {
      render(<AgentBlock block={makeBlock({ type: "thinking", content: "I am thinking..." })} />);
      expect(screen.getByText("Thinking")).toBeInTheDocument();
    });

    it("renders thinking markdown", () => {
      const { container } = render(
        <AgentBlock
          block={makeBlock({
            type: "thinking",
            content: "## Plan\n\n- keep reasoning blocks\n- preserve `markdown`",
          })}
        />,
      );
      expect(screen.getByRole("heading", { level: 2, name: "Plan" })).toBeInTheDocument();
      expect(container.querySelectorAll("li")).toHaveLength(2);
      expect(screen.getByText("markdown")).toHaveProperty("tagName", "CODE");
    });

    it("does not render empty thinking block", () => {
      const { container } = render(
        <AgentBlock block={makeBlock({ type: "thinking", content: "" })} />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe("user_message block", () => {
    it("renders user message content", () => {
      render(<AgentBlock block={makeBlock({ type: "user_message", content: "User said this" })} />);
      expect(screen.getByText("User said this")).toBeInTheDocument();
    });
  });

  describe("compact_divider block", () => {
    it("renders compacted divider", () => {
      render(<AgentBlock block={makeBlock({ type: "compact_divider", content: "" })} />);
      expect(screen.getByText("Compacted")).toBeInTheDocument();
    });

    it("renders Codex compact metadata details", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "compact_divider",
            content: JSON.stringify({ trigger: "manual", pre_tokens: 40123 }),
          })}
        />,
      );
      expect(screen.getByText("Compacted")).toBeInTheDocument();
      expect(screen.getByText("manual · 40,123 tokens")).toBeInTheDocument();
    });
  });

  describe("clear_divider block", () => {
    it("renders cleared divider", () => {
      render(<AgentBlock block={makeBlock({ type: "clear_divider", content: "" })} />);
      expect(screen.getByText("Cleared")).toBeInTheDocument();
    });

    it("renders previous session ID when provided", () => {
      render(
        <AgentBlock block={makeBlock({ type: "clear_divider", content: "cli-sess-abc123" })} />,
      );
      expect(screen.getByText("Cleared")).toBeInTheDocument();
      expect(screen.getByText("cli-sess-abc123")).toBeInTheDocument();
    });

    it("does not render session ID when content is empty", () => {
      const { container } = render(
        <AgentBlock block={makeBlock({ type: "clear_divider", content: "" })} />,
      );
      // Only the "Cleared" text and divider lines, no session ID span
      const spans = container.querySelectorAll("span");
      expect(spans).toHaveLength(1);
      expect(spans[0].textContent).toBe("Cleared");
    });
  });

  describe("tool_result block", () => {
    it("surfaces errors from hidden runtime tools", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_result",
            content: "Runtime coordination failed",
            sourceToolName: "update_plan",
            isError: true,
          })}
        />,
      );
      expect(screen.getByText("Runtime coordination failed")).toBeInTheDocument();
    });

    it("returns null for generic tool_result", () => {
      const { container } = render(
        <AgentBlock
          block={makeBlock({
            type: "tool_result",
            content: "some result",
            sourceToolName: "Grep",
          })}
        />,
      );
      expect(container.firstChild).toBeNull();
    });

    it("returns null for Bash tool_result (inlined into tool_call)", () => {
      const { container } = render(
        <AgentBlock
          block={makeBlock({
            type: "tool_result",
            content: "line1\nline2",
            sourceToolName: "Bash",
          })}
        />,
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders Bash output inlined via toolResultMap", () => {
      const toolUseId = "tu-1";
      const resultMap = new Map([
        [
          toolUseId,
          makeBlock({
            type: "tool_result",
            content: "line1\nline2",
            sourceToolName: "Bash",
            toolUseId,
          }),
        ],
      ]);
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Bash",
            toolArgs: JSON.stringify({ command: "ls" }),
            toolUseId,
          })}
          toolResultMap={resultMap}
        />,
      );
      expect(screen.getByText("ls")).toBeInTheDocument();
      expect(screen.getByText(/line1/)).toBeInTheDocument();
    });

    it("extracts Bash output from structured Codex tool results", () => {
      const toolUseId = "tu-codex";
      const resultMap = new Map([
        [
          toolUseId,
          makeBlock({
            type: "tool_result",
            content: JSON.stringify({
              command: "printf hi",
              output: "hi\n",
              status: "completed",
            }),
            sourceToolName: "Bash",
            toolUseId,
          }),
        ],
      ]);
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Bash",
            toolArgs: JSON.stringify({ command: "printf hi" }),
            toolUseId,
          })}
          toolResultMap={resultMap}
        />,
      );
      expect(screen.getByText("printf hi")).toBeInTheDocument();
      expect(screen.getByText("hi")).toBeInTheDocument();
      expect(screen.queryByText(/"command"/)).not.toBeInTheDocument();
    });

    it("does not render structured Bash JSON when Codex output is null", () => {
      const toolUseId = "tu-empty-codex";
      const resultMap = new Map([
        [
          toolUseId,
          makeBlock({
            type: "tool_result",
            content: JSON.stringify({
              command: "sed -n '1,160p' .zed/settings.json",
              cwd: "/tmp/project",
              exitCode: 0,
              output: null,
              status: "completed",
            }),
            sourceToolName: "Bash",
            toolUseId,
          }),
        ],
      ]);
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Bash",
            toolArgs: JSON.stringify({
              command: "sed -n '1,160p' .zed/settings.json",
              status: "completed",
            }),
            toolUseId,
          })}
          toolResultMap={resultMap}
        />,
      );
      expect(screen.getByText("sed -n '1,160p' .zed/settings.json")).toBeInTheDocument();
      expect(screen.getByText("No output")).toBeInTheDocument();
      expect(screen.queryByText(/"output":null/)).not.toBeInTheDocument();
    });

    it("returns null for Edit tool_result (inlined into tool_call)", () => {
      const { container } = render(
        <AgentBlock
          block={makeBlock({ type: "tool_result", content: "ok", sourceToolName: "Edit" })}
        />,
      );
      expect(container.firstChild).toBeNull();
    });

    it("returns null for Write tool_result (inlined into tool_call)", () => {
      const { container } = render(
        <AgentBlock
          block={makeBlock({ type: "tool_result", content: "ok", sourceToolName: "Write" })}
        />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe("Bash tool_call", () => {
    it("shows Bash label in header", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Bash",
            toolArgs: JSON.stringify({ command: "echo hi" }),
          })}
        />,
      );
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });

    it("shows running indicator when no result available", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Bash",
            toolArgs: JSON.stringify({ command: "sleep 10" }),
            toolUseId: "tu-2",
          })}
          toolResultMap={new Map()}
        />,
      );
      expect(screen.getByText("Running…")).toBeInTheDocument();
    });

    it("shows Bash output from tool args when no tool_result exists", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Bash",
            toolArgs: JSON.stringify({ command: "pwd", output: "/tmp/project\n" }),
            toolUseId: "tu-3",
          })}
          toolResultMap={new Map()}
        />,
      );
      expect(screen.getByText("pwd")).toBeInTheDocument();
      expect(screen.getByText(/\/tmp\/project/)).toBeInTheDocument();
    });

    it("does not show running state for restored completed Bash output", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Bash",
            toolArgs: JSON.stringify({ command: "pnpm lint", status: "completed", output: "ok\n" }),
            toolUseId: "tu-4",
          })}
          toolResultMap={new Map()}
        />,
      );
      expect(screen.getByText("pnpm lint")).toBeInTheDocument();
      expect(screen.queryByText("Running…")).not.toBeInTheDocument();
      expect(screen.getByText("ok")).toBeInTheDocument();
    });
  });

  describe("restored tool call details", () => {
    it("shows restored Read file detail from persisted tool args", () => {
      render(
        <AgentBlock
          block={makeBlock({
            type: "tool_call",
            toolName: "Read",
            toolArgs: JSON.stringify({
              file_path: "packages/service/src/main.rs",
              status: "completed",
            }),
          })}
        />,
      );

      expect(screen.getByText("Read")).toBeInTheDocument();
      expect(screen.getByText("packages/service/src/main.rs")).toBeInTheDocument();
    });
  });

  describe("buildToolResultMap", () => {
    it("builds a map of toolUseId to tool_result blocks", () => {
      const blocks = [
        makeBlock({ type: "tool_call", toolName: "Bash", toolUseId: "tu-1" }),
        makeBlock({
          id: "r1",
          type: "tool_result",
          content: "out",
          toolUseId: "tu-1",
          sourceToolName: "Bash",
        }),
        makeBlock({ type: "text", content: "hello" }),
      ];
      const map = buildToolResultMap(blocks);
      expect(map.size).toBe(1);
      expect(map.get("tu-1")?.content).toBe("out");
    });

    it("returns empty map when no tool_results exist", () => {
      const map = buildToolResultMap([makeBlock({ type: "text", content: "hi" })]);
      expect(map.size).toBe(0);
    });
  });
});
