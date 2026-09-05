import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { setProviderCatalogMetadata } from "@/lib/provider-catalog-registry";
import { SidebarProviderBadge } from "./SidebarProviderBadge";

vi.mock("@/components/ShortcutTooltip", () => ({
  ShortcutTooltip: ({ children }: { children: unknown }) => children,
}));

describe("SidebarProviderBadge", () => {
  beforeEach(() => setProviderCatalogMetadata([]));

  it("uses a connector-owned icon with release sidebar status styling", () => {
    const icon = "data:image/svg+xml;base64,AA==";
    setProviderCatalogMetadata([
      {
        id: "acme",
        label: "Acme Agent",
        icon_data: icon,
        origin: "installed_local",
        status: "available",
        models: [],
      },
    ]);
    render(<SidebarProviderBadge providerId="acme" liveStatus="agent" />);
    const mark = screen.getByRole("img", { name: /Acme Agent.*Working/ });
    expect(mark).toHaveClass("text-blue-500", "animate-pulse");
    expect(mark.querySelector(".provider-mark-tint")).toHaveStyle({
      "--provider-mark": `url("${icon}")`,
    });
  });

  it("keeps iconless connectors visible and inherits the status color", () => {
    render(<SidebarProviderBadge providerId="acme" liveStatus="agent" />);
    const mark = screen.getByRole("img", { name: /Working/ });
    expect(mark).toHaveClass("text-blue-500");
    expect(mark.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(mark.querySelector("svg")).not.toHaveClass("text-muted-foreground");
  });

  it("renders the mono silhouette while idle", () => {
    render(<SidebarProviderBadge providerId="claude_code" modelId="opus" />);

    const mark = screen.getByRole("img", { name: /Claude · opus · Default$/ });
    expect(mark).toHaveAttribute("data-provider-mark", "idle");
    expect(mark).toHaveClass("text-muted-foreground");
    expect(mark.querySelector(".provider-mark-tint")).not.toBeNull();
    expect(mark.querySelector("img")).toBeNull();
  });

  it("tints the same silhouette blue and pulses while working", () => {
    render(<SidebarProviderBadge providerId="claude_code" liveStatus="agent" />);

    const mark = screen.getByRole("img", { name: /Working/ });
    expect(mark).toHaveAttribute("data-provider-mark", "working");
    expect(mark).toHaveClass("text-blue-500", "animate-pulse");
    expect(mark.querySelector(".provider-mark-tint")).not.toBeNull();
  });

  it("stays decorative while waiting so the gate trigger owns the name", () => {
    const { container } = render(
      <SidebarProviderBadge providerId="claude_code" liveStatus="question" />,
    );

    const mark = container.querySelector("[data-provider-mark]");
    expect(mark).toHaveAttribute("data-provider-mark", "waiting");
    expect(mark).not.toHaveClass("animate-pulse");
    expect(mark?.querySelector(".provider-mark-tint")).not.toBeNull();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("overlays unread on an idle mark and ignores it while working", () => {
    const { rerender } = render(<SidebarProviderBadge providerId="claude_code" unread />);

    const idle = screen.getByRole("img", { name: /Unread/ });
    expect(idle).toHaveAttribute("data-provider-mark", "unread");
    expect(idle.querySelector(".bg-blue-500")).not.toBeNull();

    rerender(<SidebarProviderBadge providerId="claude_code" liveStatus="agent" unread />);
    const working = screen.getByRole("img", { name: /Working/ });
    expect(working).toHaveAttribute("data-provider-mark", "working");
    expect(working).not.toHaveAccessibleName(/Unread/);
  });
});
