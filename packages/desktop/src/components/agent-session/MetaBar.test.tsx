import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { setProviderCatalogMetadata } from "@/lib/provider-catalog-registry";
import { PROVIDER_IDS } from "@/lib/providers";
import { formatCompactCombo } from "@/lib/shortcuts/format";
import { parseThinkingEffort } from "@/shared/thinking-effort";
import { MetaBar, type MetaBarProps } from "./MetaBar";

const THINKING_LOW = parseThinkingEffort("low")!;
const THINKING_MEDIUM = parseThinkingEffort("medium")!;
const THINKING_HIGH = parseThinkingEffort("high")!;

const CODEX_ACCESS_MODES = [
  {
    id: "default" as const,
    label: "Default",
    description: "Runs in the workspace-write sandbox with approval requests routed to you.",
  },
  {
    id: "fullAccess" as const,
    label: "Full Access",
    description: "Disables sandboxing and approval prompts.",
  },
  {
    id: "autoReview" as const,
    label: "Auto Review",
    description: "Codex can automatically review approval requests.",
  },
];

/**
 * The mode chip is the central UI of the per-provider mode alignment work, so
 * lock its labels, colors, and visibility down with focused render tests.
 *
 * MetaBar has many other chips and a model picker — we provide the minimum
 * props needed to render and only assert on the mode chip.
 */
function renderChip(overrides: Partial<MetaBarProps> = {}) {
  const baseProps: MetaBarProps = {
    showAutoScrollChip: false,
    autoScrollEnabled: false,
    onToggleAutoScroll: vi.fn(),
    showWorktreeChip: false,
    models: [],
    onPermissionModeToggle: vi.fn(),
    permissionMode: "acceptEdits",
    currentSelection: { providerId: PROVIDER_IDS.CLAUDE_CODE, modelId: "claude-sonnet" },
    providerAccessModes: CODEX_ACCESS_MODES,
    ...overrides,
  };
  return render(<MetaBar {...baseProps} />);
}

describe("MetaBar mode chip", () => {
  // Chip color tokens route through the active theme (see
  // lib/provider-modes.ts). Identities that fall outside the canonical
  // Dracula palette (violet / fuchsia / blue) live under `--chip-*`; the
  // ones that match Dracula directly stay on `--acc-*`. These assertions
  // check the var name rather than a Tailwind named color.
  it("renders 'Auto-Accept Edits' with violet styling for Claude Code's primary mode", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CLAUDE_CODE, modelId: "claude-sonnet" },
      permissionMode: "acceptEdits",
    });
    const chip = screen.getByRole("button", {
      name: /Permission mode: Auto-Accept Edits/i,
    });
    expect(chip).toBeInTheDocument();
    expect(chip.className).toMatch(/--chip-violet/);
  });

  it("renders 'Plan' with green styling when Claude is in plan mode", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CLAUDE_CODE, modelId: "claude-sonnet" },
      permissionMode: "plan",
    });
    const chip = screen.getByRole("button", { name: /Permission mode: Plan/i });
    expect(chip.className).toMatch(/--acc-green/);
  });

  it("renders 'Auto' with yellow styling for Claude's classifier-backed mode", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CLAUDE_CODE, modelId: "claude-sonnet" },
      permissionMode: "auto",
    });
    const chip = screen.getByRole("button", {
      name: /Permission mode: Auto\b/i,
    });
    expect(chip.className).toMatch(/--acc-yellow/);
  });

  it("renders Claude bypass as the normal permission mode chip when enabled", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CLAUDE_CODE, modelId: "claude-sonnet" },
      permissionMode: "bypassPermissions",
      enabledOptInModes: ["bypassPermissions"],
      runtimeSessionId: "claude-session-123",
    });
    const chip = screen.getByRole("button", {
      name: /Permission mode: Bypass/i,
    });
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute(
      "title",
      expect.stringContaining(`(${formatCompactCombo(["shift", "tab"])} to cycle)`),
    );
    expect(chip.className).toMatch(/--acc-red/);
    expect(screen.queryByRole("button", { name: /Claude access mode/i })).toBeNull();
  });

  it("renders 'Build' with fuchsia styling for OpenCode's primary mode", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.OPENCODE, modelId: "opencode-model" },
      permissionMode: "acceptEdits",
    });
    const chip = screen.getByRole("button", {
      name: /Permission mode: Build/i,
    });
    expect(chip.className).toMatch(/--chip-fuchsia/);
  });

  it("renders Codex default collaboration state as a grey Default chip", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "codex-model" },
      permissionMode: "default",
    });
    const chip = screen.getByRole("button", {
      name: /Permission mode: Default/i,
    });
    expect(chip).toHaveTextContent("Default");
    expect(chip.className).toMatch(/text-muted-foreground/);
  });

  it("renders Codex plan state as a colored Plan chip", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "codex-model" },
      permissionMode: "plan",
    });
    const chip = screen.getByRole("button", {
      name: /Permission mode: Plan/i,
    });
    expect(chip).toHaveTextContent("Plan");
    expect(chip.className).toMatch(/--chip-fuchsia/);
  });

  it("does not render Full Access as Codex's collaboration mode chip", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "codex-model" },
      permissionMode: "bypassPermissions",
      enabledOptInModes: ["bypassPermissions"],
    });
    expect(screen.queryByRole("button", { name: /Permission mode: Full Access/i })).toBeNull();
  });

  it("renders Codex access mode as a separate chip without a shortcut", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "codex-model" },
      accessMode: "autoReview",
      onAccessModeChange: vi.fn(),
      runtimeSessionId: "thread-123",
    });
    const chip = screen.getByRole("button", {
      name: /Codex access mode: Auto Review/i,
    });
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("title", expect.not.stringMatching(/Shift\\+Tab/i));
  });

  it("shows no host access chip for an installed provider without catalog access modes", () => {
    renderChip({
      currentSelection: { providerId: "cursor", modelId: "cursor-model" },
      accessMode: "autoReview",
      onAccessModeChange: vi.fn(),
      runtimeSessionId: "cursor-chat-123",
    });

    expect(screen.queryByRole("button", { name: /access mode/i })).not.toBeInTheDocument();
  });

  it("renders the access chip from an installed provider's catalog access modes", () => {
    setProviderCatalogMetadata([
      { id: "cursor", label: "Cursor", access_modes: CODEX_ACCESS_MODES },
    ]);
    try {
      renderChip({
        currentSelection: { providerId: "cursor", modelId: "cursor-model" },
        accessMode: "autoReview",
        onAccessModeChange: vi.fn(),
        runtimeSessionId: "cursor-chat-123",
      });

      expect(screen.getByRole("button", { name: /Cursor access mode/i })).toBeInTheDocument();
    } finally {
      setProviderCatalogMetadata([]);
    }
  });

  it("opens a Codex access mode popover and selects a mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "codex-model" },
      accessMode: "default",
      onAccessModeChange: onChange,
      runtimeSessionId: "thread-123",
    });

    await user.click(screen.getByRole("button", { name: /Codex access mode: Default/i }));

    expect(screen.getByText("Codex access mode")).toBeInTheDocument();
    expect(screen.getByText(/Runs in the workspace-write sandbox/i)).toBeInTheDocument();
    expect(screen.getByText(/Disables sandboxing and approval prompts/i)).toBeInTheDocument();
    expect(screen.getByText(/automatically review approval requests/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Full Access/i }));
    expect(onChange).toHaveBeenCalledWith("fullAccess");
    expect(screen.queryByText("Codex access mode")).not.toBeInTheDocument();
  });

  it("shows the current conversation mode on the chip but selects the new-conversation default in the popover", async () => {
    const user = userEvent.setup();
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "codex-model" },
      accessMode: "default",
      accessModeDefault: "fullAccess",
      onAccessModeChange: vi.fn(),
      runtimeSessionId: "thread-123",
    });

    await user.click(screen.getByRole("button", { name: /Codex access mode: Default/i }));

    expect(screen.getByText(/This conversation is using Default/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Full Access/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps collaboration mode in the left group and places access mode before session info", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "codex-model" },
      permissionMode: "default",
      accessMode: "default",
      onAccessModeChange: vi.fn(),
      runtimeSessionId: "thread-123",
      onPause: vi.fn(),
    });
    const modeChip = screen.getByRole("button", {
      name: /Permission mode: Default/i,
    });
    const accessChip = screen.getByRole("button", {
      name: /Codex access mode: Default/i,
    });
    const infoChip = screen.getByRole("button", { name: /Session info/i });

    expect(modeChip.compareDocumentPosition(accessChip)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(accessChip.compareDocumentPosition(infoChip)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("hides the chip entirely when no toggle handler is wired (kickoff scenarios)", () => {
    renderChip({ onPermissionModeToggle: undefined });
    expect(screen.queryByRole("button", { name: /Permission mode/i })).toBeNull();
  });

  it("renders a disabled loader in the model chip while no selection is confirmed", () => {
    renderChip({
      onModelChange: vi.fn(),
      currentSelection: null,
      models: [],
      providers: [],
    });

    const loader = screen.getByRole("button", {
      name: "Loading model catalog",
    });
    expect(loader).toBeDisabled();
  });

  it("renders fast mode beside the thinking control and toggles it accessibly", async () => {
    const user = userEvent.setup();
    const onFastModeChange = vi.fn();
    const { container } = renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "gpt-5.6-sol" },
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
      onModelChange: vi.fn(),
      supportedThinkingEfforts: [THINKING_LOW, THINKING_MEDIUM, THINKING_HIGH],
      currentThinkingEffort: THINKING_MEDIUM,
      onThinkingEffortChange: vi.fn(),
      supportsFastMode: true,
      fastMode: false,
      onFastModeChange,
    });

    const thinking = screen.getByRole("button", { name: "Cycle thinking effort" });
    const toggle = screen.getByRole("button", { name: "Turn fast mode on" });
    expect(thinking.compareDocumentPosition(toggle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("data-state", "off");
    expect(toggle.className).not.toMatch(/bg-primary|text-primary/);
    expect(toggle.className).toMatch(/chip-violet-soft/);
    expect(container.firstElementChild?.className).toMatch(/@container/);
    expect(screen.getByText("Fast").className).toMatch(/@max-\[40rem\]:hidden/);

    await user.click(toggle);
    expect(onFastModeChange).toHaveBeenCalledWith(true);
  });

  it("styles the pressed fast-mode state with charged violet chip tokens", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "gpt-5.6-sol" },
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
      onModelChange: vi.fn(),
      supportsFastMode: true,
      fastMode: true,
      onFastModeChange: vi.fn(),
    });

    const toggle = screen.getByRole("button", { name: "Turn fast mode off" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("data-state", "on");
    expect(toggle.className).not.toMatch(/bg-primary|text-primary/);
    expect(toggle.className).toMatch(/chip-violet-bg/);
    expect(toggle.className).toMatch(/chip-violet-soft/);
    expect(toggle.className).toMatch(/font-semibold/);
  });

  it("shows a disabled loader while fast mode is being confirmed", () => {
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CODEX_CLI, modelId: "gpt-5.6-sol" },
      models: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
      onModelChange: vi.fn(),
      supportsFastMode: true,
      fastMode: true,
      isFastModePending: true,
      onFastModeChange: vi.fn(),
    });

    const toggle = screen.getByRole("button", { name: "Turn fast mode off" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-busy", "true");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("data-state", "on");
  });

  it("puts the pre-first-prompt profile selector inside Info", async () => {
    const user = userEvent.setup();
    renderChip({
      currentSelection: { providerId: PROVIDER_IDS.CLAUDE_CODE, modelId: "claude-sonnet" },
      showClaudeProfileSelector: true,
      claudeProfile: "default",
      claudeProfiles: [{ name: "bedrock", env: {} }],
      claudeProfilesLoading: false,
      claudeProfilesError: false,
      onClaudeProfileChange: vi.fn(),
      showReadOnlyModel: true,
      showWorktreeChip: false,
    });

    expect(screen.queryByRole("combobox", { name: "Profile" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Session info" }));
    expect(screen.getByRole("combobox", { name: "Profile" })).toBeInTheDocument();
    expect(screen.queryByText("Session ID")).not.toBeInTheDocument();
  });
});

describe("MetaBar negotiated session configuration", () => {
  it("renders opaque ACP options and waits for an authoritative update", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderChip({
      sessionConfigControls: {
        supported: true,
        loading: false,
        error: null,
        pendingId: null,
        config: {
          options: [
            {
              id: "safe_mode",
              name: "Safe mode",
              description: "Use conservative behavior",
              category: "_fixture",
              type: "boolean",
              current_value: false,
            },
          ],
        },
        onRefresh: vi.fn(),
        onChange,
      },
    });

    await user.click(screen.getByRole("button", { name: "Session configuration" }));
    const toggle = screen.getByRole("switch", { name: "Safe mode" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText("_fixture")).toBeInTheDocument();

    await user.click(toggle);

    expect(onChange).toHaveBeenCalledWith("safe_mode", true);
    expect(toggle).not.toBeChecked();
  });

  it("does not render a configuration chip after the runtime declines it", () => {
    renderChip({
      sessionConfigControls: {
        supported: false,
        loading: false,
        error: null,
        pendingId: null,
        config: null,
        onRefresh: vi.fn(),
        onChange: vi.fn(),
      },
    });
    expect(screen.queryByRole("button", { name: "Session configuration" })).toBeNull();
  });

  it("does not render a configuration chip for an inactive persisted runtime", () => {
    renderChip({
      sessionConfigControls: {
        supported: false,
        loading: false,
        error: null,
        pendingId: null,
        config: null,
        onRefresh: vi.fn(),
        onChange: vi.fn(),
      },
    });

    expect(screen.queryByRole("button", { name: "Session configuration" })).toBeNull();
  });

  it("keeps initial loading and actionable failures visible", async () => {
    const user = userEvent.setup();
    const { unmount } = renderChip({
      sessionConfigControls: {
        supported: null,
        loading: true,
        error: null,
        pendingId: null,
        config: null,
        onRefresh: vi.fn(),
        onChange: vi.fn(),
      },
    });
    expect(screen.getByRole("button", { name: "Session configuration" })).toBeInTheDocument();

    unmount();
    renderChip({
      sessionConfigControls: {
        supported: null,
        loading: false,
        error: "Configuration request failed",
        pendingId: null,
        config: null,
        onRefresh: vi.fn(),
        onChange: vi.fn(),
      },
    });
    await user.click(screen.getByRole("button", { name: "Session configuration" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Configuration request failed");
  });

  it("keeps model and thinking changes on their durable primary controls", () => {
    renderChip({
      sessionConfigControls: {
        supported: true,
        loading: false,
        error: null,
        pendingId: null,
        config: {
          options: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              current_value: "model-1",
              choices: { layout: "ungrouped", options: [] },
            },
            {
              id: "thought_level",
              name: "Thinking",
              category: "thought_level",
              type: "select",
              current_value: "high",
              choices: { layout: "ungrouped", options: [] },
            },
          ],
        },
        onRefresh: vi.fn(),
        onChange: vi.fn(),
      },
    });

    expect(screen.queryByRole("button", { name: "Session configuration" })).toBeNull();
  });
});
