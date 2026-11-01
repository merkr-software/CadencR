import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { setProviderCatalogMetadata } from "@/lib/provider-catalog-registry";
import { DEFAULT_SIDEBAR_CONFIG } from "@/lib/sidebar-config";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";
import { SidebarProviderBadge } from "./SidebarProviderBadge";

vi.mock("@/components/ShortcutTooltip", () => ({
  ShortcutTooltip: ({ children }: { children: unknown }) => children,
}));

describe("SidebarProviderBadge", () => {
  beforeEach(() => {
    setProviderCatalogMetadata([]);
    useSidebarConfigStore.setState({ config: DEFAULT_SIDEBAR_CONFIG });
  });

  it("uses connector-owned artwork without status tint or animation", () => {
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
    render(<SidebarProviderBadge providerId="acme" />);
    const mark = screen.getByRole("img", { name: /Acme Agent/ });
    expect(mark).toHaveClass("text-muted-foreground");
    expect(mark).not.toHaveClass("animate-pulse", "text-blue-500");
    expect(mark.querySelector(".provider-mark-tint")).toHaveStyle({
      "--provider-mark": `url("${icon}")`,
      "--provider-mark-size": "100%",
    });
  });

  it("falls back to a quiet bot for iconless connectors", () => {
    render(<SidebarProviderBadge providerId="acme" />);
    expect(screen.getByRole("img").querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("preserves provider, model and effort details", () => {
    render(<SidebarProviderBadge providerId="claude_code" modelId="opus" thinkingEffort="high" />);
    expect(screen.getByRole("img", { name: /Claude · opus · High/ })).toHaveAttribute(
      "data-provider-mark",
      "mono",
    );
  });

  it.each([
    ["claude_code", 56],
    ["codex_cli", 43],
    ["opencode", 46],
  ])("normalizes %s to the same longest ink edge", (provider, inkEdge) => {
    render(<SidebarProviderBadge providerId={String(provider)} />);
    const mask = screen.getByRole("img").querySelector(".provider-mark-tint");
    expect(mask).toHaveStyle({ "--provider-mark-size": `${(64 / Number(inkEdge)) * 100}%` });
  });

  it("hides branding when disabled", () => {
    useSidebarConfigStore.setState({
      config: { ...DEFAULT_SIDEBAR_CONFIG, provider: "hidden" },
    });
    render(<SidebarProviderBadge providerId="codex_cli" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("does not invent a provider for an unconfigured conversation", () => {
    render(<SidebarProviderBadge />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
