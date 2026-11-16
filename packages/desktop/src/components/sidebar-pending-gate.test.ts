import { describe, expect, it } from "vitest";
import {
  buildOptions,
  effectiveGateKind,
  gatePrompt,
  gateQuestions,
  permissionContext,
  PLAN_READY_LABEL,
  sidebarGatePrompt,
  triggerPendingKind,
} from "./sidebar-pending-gate";
import type { FeaturePendingGateResponse } from "@/api/generated";

function gate(
  partial: Partial<FeaturePendingGateResponse> &
    Pick<FeaturePendingGateResponse, "kind" | "payload">,
): FeaturePendingGateResponse {
  return {
    session_id: 1,
    request_id: "req-1",
    last_assistant_text: null,
    ...partial,
  };
}

describe("effectiveGateKind", () => {
  it("promotes AskUserQuestion permission payloads to question", () => {
    expect(
      effectiveGateKind(
        gate({
          kind: "permission",
          payload: {
            tool_name: "AskUserQuestion",
            tool_input: { question: "Ship it?", options: ["Yes", "No"] },
          },
        }),
      ),
    ).toBe("question");
  });
});

describe("gatePrompt", () => {
  it("shows the shell command for permission gates", () => {
    expect(
      gatePrompt(
        gate({
          kind: "permission",
          payload: {
            tool_name: "Bash",
            description: "The provider requests permission to use Bash",
            tool_input: { command: "git status" },
          },
        }),
      ),
    ).toBe("Bash: git status");
  });

  it("shows the question text for AskUserQuestion", () => {
    expect(
      gatePrompt(
        gate({
          kind: "permission",
          payload: {
            tool_name: "AskUserQuestion",
            description: "The provider requests permission to use AskUserQuestion",
            tool_input: { question: "Which target?", options: ["A", "B"] },
          },
        }),
      ),
    ).toBe("Which target?");
  });
});

describe("gateQuestions", () => {
  it("reads the questions of an AskUserQuestion request, whatever the API kind", () => {
    const questions = gateQuestions(
      gate({
        kind: "permission",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: { question: "Which target?", options: [{ label: "Staging" }] },
        },
      }),
    );
    expect(questions.map((question) => question.question)).toEqual(["Which target?"]);
  });

  it("is empty for a request without tool input", () => {
    expect(gateQuestions(gate({ kind: "permission", payload: {} }))).toEqual([]);
  });
});

describe("sidebarGatePrompt", () => {
  it("names a plan by its label and anything else by its prompt", () => {
    expect(sidebarGatePrompt(gate({ kind: "plan", payload: { description: "x" } }))).toBe(
      PLAN_READY_LABEL,
    );
    expect(
      sidebarGatePrompt(
        gate({ kind: "permission", payload: { tool_name: "Bash", tool_input: { command: "ls" } } }),
      ),
    ).toBe("Bash: ls");
  });
});

describe("gatePrompt fallbacks", () => {
  it("falls back to the payload description, then the tool name", () => {
    expect(
      gatePrompt(
        gate({ kind: "permission", payload: { tool_name: "Edit", description: "Edit it" } }),
      ),
    ).toBe("Edit it");
    expect(gatePrompt(gate({ kind: "permission", payload: { tool_name: " Edit " } }))).toBe("Edit");
  });

  it("shows the command alone when no tool is named", () => {
    expect(gatePrompt(gate({ kind: "permission", payload: { pattern: "git *" } }))).toBe("git *");
  });
});

describe("triggerPendingKind", () => {
  it("prefers loaded gate classification over live status", () => {
    expect(triggerPendingKind("permission", "question")).toBe("question");
  });
});

describe("permissionContext", () => {
  it("separates the command, the tool and the agent's justification", () => {
    expect(
      permissionContext(
        gate({
          kind: "permission",
          last_assistant_text: "Checking the script",
          payload: {
            tool_name: "Bash",
            tool_input: { command: "sh check.sh", description: "Run check.sh script" },
            preview: "sh check.sh",
            description: "This command requires approval",
          },
        }),
      ),
    ).toEqual({
      toolName: "Bash",
      command: "sh check.sh",
      justification: "Run check.sh script",
    });
  });

  it("falls back to the last assistant text, then the payload description", () => {
    const payload = { tool_name: "Bash", tool_input: { command: "ls" }, description: "Needs OK" };
    expect(
      permissionContext(gate({ kind: "permission", last_assistant_text: "Listing", payload }))
        .justification,
    ).toBe("Listing");
    expect(permissionContext(gate({ kind: "permission", payload })).justification).toBe("Needs OK");
  });

  it("has no justification that only repeats the command", () => {
    expect(
      permissionContext(
        gate({
          kind: "permission",
          payload: { tool_name: "Bash", tool_input: { command: "ls" }, description: "ls" },
        }),
      ).justification,
    ).toBeNull();
  });
});

describe("buildOptions for permissions", () => {
  it("keeps the provider's order, actions and feedback flag, with fallback labels", () => {
    const options = buildOptions(
      gate({
        kind: "permission",
        payload: {
          options: [
            { decision: "deny", collect_feedback: true },
            { decision: "allow_future" },
            { decision: "allow_once", label: " Go " },
            { decision: "bogus", label: "Nope" },
          ],
        },
      }),
    );
    expect(options.map((option) => [option.action, option.label, option.collectFeedback])).toEqual([
      ["deny", "Deny", true],
      ["allow_always", "Always allow", false],
      ["allow_once", "Go", false],
    ]);
  });
});
