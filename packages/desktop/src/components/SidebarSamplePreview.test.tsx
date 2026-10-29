import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@/test-utils";
import { DEFAULT_SIDEBAR_CONFIG, type SidebarConfig } from "@/lib/sidebar-config";
import { buildSampleConversations } from "@/lib/sidebar-sample-data";
import { useRef } from "react";
import { useSidebarHighlightAttribute } from "@/hooks/useSidebarDisplayAttributes";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { useSidebarPreviewStore } from "@/stores/sidebar-preview-store";
import { PinnedConversationRow } from "./PinnedConversationRow";
import { SampleReplayButton } from "./SidebarSampleBanner";
import { SidebarSampleBlock } from "./SidebarSampleBlock";
import {
  SampleScope,
  SidebarSampleProvider,
  useSidebarSamplePreview,
} from "./SidebarSampleProvider";
import { SidebarSampleRail } from "./SidebarSampleRail";
import { SidebarSampleRow } from "./SidebarSampleRow";
import { SidebarSampleTree } from "./SidebarSampleTree";

vi.mock("@/hooks/useFeaturePrefetch", () => ({ useFeaturePrefetch: () => vi.fn() }));
vi.mock("@/components/ShortcutTooltip", () => ({
  ShortcutTooltip: ({ children }: { children: unknown }) => children,
}));

function configure(values: Partial<SidebarConfig>): void {
  useSidebarConfigStore.setState({ config: { ...DEFAULT_SIDEBAR_CONFIG, ...values } });
}

beforeEach(() => configure({}));
afterEach(() => vi.useRealTimers());

function Replay() {
  const preview = useSidebarSamplePreview();
  return preview && <SampleReplayButton onReplay={preview.replay} />;
}

function Preview({ enabled = true }: { enabled?: boolean }) {
  return (
    <SidebarSampleProvider enabled={enabled}>
      <Replay />
      <SampleScope>
        {(["for-me", "working", "recent", "pinned"] as const).map((id) => (
          <SidebarSampleBlock key={id} id={id} />
        ))}
        <SidebarSampleTree />
        <SidebarSampleRail />
      </SampleScope>
    </SidebarSampleProvider>
  );
}

function renderPreview() {
  return render(<Preview />);
}

describe("sidebar sample preview", () => {
  it("renders a sample exactly like a live row with the same data", () => {
    const sample = buildSampleConversations(Date.now()).find((c) => c.feature.id === -21);
    if (!sample) throw new Error("missing sample");
    const conversation = { ...sample, gitStats: undefined };
    const live = render(
      <PinnedConversationRow
        feature={conversation.feature}
        activeFeatureId={null}
        hasLiveWorktree
        worktree={conversation.worktree}
        onNavigate={vi.fn()}
      />,
    );
    const preview = render(
      <SidebarSampleRow
        row={{ conversation, state: "idle" }}
        variant="block"
        isActive={false}
        onSelect={vi.fn()}
      />,
    );
    const body = (root: HTMLElement) => {
      const clone = root.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("[data-nav-shortcut-badge]").forEach((badge) => badge.remove());
      return ["[data-feature-title-line]", "[data-feature-meta-line]"].map(
        (selector) => clone.querySelector(selector)?.outerHTML,
      );
    };
    expect(body(preview.container)).toEqual(body(live.container));
    expect(body(preview.container)[1]).toContain("infra");
  });

  it("fills every block and project case from the samples", () => {
    renderPreview();
    const forMe = screen.getByRole("region", { name: "For me" });
    expect(within(forMe).getByText("Fix flaky checkout test")).toBeInTheDocument();
    expect(within(forMe).getByText("Bash: pnpm test --filter checkout --repeat 20")).toBeVisible();
    expect(screen.getByRole("region", { name: "Pinned" })).toHaveTextContent("Migrate billing");
    expect(screen.getByRole("img", { name: "1 waiting, 1 working" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Dormant (1)" })).toHaveLength(2);
  });

  it("lists For me's next actions with their verbs, three before Show more", async () => {
    const { user } = renderPreview();
    const forMe = screen.getByRole("region", { name: "For me" });
    const verbs = () =>
      [...forMe.querySelectorAll("[data-feature-next-action]")].map((verb) => verb.textContent);
    expect(verbs()).toEqual(["Answer", "Approve", "Check error"]);
    expect(within(forMe).getByRole("button", { name: /For me/ })).toHaveTextContent("6");

    await user.click(within(forMe).getByRole("button", { name: "Show 3 more" }));
    expect(verbs()).toEqual(["Answer", "Approve", "Check error", "Fix CI", "Review", "Merge"]);
    expect(within(forMe).getByText("Bump the Stripe SDK")).toBeInTheDocument();
  });

  it("follows the display options live", () => {
    configure({ forMe: false, recentBlock: true, recentCount: "3", rail: "attention" });
    renderPreview();
    expect(screen.queryByRole("region", { name: "For me" })).not.toBeInTheDocument();
    const recent = screen.getByRole("region", { name: "Recent" });
    expect(recent.querySelectorAll("[data-sidebar-sample-row]")).toHaveLength(3);
    const rail = screen.getByRole("region", { name: "Collapsed rail" });
    expect(
      within(rail).getByRole("button", { name: "Fix flaky checkout test: Waiting on you" }),
    ).toBeInTheDocument();
  });

  it("replays the last changes: rows flash and the newest request's popover opens", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user } = renderPreview();
    await user.click(screen.getByRole("button", { name: "Replay" }));
    // Back where they came from: nothing waits on you yet, only the approved
    // pull request still asks to be merged.
    const merging = screen.getByRole("region", { name: "For me" });
    expect(
      [...merging.querySelectorAll("[data-feature-title]")].map((title) => title.textContent),
    ).toEqual(["Bump the Stripe SDK"]);
    await act(() => vi.advanceTimersByTimeAsync(600));
    const forMe = screen.getByRole("region", { name: "For me" });
    // Rows already on screen flash; one just entering For me appears instead (never on mount).
    const flashing = screen
      .getAllByText("Fix flaky checkout test")
      .map((title) =>
        title.closest("[data-sidebar-sample-row]")?.getAttribute("data-sidebar-flash"),
      );
    expect(flashing).toContain("waiting");
    const popover = await screen.findByText("Permission needed");
    expect(popover.closest("[data-sidebar-sample]")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(screen.queryByText("Permission needed")).not.toBeInTheDocument();
    expect(within(forMe).queryByText("Fix flaky checkout test")).not.toBeInTheDocument();
  });

  it("starts the samples over each time the preview shows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user, rerender } = renderPreview();
    await user.click(screen.getByRole("button", { name: "Replay" }));
    await act(() => vi.advanceTimersByTimeAsync(600));
    await user.click(await screen.findByRole("button", { name: "Allow once" }));
    const forMe = () => screen.getByRole("region", { name: "For me" });
    expect(within(forMe()).queryByText("Fix flaky checkout test")).not.toBeInTheDocument();

    rerender(<Preview enabled={false} />);
    rerender(<Preview />);
    expect(within(forMe()).getByText("Fix flaky checkout test")).toBeInTheDocument();
    expect(screen.queryByText("Permission needed")).not.toBeInTheDocument();
  });

  it("outlines the pointed option without re-rendering", () => {
    let renders = 0;
    function Frame() {
      const ref = useRef<HTMLDivElement>(null);
      useSidebarHighlightAttribute(ref);
      renders += 1;
      return <div ref={ref} data-testid="frame" />;
    }
    render(<Frame />);
    act(() => useSidebarPreviewStore.getState().setHighlight("time"));
    expect(screen.getByTestId("frame")).toHaveAttribute("data-sidebar-highlight", "time");
    act(() => useSidebarPreviewStore.getState().setHighlight(null));
    expect(screen.getByTestId("frame")).not.toHaveAttribute("data-sidebar-highlight");
    expect(renders).toBe(1);
  });

  it("regroups the samples by the chosen lens, and sorts projects by name", () => {
    configure({ lens: "status" });
    const { unmount } = renderPreview();
    const headers = [...document.querySelectorAll("[data-sidebar-lens-header]")].map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(["Waiting on you2", "Working2", "Unread2", "Idle4"]);
    unmount();
    configure({ projectSort: "name" });
    renderPreview();
    const projects = [...document.querySelectorAll("[data-sidebar-tree] .sidebar-project-row")].map(
      (row) => row.textContent,
    );
    expect(projects.map((name) => name?.replace(/\d+/g, ""))).toEqual([
      "billing-api",
      "design-system",
      "web-app",
    ]);
  });
});
