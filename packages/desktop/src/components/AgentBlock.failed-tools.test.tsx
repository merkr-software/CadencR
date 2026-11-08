import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { AgentBlock } from "./AgentBlock";
import { buildToolResultMap } from "@/lib/tool-results";
import type { AgentBlockData } from "@/types/agent-block";

/**
 * The blocks a Codex exploring command produces, as the conversation's history
 * hydrates them: a Read/LS/Grep call per command action, and, when the command
 * failed, an error result under the same tool use id.
 */
function call(toolName: string, toolArgs: object): AgentBlockData {
  return {
    id: `call-${toolName}`,
    type: "tool_call",
    content: "",
    toolName,
    toolArgs: JSON.stringify(toolArgs),
    toolUseId: `exec-1:command_action:${toolName}`,
  };
}

function result(of: AgentBlockData, content: string, isError: boolean): AgentBlockData {
  return {
    id: `result-${of.id}`,
    type: "tool_result",
    content,
    isError,
    toolUseId: of.toolUseId,
    sourceToolName: of.toolName,
  };
}

const missingRead = call("Read", {
  type: "read",
  command: "cat missing-file.txt",
  name: "missing-file.txt",
  path: "/repo/missing-file.txt",
});

describe("AgentBlock failed generic tool calls", () => {
  /** Found in QA: the error was saved but the Read card showed only its arguments. */
  it("shows a failed Read with its error message in Maximal", () => {
    const failure = result(missingRead, "cat: missing-file.txt: No such file or directory", true);
    const { container } = render(
      <AgentBlock
        block={missingRead}
        toolResultMap={buildToolResultMap([missingRead, failure])}
        verbosityMode="maximal"
      />,
    );

    expect(screen.getByText("cat: missing-file.txt: No such file or directory")).toBeTruthy();
    expect(container.querySelector("[data-tool-failed]")).not.toBeNull();
    expect(screen.getByText("Read").className).toContain("text-destructive");
  });

  it.each([
    ["LS", { type: "list", path: "/repo/missing" }, "ls: /repo/missing: No such file or directory"],
    ["Grep", { type: "search", query: "x(", path: "." }, "rg: regex parse error"],
  ])("shows a failed %s with its error message", (toolName, args, message) => {
    const failed = call(toolName, args);
    render(
      <AgentBlock
        block={failed}
        toolResultMap={buildToolResultMap([failed, result(failed, message, true)])}
      />,
    );

    expect(screen.getByText(message)).toBeTruthy();
  });

  it("keeps a successful result folded into its call", () => {
    const read = call("Read", { type: "read", path: "/repo/present.txt" });
    const { container } = render(
      <AgentBlock
        block={read}
        toolResultMap={buildToolResultMap([read, result(read, "hello", false)])}
      />,
    );

    expect(screen.queryByText("hello")).toBeNull();
    expect(container.querySelector("[data-tool-failed]")).toBeNull();
  });

  it("names the failure when the error result carries no message", () => {
    render(
      <AgentBlock
        block={missingRead}
        toolResultMap={buildToolResultMap([missingRead, result(missingRead, "", true)])}
      />,
    );

    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("does not draw the error a second time as its own row", () => {
    const failure = result(missingRead, "cat: missing-file.txt: No such file or directory", true);
    const { container } = render(<AgentBlock block={failure} />);

    expect(container.firstChild).toBeNull();
  });
});
