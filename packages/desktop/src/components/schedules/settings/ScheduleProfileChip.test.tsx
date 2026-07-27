import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import type { ScheduleTarget } from "@/api/generated";
import { PROVIDER_IDS } from "@/lib/providers";
import { ScheduleProfileChip } from "./ScheduleProfileChip";
import type { ScheduleRuntime } from "./useScheduleRuntime";

const { mockUseClaudeCodeProfiles } = vi.hoisted(() => ({
  mockUseClaudeCodeProfiles: vi.fn(),
}));

vi.mock("@/api/agentRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/agentRuntime")>()),
  useClaudeCodeProfiles: (...args: unknown[]) => mockUseClaudeCodeProfiles(...args),
}));

const TARGET: ScheduleTarget = { kind: "new_conversation", project_id: 1, worktree_mode: "skip" };

function runtime(providerId: string | undefined): ScheduleRuntime {
  return { providerId, profile: undefined, isResolving: false } as unknown as ScheduleRuntime;
}

function profilesResult(names: string[], overrides: Record<string, unknown> = {}) {
  return {
    data: { profiles: names.map((name) => ({ name, env: {} })), active: names[0] },
    isLoading: false,
    isError: false,
    ...overrides,
  };
}

function renderChip(providerId: string | undefined = PROVIDER_IDS.CLAUDE_CODE) {
  return render(
    <ScheduleProfileChip target={TARGET} onChange={vi.fn()} runtime={runtime(providerId)} />,
  );
}

describe("ScheduleProfileChip", () => {
  beforeEach(() => {
    mockUseClaudeCodeProfiles.mockReset();
    mockUseClaudeCodeProfiles.mockReturnValue(profilesResult(["work", "personal"]));
  });

  it("offers the profiles once they resolve", () => {
    renderChip();
    expect(screen.getByRole("combobox", { name: "Claude profile" })).toBeInTheDocument();
  });

  it("renders nothing for a provider that has no profile axis", () => {
    renderChip(PROVIDER_IDS.CODEX_CLI);
    expect(screen.queryByRole("combobox", { name: "Claude profile" })).not.toBeInTheDocument();
  });

  it("stays hidden once resolved with only the default profile", () => {
    mockUseClaudeCodeProfiles.mockReturnValue(profilesResult([]));
    renderChip();
    expect(screen.queryByRole("combobox", { name: "Claude profile" })).not.toBeInTheDocument();
    expect(screen.queryByText("Loading profiles…")).not.toBeInTheDocument();
  });

  // The emptiness check used to run against the in-flight cache too, so the
  // chip was absent until the fetch settled and then popped into the row.
  it("shows a pending state while the profiles load", () => {
    mockUseClaudeCodeProfiles.mockReturnValue(profilesResult([], { isLoading: true }));
    renderChip();
    expect(screen.getByText("Loading profiles…")).toBeInTheDocument();
  });

  // Same swallow, worse outcome: a failed fetch looked exactly like a provider
  // that simply has no profiles.
  it("surfaces a failed profile load", () => {
    mockUseClaudeCodeProfiles.mockReturnValue(profilesResult([], { isError: true }));
    renderChip();
    expect(screen.getByText("Failed to load profiles")).toBeInTheDocument();
  });
});
