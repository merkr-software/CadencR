import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { PROVIDER_IDS } from "@/lib/providers";
import { parseThinkingEffort } from "@/shared/thinking-effort";
import { MetaBar, type MetaBarProps } from "./MetaBar";
import { MODEL_CATALOG_LOADING_LABEL } from "./useAgentSessionModelState";

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
const CURSOR_ACCESS_MODES = [
  { id: "default" as const, label: "Default", description: "Uses Cursor approval rules." },
  {
    id: "fullAccess" as const,
    label: "Full Access",
    description: "Starts Cursor with Run Everything enabled.",
  },
  {
    id: "autoReview" as const,
    label: "Auto Review",
    description: "Cursor's classifier reviews other Shell, MCP, and Fetch calls.",
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
  const accessProvider = overrides.runtimeProvider ?? overrides.currentProviderId;
  const baseProps: MetaBarProps = {
    showAutoScrollChip: false,
    autoScrollEnabled: false,
    onToggleAutoScroll: vi.fn(),
    showWorktreeChip: false,
    currentModelLabel: "claude-sonnet",
    models: [],
    onPermissionModeToggle: vi.fn(),
    permissionMode: "acceptEdits",
    currentProviderId: PROVIDER_IDS.CLAUDE_CODE,
    providerAccessModes:
      accessProvider === PROVIDER_IDS.CURSOR ? CURSOR_ACCESS_MODES : CODEX_ACCESS_MODES,
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
      currentProviderId: PROVIDER_IDS.CLAUDE_CODE,
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
      currentProviderId: PROVIDER_IDS.CLAUDE_CODE,
      permissionMode: "plan",
    });
    const chip = screen.getByRole("button", { name: /Permission mode: Plan/i });
    expect(chip.className).toMatch(/--acc-green/);
  });

  it("renders 'Auto' with yellow styling for Claude's classifier-backed mode", () => {
    renderChip({
      currentProviderId: PROVIDER_IDS.CLAUDE_CODE,
      permissionMode: "auto",
    });
    const chip = screen.getByRole("button", {
      name: /Permission mode: Auto\b/i,
    });
    expect(chip.className).toMatch(/--acc-yellow/);
  });

  it("renders Claude bypass as the normal permission mode chip when enabled", () => {
    renderChip({
      currentProviderId: PROVIDER_IDS.CLAUDE_CODE,
      permissionMode: "bypassPermissions",
      enabledOptInModes: ["bypassPermissions"],
      runtimeProvider: PROVIDER_IDS.CLAUDE_CODE,
      runtimeSessionId: "claude-session-123",
    });
    const chip = screen.getByRole("button", {
      name: /Permission mode: Bypass/i,
    });
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("title", expect.stringMatching(/Shift\+Tab/i));
    expect(chip.className).toMatch(/--acc-red/);
    expect(screen.queryByRole("button", { name: /Claude access mode/i })).toBeNull();
  });

  it("renders 'Build' with fuchsia styling for OpenCode's primary mode", () => {
    renderChip({
      currentProviderId: PROVIDER_IDS.OPENCODE,
      permissionMode: "acceptEdits",
    });
    const chip = screen.getByRole("button", {
      name: /Permission mode: Build/i,
    });
    expect(chip.className).toMatch(/--chip-fuchsia/);
  });

  it("renders Codex default collaboration state as a grey Default chip", () => {
    renderChip({
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
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
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
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
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
      permissionMode: "bypassPermissions",
      enabledOptInModes: ["bypassPermissions"],
    });
    expect(screen.queryByRole("button", { name: /Permission mode: Full Access/i })).toBeNull();
  });

  it("renders Codex access mode as a separate chip without a shortcut", () => {
    renderChip({
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
      accessMode: "autoReview",
      onAccessModeChange: vi.fn(),
      runtimeProvider: PROVIDER_IDS.CODEX_CLI,
      runtimeSessionId: "thread-123",
    });
    const chip = screen.getByRole("button", {
      name: /Codex access mode: Auto Review/i,
    });
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute("title", expect.not.stringMatching(/Shift\\+Tab/i));
  });

  it("renders Cursor access mode with Cursor permission semantics", async () => {
    const user = userEvent.setup();
    renderChip({
      currentProviderId: PROVIDER_IDS.CURSOR,
      accessMode: "autoReview",
      onAccessModeChange: vi.fn(),
      runtimeProvider: PROVIDER_IDS.CURSOR,
      runtimeSessionId: "cursor-chat-123",
    });

    await user.click(screen.getByRole("button", { name: /Cursor access mode: Auto Review/i }));

    expect(screen.getByText("Cursor access mode")).toBeInTheDocument();
    expect(screen.getByText(/classifier reviews other Shell, MCP, and Fetch calls/i)).toBeVisible();
    expect(screen.getByText(/Run Everything enabled/i)).toBeVisible();
  });

  it("opens a Codex access mode popover and selects a mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderChip({
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
      accessMode: "default",
      onAccessModeChange: onChange,
      runtimeProvider: PROVIDER_IDS.CODEX_CLI,
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
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
      accessMode: "default",
      accessModeDefault: "fullAccess",
      onAccessModeChange: vi.fn(),
      runtimeProvider: PROVIDER_IDS.CODEX_CLI,
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
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
      permissionMode: "default",
      accessMode: "default",
      onAccessModeChange: vi.fn(),
      runtimeProvider: PROVIDER_IDS.CODEX_CLI,
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

  it("renders a disabled loader and hides provider-specific controls while the catalog loads", () => {
    renderChip({
      onModelChange: vi.fn(),
      currentProviderId: PROVIDER_IDS.OPENCODE,
      currentModelId: "default/default",
      currentModelLabel: MODEL_CATALOG_LOADING_LABEL,
      modelSelectionStatus: "catalog-loading",
      models: [],
      providers: [],
      accessMode: "default",
      onAccessModeChange: vi.fn(),
    });

    const loader = screen.getByRole("button", {
      name: "Loading model",
    });
    expect(loader).toBeDisabled();
    expect(screen.getByText(MODEL_CATALOG_LOADING_LABEL)).toBeInTheDocument();
    expect(screen.queryByText("default/default")).toBeNull();
    expect(screen.queryByRole("button", { name: /Permission mode/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /access mode/i })).toBeNull();
  });

  it("keeps the picker enabled while a provider switch is awaiting its model", () => {
    renderChip({
      onModelChange: vi.fn(),
      currentProviderId: PROVIDER_IDS.OPENCODE,
      currentModelId: "",
      currentModelLabel: MODEL_CATALOG_LOADING_LABEL,
      modelSelectionStatus: "selection-pending",
      models: [{ id: "default/default", label: "Default" }],
      accessMode: "default",
      onAccessModeChange: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Loading model" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Permission mode/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /access mode/i })).toBeNull();
  });

  it("renders fast mode beside the thinking control and toggles it accessibly", async () => {
    const user = userEvent.setup();
    const onFastModeChange = vi.fn();
    const { container } = renderChip({
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
      currentModelId: "gpt-5.6-sol",
      currentModelLabel: "GPT-5.6 Sol",
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
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
      currentModelId: "gpt-5.6-sol",
      currentModelLabel: "GPT-5.6 Sol",
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
      currentProviderId: PROVIDER_IDS.CODEX_CLI,
      currentModelId: "gpt-5.6-sol",
      currentModelLabel: "GPT-5.6 Sol",
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

  it("places the pre-first-prompt Claude profile selector at the end of the top line", () => {
    renderChip({
      currentProviderId: PROVIDER_IDS.CLAUDE_CODE,
      showClaudeProfileSelector: true,
      claudeProfile: "default",
      claudeProfiles: [{ name: "bedrock", env: {} }],
      claudeProfilesLoading: false,
      claudeProfilesError: false,
      onClaudeProfileChange: vi.fn(),
      showReadOnlyModel: true,
      showWorktreeChip: false,
    });

    const modelText = screen.getByText("claude-sonnet");
    const profileCombobox = screen.getByRole("combobox", { name: /Claude profile/i });
    expect(modelText.compareDocumentPosition(profileCombobox)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe("MetaBar secondaryBelow", () => {
  it("hides auto-scroll, todos and session-info chips when secondaryBelow is true", () => {
    renderChip({
      secondaryBelow: true,
      showAutoScrollChip: true,
      todos: [{ content: "Do thing", activeForm: "Doing thing", status: "pending" }],
      runtimeProvider: PROVIDER_IDS.CLAUDE_CODE,
      runtimeSessionId: "abc-123",
      onPause: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: /Auto-scroll/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Session info/i })).toBeNull();
    // Todos chip has no accessible name; it's the only button with "1" text.
    expect(screen.queryByText("0/1")).toBeNull();
    // The mode chip (inline) should still render — only the relocated chips are hidden.
    expect(screen.getByRole("button", { name: /Permission mode/i })).toBeInTheDocument();
  });

  it("renders auto-scroll, todos and session-info chips inline when secondaryBelow is false", () => {
    renderChip({
      secondaryBelow: false,
      showAutoScrollChip: true,
      todos: [{ content: "Do thing", activeForm: "Doing thing", status: "pending" }],
      runtimeProvider: PROVIDER_IDS.CLAUDE_CODE,
      runtimeSessionId: "abc-123",
      onPause: vi.fn(),
    });
    expect(screen.getByRole("button", { name: /Auto-scroll/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Session info/i })).toBeInTheDocument();
    expect(screen.getByText("0/1")).toBeInTheDocument();
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
