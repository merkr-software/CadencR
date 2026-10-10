import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CustomModelsSection,
  parseEffortLevels,
  validateEffortFields,
} from "./CustomModelsSection";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  customModelsQuery: vi.fn(),
}));

vi.mock("@/api/agentRuntime", () => ({
  useClaudeCodeCustomModels: () => mocks.customModelsQuery(),
  useDeleteClaudeCodeCustomModel: () => ({ mutate: vi.fn(), isPending: false }),
  useUpsertClaudeCodeCustomModel: () => ({ mutate: mocks.mutate, isPending: false }),
}));

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.customModelsQuery.mockReturnValue({
    data: { models: [] },
    isLoading: false,
    isError: false,
  });
});

describe("custom model effort fields", () => {
  it("parses user-entered effort levels in display order", () => {
    expect(parseEffortLevels(" low, medium, high, xhigh, max ")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("requires a supported default and rejects duplicates", () => {
    expect(validateEffortFields([], "")).toMatch(/at least one/i);
    expect(validateEffortFields(["low", "low"], "low")).toMatch(/unique/i);
    expect(validateEffortFields(["low", "high"], "medium")).toMatch(/default/i);
    expect(validateEffortFields(["low", "high"], "high")).toBeNull();
  });

  it("submits effort metadata when creating a custom model", async () => {
    const user = userEvent.setup();
    render(<CustomModelsSection />);

    // Fill fields with one paste each: per-keystroke `user.type` re-renders the
    // form ~70 times, which blew the 5s test budget on a loaded CI runner. The
    // assertion is about the submitted payload, not keystroke handling.
    const fill = async (placeholder: string, value: string) => {
      await user.click(screen.getByPlaceholderText(placeholder));
      await user.paste(value);
    };
    await user.click(screen.getByRole("button", { name: "New model" }));
    await fill("claude-sonnet-3-5-20241022", "gpt-5.6-luna");
    await fill("Sonnet 3.5 (legacy)", "GPT-5.6 Luna");
    await user.click(screen.getByRole("switch", { name: "Supports thinking effort" }));
    await fill("low, medium, high, xhigh", "low, medium, high, xhigh, max");
    await fill("medium (optional)", "medium");
    await user.click(screen.getByRole("button", { name: "Save model" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        modelId: "gpt-5.6-luna",
        data: {
          label: "GPT-5.6 Luna",
          description: undefined,
          supports_effort: true,
          supported_effort_levels: ["low", "medium", "high", "xhigh", "max"],
          default_effort_level: "medium",
        },
      },
      expect.any(Object),
    );
  });
});
