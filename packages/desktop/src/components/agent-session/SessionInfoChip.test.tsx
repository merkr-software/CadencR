import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { PROVIDER_IDS } from "@/lib/providers";
import { SessionInfoChip } from "./SessionInfoChip";
import { SessionInfoMcpServersProvider } from "./McpServersRow";

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("SessionInfoChip", () => {
  it("renders MCP servers above the profile row", async () => {
    const user = userEvent.setup();

    render(
      <SessionInfoMcpServersProvider
        mcpServers={[
          { name: "cadencr-browser", status: "connected" },
          { name: "filesystem", status: "unavailable" },
          { name: "browser", status: "unknown" },
        ]}
      >
        <SessionInfoChip
          runtimeProvider={PROVIDER_IDS.CLAUDE_CODE}
          runtimeSessionId="sess-123"
          projectPath="/tmp/project"
          isRunning={false}
          onPause={vi.fn()}
          chipClass="chip"
          showProfileSelector
        />
      </SessionInfoMcpServersProvider>,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));

    const mcpHeading = screen.getByText("MCP servers");
    const profileHeading = screen.getByText("Profile");
    expect(mcpHeading.compareDocumentPosition(profileHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByText("cadencr-browser")).toBeInTheDocument();
    expect(screen.getByText("connected")).toBeInTheDocument();
    expect(screen.getByText("filesystem")).toBeInTheDocument();
    expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(screen.getByText("browser")).toBeInTheDocument();
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("renders a not-reported state before MCP status is available", async () => {
    const user = userEvent.setup();

    render(
      <SessionInfoChip
        runtimeProvider={PROVIDER_IDS.CODEX_CLI}
        runtimeSessionId="thread-123"
        projectPath="/tmp/project"
        isRunning={false}
        onPause={vi.fn()}
        chipClass="chip"
      />,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));

    expect(screen.getByText("MCPs not reported yet")).toBeInTheDocument();
  });

  it("says the MCP servers could not be read instead of reporting none", async () => {
    const user = userEvent.setup();

    render(
      <SessionInfoMcpServersProvider
        mcpServers={[]}
        error="The agent's MCP servers could not be read: timed out"
      >
        <SessionInfoChip
          runtimeProvider={PROVIDER_IDS.CODEX_CLI}
          runtimeSessionId="thread-123"
          projectPath="/tmp/project"
          isRunning={false}
          onPause={vi.fn()}
          chipClass="chip"
        />
      </SessionInfoMcpServersProvider>,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The agent's MCP servers could not be read: timed out",
    );
    expect(screen.queryByText("No MCP servers reported")).not.toBeInTheDocument();
  });

  it("shows an MCP read failure before the runtime has an id", async () => {
    const user = userEvent.setup();

    render(
      <SessionInfoMcpServersProvider
        mcpServers={[]}
        error="The agent's MCP servers could not be read"
      >
        <SessionInfoChip
          runtimeProvider={PROVIDER_IDS.CODEX_CLI}
          projectPath="/tmp/project"
          isRunning={false}
          onPause={vi.fn()}
          chipClass="chip"
        />
      </SessionInfoMcpServersProvider>,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));

    expect(screen.getByRole("alert")).toHaveTextContent("could not be read");
  });

  it("bounds the popover and virtualizes a long MCP server list", async () => {
    const user = userEvent.setup();
    const mcpServers = Array.from({ length: 30 }, (_, index) => ({
      name: `server-${index}`,
      status: "connected",
    }));

    render(
      <SessionInfoMcpServersProvider mcpServers={mcpServers}>
        <SessionInfoChip
          runtimeProvider={PROVIDER_IDS.CODEX_CLI}
          runtimeSessionId="thread-123"
          projectPath="/tmp/project"
          isRunning={false}
          onPause={vi.fn()}
          chipClass="chip"
        />
      </SessionInfoMcpServersProvider>,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));

    const popover = document.querySelector('[data-slot="popover-content"]');
    expect(popover).toHaveClass(
      "max-h-[min(70vh,var(--radix-popover-content-available-height))]",
      "overflow-hidden",
    );
    const serverList = screen.getByRole("list", { name: "MCP servers" });
    expect(serverList).toHaveClass("max-h-40", "overflow-hidden");
    expect(serverList).toHaveStyle({ height: "160px" });
    expect(serverList.firstElementChild).toHaveClass("h-full", "overscroll-contain");
    expect(screen.getByText("server-29")).toBeInTheDocument();
  });

  it("filters MCP servers by name", async () => {
    const user = userEvent.setup();

    render(
      <SessionInfoMcpServersProvider
        mcpServers={[
          { name: "cadencr-browser", status: "connected" },
          { name: "filesystem", status: "connected" },
        ]}
      >
        <SessionInfoChip
          runtimeProvider={PROVIDER_IDS.CODEX_CLI}
          runtimeSessionId="thread-123"
          projectPath="/tmp/project"
          isRunning={false}
          onPause={vi.fn()}
          chipClass="chip"
        />
      </SessionInfoMcpServersProvider>,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));
    await user.type(screen.getByRole("textbox", { name: "Search MCP servers" }), "FILESYSTEM");

    expect(screen.getByText("filesystem")).toBeInTheDocument();
    expect(screen.queryByText("cadencr-browser")).not.toBeInTheDocument();
  });

  it("renders an editable provider profile combobox in the info popover", async () => {
    const user = userEvent.setup();
    const onProfileChange = vi.fn();

    render(
      <SessionInfoChip
        runtimeProvider={PROVIDER_IDS.CLAUDE_CODE}
        runtimeSessionId="sess-123"
        projectPath="/tmp/project"
        isRunning={false}
        onPause={vi.fn()}
        chipClass="chip"
        claudeProfile="default"
        claudeProfiles={[{ name: "bedrock", env: {} }]}
        onClaudeProfileChange={onProfileChange}
        showProfileSelector
      />,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));
    await user.click(screen.getByRole("combobox", { name: "Profile" }));
    await user.click(await screen.findByRole("option", { name: "bedrock" }));

    expect(onProfileChange).toHaveBeenCalledWith("bedrock");
  });

  it("says which profile stays active when the session overrides it", async () => {
    const user = userEvent.setup();

    render(
      <SessionInfoChip
        runtimeProvider={PROVIDER_IDS.CLAUDE_CODE}
        runtimeSessionId="sess-123"
        projectPath="/tmp/project"
        isRunning={false}
        onPause={vi.fn()}
        chipClass="chip"
        claudeProfile="profile-selected-id"
        claudeProfiles={[
          { name: "profile-selected-id", label: "QA profile", env: {} },
          { name: "profile-active-id", label: "Usual Codex profile", env: {} },
        ]}
        activeClaudeProfile="profile-active-id"
        onClaudeProfileChange={vi.fn()}
        showProfileSelector
      />,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));

    expect(screen.getByText(/“Usual Codex profile” stays the active profile/)).toBeInTheDocument();
    expect(screen.queryByText(/profile-active-id/)).not.toBeInTheDocument();
  });

  it("omits the override sentence when the session runs the active profile", async () => {
    const user = userEvent.setup();

    render(
      <SessionInfoChip
        runtimeProvider={PROVIDER_IDS.CLAUDE_CODE}
        runtimeSessionId="sess-123"
        projectPath="/tmp/project"
        isRunning={false}
        onPause={vi.fn()}
        chipClass="chip"
        claudeProfile="default"
        claudeProfiles={[{ name: "bedrock", env: {} }]}
        // Spelled differently on purpose: the alias must not read as an override.
        activeClaudeProfile="default (recommended)"
        onClaudeProfileChange={vi.fn()}
        showProfileSelector
      />,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));

    expect(screen.queryByText(/stays the active profile/)).not.toBeInTheDocument();
  });

  it("shows a human-labelled profile before a runtime session exists", async () => {
    const user = userEvent.setup();

    render(
      <SessionInfoChip
        runtimeProvider={PROVIDER_IDS.CODEX_CLI}
        projectPath="/tmp/project"
        isRunning={false}
        chipClass="chip"
        claudeProfile="profile-uuid"
        claudeProfiles={[{ name: "profile-uuid", label: "QA profile", env: {} }]}
        onClaudeProfileChange={vi.fn()}
        showProfileSelector
      />,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));

    expect(screen.getByRole("combobox", { name: "Profile" })).toHaveTextContent("QA profile");
    expect(screen.queryByText("Session ID")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy launch command/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/MCPs not reported yet/i)).not.toBeInTheDocument();
  });

  it.each([
    { loading: true, error: false, message: "Loading profiles…" },
    { loading: false, error: true, message: "Failed to load profiles" },
  ])("surfaces profile query state in Info: $message", async ({ loading, error, message }) => {
    const user = userEvent.setup();
    render(
      <SessionInfoChip
        runtimeProvider={PROVIDER_IDS.CODEX_CLI}
        projectPath="/tmp/project"
        isRunning={false}
        chipClass="chip"
        claudeProfile="default"
        claudeProfilesLoading={loading}
        claudeProfilesError={error}
        onClaudeProfileChange={vi.fn()}
        showProfileSelector
      />,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("shows the human label when profile selection is read-only", async () => {
    const user = userEvent.setup();
    render(
      <SessionInfoChip
        runtimeProvider={PROVIDER_IDS.CODEX_CLI}
        runtimeSessionId="thread-123"
        projectPath="/tmp/project"
        isRunning={false}
        onPause={vi.fn()}
        chipClass="chip"
        claudeProfile="profile-uuid"
        claudeProfiles={[{ name: "profile-uuid", label: "QA profile", env: {} }]}
        showProfileSelector
      />,
    );

    await user.click(screen.getByRole("button", { name: /session info/i }));

    expect(screen.queryByRole("combobox", { name: "Profile" })).not.toBeInTheDocument();
    expect(screen.getByText("QA profile")).toBeInTheDocument();
  });
});
