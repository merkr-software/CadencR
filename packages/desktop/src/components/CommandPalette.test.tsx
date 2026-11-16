import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor, within } from "@/test-utils";
import type { ConversationIndexEntry, MessageSearchHit } from "@/api/generated";
import { registerShortcutAction } from "@/lib/command-palette/shortcut-actions";
import { CommandPalette } from "./CommandPalette";

const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mockNavigate }));

const ops = vi.hoisted(() => ({
  openConversation: vi.fn(),
  createConversation: vi.fn(() => Promise.resolve()),
  addProject: vi.fn(() => Promise.resolve()),
  installCli: vi.fn(() => Promise.resolve()),
  setPinned: vi.fn(),
  restore: vi.fn(),
  openFile: vi.fn(),
  openMessage: vi.fn(),
}));
vi.mock("@/components/command-palette/usePaletteOperations", () => ({
  usePaletteOperations: () => ops,
}));

function conversation(id: number, title: string, extra: Partial<ConversationIndexEntry> = {}) {
  return {
    id,
    project_id: 1,
    title,
    status: "active",
    is_pinned: false,
    created_at: "2026-10-20 10:00:00",
    last_activity_at: `2026-10-2${Math.min(id, 3)} 10:00:00`,
    ...extra,
  } satisfies ConversationIndexEntry;
}

const data = vi.hoisted(() => ({
  conversations: [] as ConversationIndexEntry[],
  hits: [] as MessageSearchHit[],
  nextActions: [] as { featureId: number; kind: "waiting" | "review" }[],
}));

vi.mock("@/components/command-palette/usePaletteData", () => ({
  usePaletteSources: () => ({
    conversations: data.conversations,
    conversationsLoading: false,
    conversationsError: null,
    projects: [{ id: 1, name: "cadencr", path: "/repo/cadencr", created_at: "" }],
    projectNames: new Map([[1, "cadencr"]]),
    attention: new Map(),
    nextActions: data.nextActions,
  }),
  usePaletteFrecency: () => ({ frecency: {}, recordUse: vi.fn() }),
  usePaletteMessages: () => ({ items: data.hits, loading: false, error: null }),
  usePaletteFiles: () => ({ items: [], loading: false, error: null }),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ themeId: "cadencr-dark", followSystemTheme: false, setTheme: vi.fn() }),
}));
vi.mock("@/components/ProjectBadge", () => ({ ProjectBadge: () => null }));
vi.mock("@/components/SidebarNextActionLine", () => ({
  SidebarNextActionLine: () => null,
  nextActionVerb: (kind: string, pending: string) => ({
    label: kind === "waiting" ? (pending === "question" ? "Answer" : "Approve") : "Review",
    className: "",
  }),
}));
vi.mock("@/stores/session-status-selectors", () => ({ useFeatureStatus: () => ({ kind: null }) }));
vi.mock("@/components/SidebarPendingRequestLine", () => ({
  SidebarPendingRequestLine: () => null,
}));
vi.mock("@/lib/provider-icons", () => ({ useProviderMetadata: () => null }));
vi.mock("@/api/generated", () => ({
  useGetFeatureRowSummary: () => ({ isPending: false, error: null, data: { preview: "Done." } }),
  useReadFile: () => ({ isPending: false, error: null, data: undefined }),
  useGetProjectSettings: () => ({ data: [] }),
  useListBranches: () => ({
    data: [{ name: "feat/palette", is_local: true }],
    isPending: false,
    error: null,
  }),
}));

function Harness({ featureId = 10 }: { featureId?: number | null }) {
  const [open, setOpen] = useState(true);
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      activeProjectId={1}
      activeFeatureId={featureId}
    />
  );
}

const input = () => screen.getByRole("combobox");
const rowTitles = () =>
  screen
    .queryAllByRole("option")
    .map((option) => option.querySelector(".cp-row-title")?.textContent);

describe("CommandPalette", () => {
  beforeEach(() => {
    data.conversations = [
      conversation(10, "Open right now"),
      conversation(1, "Improve Command Palette Navigation"),
      conversation(2, "Player — corriger les deux P2 terminaux"),
      conversation(3, "Polish Agent View UX", {
        status: "archived",
        archived_at: "2026-10-21 10:00:00",
      }),
    ];
    data.hits = [];
    data.nextActions = [];
  });
  afterEach(() => vi.clearAllMocks());

  it("opens on what needs the user and the conversations they were last in", () => {
    data.nextActions = [{ featureId: 2, kind: "waiting" }];
    render(<Harness />);
    const needsYou = screen.getByRole("group", { name: /Needs you/ });
    expect(
      within(needsYou).getByText("Player — corriger les deux P2 terminaux"),
    ).toBeInTheDocument();
    expect(within(needsYou).getByText("Approve")).toBeInTheDocument();
    const recent = screen.getByRole("group", { name: /Recent/ });
    expect(within(recent).queryByText("Open right now")).not.toBeInTheDocument();
  });

  it("ranks the title holding the word first and opens it once closed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), "palette");
    expect(rowTitles()[0]).toBe("Improve Command Palette Navigation");
    expect(rowTitles()).not.toContain("Player — corriger les deux P2 terminaux");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(ops.openConversation).toHaveBeenCalledWith(1, 1));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("finds archived conversations", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), "polish agent view");
    const option = screen.getByRole("option", { name: /Polish Agent View UX/ });
    expect(option).toHaveAttribute("data-archived", "true");
  });

  it("switches to commands with > and runs a navigation", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), ">agents");
    expect(screen.getByText("Commands", { selector: ".cp-chip-label" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: "/agents" }));
  });

  it("runs a shortcut's own handler, not a synthetic key", async () => {
    const commit = vi.fn();
    const unregister = registerShortcutAction("git-commit", commit);
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), "commit");
    expect(rowTitles()[0]).toBe("Commit…");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    unregister();
  });

  it("offers the selection's actions on Tab and comes back on Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), "palette");
    await user.keyboard("{Tab}");
    expect(screen.getByRole("option", { name: "Pin" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(input()).toHaveValue("palette");
    expect(rowTitles()[0]).toBe("Improve Command Palette Navigation");
  });

  it("opens the selection from its actions with Enter", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), "palette");
    await user.keyboard("{Tab}");
    expect(rowTitles()[0]).toBe("Open conversation");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(ops.openConversation).toHaveBeenCalledWith(1, 1));
    expect(ops.openConversation).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps the searched words when a message hit opens from its actions", async () => {
    data.hits = [
      {
        message_id: 5,
        feature_id: 2,
        project_id: 1,
        feature_title: "Player",
        feature_status: "active",
        role: "assistant",
        snippet: "the \u0002deploy\u0003 script",
        created_at: "2026-10-22 10:00:00",
      },
    ];
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), "#deploy");
    await user.keyboard("{Tab}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(ops.openMessage).toHaveBeenCalledWith(data.hits[0], "deploy"));
  });

  it("opens a message hit with Find on the typed words", async () => {
    data.hits = [
      {
        message_id: 5,
        feature_id: 2,
        project_id: 1,
        feature_title: "Player",
        feature_status: "active",
        role: "assistant",
        snippet: "the \u0002deploy\u0003 script",
        created_at: "2026-10-22 10:00:00",
      },
    ];
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), "#deploy");
    expect(screen.getByText("Messages", { selector: ".cp-chip-label" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(ops.openMessage).toHaveBeenCalledWith(data.hits[0], "deploy"));
  });

  it("creates a conversation through the project and worktree steps", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), "new conversation…");
    await user.click(screen.getByRole("option", { name: /^New conversation…/ }));
    expect(
      screen.getByText("New conversation", { selector: ".cp-chip-label" }),
    ).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("option", { name: /feat\/palette/ })).toBeInTheDocument();
    await user.type(input(), "project dir");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(ops.createConversation).toHaveBeenCalledWith({
        projectId: 1,
        worktree: { mode: "skip" },
        projectDefault: "new",
      }),
    );
  });

  it("leaves conversation commands out when no conversation is open", async () => {
    const unregister = registerShortcutAction("edit-label", vi.fn());
    const user = userEvent.setup();
    render(<Harness featureId={null} />);
    await user.type(input(), ">label");
    expect(rowTitles()).not.toContain("Edit label…");
    unregister();
  });
});
