import { describe, expect, it } from "vitest";
import type { VirtualSkillPayload } from "@/api/generated";
import { parseThinkingEffort } from "@/shared/thinking-effort";
import {
  applyVirtualSkillConfig,
  hasVirtualSkillParameters,
  virtualSkillCommandOf,
} from "./virtual-skill-config";

function skill(overrides: Partial<VirtualSkillPayload> = {}): VirtualSkillPayload {
  return {
    command: "cadencr:review",
    description: "Review",
    details: "Spawns a reviewer.",
    argument_hint: "unstaged or branch",
    parameters: { agent: true, worktrees: ["same", "new", "project"] },
    ...overrides,
  };
}

describe("virtualSkillCommandOf", () => {
  it("reads the command from either trigger at the prompt start", () => {
    expect(virtualSkillCommandOf("/cadencr:review branch")).toBe("cadencr:review");
    expect(virtualSkillCommandOf("  $cadencr:handoff")).toBe("cadencr:handoff");
  });

  it("ignores anything that is not a leading cadencr command", () => {
    expect(virtualSkillCommandOf("please /cadencr:review")).toBeNull();
    expect(virtualSkillCommandOf("/review")).toBeNull();
    expect(virtualSkillCommandOf("/cadencr:reviewer2")).toBeNull();
  });
});

describe("hasVirtualSkillParameters", () => {
  it("skips skills with nothing to configure", () => {
    expect(hasVirtualSkillParameters(skill())).toBe(true);
    expect(hasVirtualSkillParameters(skill({ parameters: { agent: false, worktrees: [] } }))).toBe(
      false,
    );
    expect(
      hasVirtualSkillParameters(skill({ parameters: { agent: false, worktrees: ["new"] } })),
    ).toBe(false);
  });
});

describe("applyVirtualSkillConfig", () => {
  it("writes the pinned values as flags after the command", () => {
    expect(
      applyVirtualSkillConfig("/cadencr:review branch", skill(), {
        target: { providerId: "codex", modelId: "gpt-5" },
        thinking: parseThinkingEffort("high"),
        permissionMode: "plan",
        worktree: "new",
      }),
    ).toBe(
      "/cadencr:review --provider=codex --model=gpt-5 --thinking=high --mode=plan --worktree=new branch",
    );
  });

  it("leaves the prompt alone when nothing differs from the defaults", () => {
    expect(applyVirtualSkillConfig("/cadencr:review", skill(), {})).toBe("/cadencr:review");
    expect(applyVirtualSkillConfig("/cadencr:review x", skill(), { worktree: "same" })).toBe(
      "/cadencr:review x",
    );
  });

  it("only pins thinking and mode alongside a pinned model", () => {
    expect(
      applyVirtualSkillConfig("$cadencr:review", skill(), {
        thinking: parseThinkingEffort("high"),
        permissionMode: "plan",
        worktree: "project",
      }),
    ).toBe("$cadencr:review --worktree=project");
  });

  it("never touches a prompt for another skill", () => {
    expect(
      applyVirtualSkillConfig("/cadencr:handoff", skill(), {
        target: { providerId: "codex", modelId: "gpt-5" },
      }),
    ).toBe("/cadencr:handoff");
  });
});
