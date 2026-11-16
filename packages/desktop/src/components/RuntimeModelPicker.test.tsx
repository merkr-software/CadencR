import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@/test-utils";
import { RuntimeModelPicker, type RuntimeModelSelectionResolver } from "./RuntimeModelPicker";

const toggleFavorite = vi.fn();
let favorites = new Set<string>();

vi.mock("@/hooks/useFavoriteModels", () => ({
  useFavoriteModels: () => ({ favorites, toggleFavorite, isLoading: false }),
}));

function Harness(props: {
  onSelect?: (providerId: string, modelId: string) => void;
  onAfterSelectClose?: () => void;
  models?: Array<{ id: string; label: string; description?: string }>;
  refreshError?: string;
  selectedModelId?: string;
  resolveSelectedModelId?: RuntimeModelSelectionResolver;
}) {
  const {
    models = [{ id: "opus", label: "Opus" }],
    onSelect = vi.fn(),
    onAfterSelectClose = vi.fn(),
    selectedModelId = "opus",
    resolveSelectedModelId,
    refreshError,
  } = props;
  const [open, setOpen] = useState(false);

  return (
    <RuntimeModelPicker
      open={open}
      onOpenChange={setOpen}
      providers={[
        {
          id: "claude_code",
          label: "Claude",
          disabled: false,
          refreshError,
          models,
        },
      ]}
      selectedProviderId="claude_code"
      selectedModelId={selectedModelId}
      resolveSelectedModelId={resolveSelectedModelId}
      onSelect={onSelect}
      onAfterSelectClose={onAfterSelectClose}
      trigger={<button type="button">Open picker</button>}
    />
  );
}

function longOpenCodeModels(): Array<{ id: string; label: string }> {
  return Array.from({ length: 16 }, (_, index) => ({
    id: `openai/gpt-${index}`,
    label: `GPT ${index}`,
  }));
}

describe("RuntimeModelPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    favorites = new Set<string>();
  });

  it("calls the post-close callback after selecting a model", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onAfterSelectClose = vi.fn();

    render(<Harness onSelect={onSelect} onAfterSelectClose={onAfterSelectClose} />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));
    await user.click(screen.getByRole("option", { name: /^Opus$/i }));

    expect(onSelect).toHaveBeenCalledWith("claude_code", "opus");
    await waitFor(() => expect(onAfterSelectClose).toHaveBeenCalled());
  });

  it("focuses and scrolls to the selected model when opened", async () => {
    const user = userEvent.setup();
    const models = [
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `model-${index}`,
        label: `Model ${index}`,
      })),
      { id: "opus", label: "Opus" },
    ];

    render(<Harness models={models} />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const selectedOption = screen.getByRole("option", { name: /^Opus$/i });
    await waitFor(() => expect(selectedOption).toHaveAttribute("data-selected", "true"));
  });

  it("resets the results scroll position when the filter changes", async () => {
    const user = userEvent.setup();
    const models = Array.from({ length: 30 }, (_, index) => ({
      id: `model-${index}`,
      label: index === 29 ? "Opus Max" : `Model ${index}`,
    }));

    render(<Harness models={models} />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const list = document.querySelector('[data-slot="command-list"]');
    expect(list).toBeInstanceOf(HTMLElement);
    const commandList = list as HTMLElement;
    commandList.scrollTop = 240;

    await user.type(screen.getByPlaceholderText("Search providers or models..."), "Op");

    await waitFor(() => expect(commandList.scrollTop).toBe(0));
  });

  it("does not resolve provider-specific model aliases unless a resolver is provided", async () => {
    const user = userEvent.setup();

    render(
      <Harness
        selectedModelId="sonnet"
        models={[{ id: "us.anthropic.claude-sonnet-4-6", label: "Sonnet" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    await waitFor(() =>
      expect(screen.getByRole("option", { name: /^Sonnet$/i })).toHaveAttribute(
        "data-selected",
        "false",
      ),
    );
  });

  it("stars a model without selecting it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<Harness onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));
    await user.click(screen.getByRole("button", { name: "Star Opus" }));

    expect(toggleFavorite).toHaveBeenCalledWith("claude_code:opus");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("stars the highlighted model with the keyboard shortcut", async () => {
    const user = userEvent.setup();

    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /^Opus$/i })).toHaveAttribute(
        "data-selected",
        "true",
      ),
    );

    await user.keyboard("{Meta>}s{/Meta}");

    expect(toggleFavorite).toHaveBeenCalledWith("claude_code:opus");
  });

  it("lists starred models in their own group above the rest, filtered or not", async () => {
    const user = userEvent.setup();
    favorites = new Set(["claude_code:zeta"]);

    render(
      <Harness
        models={[
          { id: "alpha", label: "Alpha" },
          { id: "zeta", label: "Zeta" },
        ]}
        selectedModelId="alpha"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    function groupHeadingsWithOptions(): Array<{ heading: string; options: string[] }> {
      return Array.from(document.querySelectorAll('[data-slot="command-group"]'))
        .filter((group) => group.querySelectorAll('[role="option"]').length > 0)
        .map((group) => ({
          heading:
            group.querySelector("[data-slot='picker-group-title']")?.textContent ??
            group.querySelector("[cmdk-group-heading]")?.textContent ??
            "",
          options: within(group as HTMLElement)
            .getAllByRole("option")
            .map((option) => option.getAttribute("data-value") ?? ""),
        }));
    }

    expect(groupHeadingsWithOptions()).toEqual([
      { heading: "Starred", options: ["claude_code:zeta"] },
      { heading: "Claude", options: ["claude_code:alpha"] },
    ]);

    // The starred group still leads once a filter matches both models.
    await user.type(screen.getByPlaceholderText("Search providers or models..."), "a");

    await waitFor(() => expect(groupHeadingsWithOptions()[0]?.heading).toBe("Starred"));
    expect(groupHeadingsWithOptions()).toEqual([
      { heading: "Starred", options: ["claude_code:zeta"] },
      { heading: "Claude", options: ["claude_code:alpha"] },
    ]);
  });

  it("marks starred models with a provider icon instead of a provider caption", async () => {
    const user = userEvent.setup();
    favorites = new Set(["claude_code:zeta"]);

    render(
      <Harness
        models={[
          { id: "alpha", label: "Alpha" },
          { id: "zeta", label: "Zeta" },
        ]}
        selectedModelId="alpha"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const starred = screen.getByRole("option", { name: /Zeta, Claude/i });
    expect(starred.querySelector("img")).not.toBeNull();
    expect(
      Array.from(starred.querySelectorAll("span")).some((node) => node.textContent === "Claude"),
    ).toBe(false);

    const catalog = screen.getByRole("option", { name: /^Alpha$/i });
    expect(catalog.querySelector("img")).toBeNull();
  });

  it("uses an injected resolver to highlight provider-specific aliases", async () => {
    const user = userEvent.setup();
    const resolveSelectedModelId: RuntimeModelSelectionResolver = () =>
      "us.anthropic.claude-sonnet-4-6";

    render(
      <Harness
        selectedModelId="sonnet"
        resolveSelectedModelId={resolveSelectedModelId}
        models={[{ id: "us.anthropic.claude-sonnet-4-6", label: "Sonnet" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    await waitFor(() =>
      expect(screen.getByRole("option", { name: /^Sonnet$/i })).toHaveAttribute(
        "data-selected",
        "true",
      ),
    );
  });

  it("wraps long identifiers instead of truncating them", async () => {
    const user = userEvent.setup();
    const longId = "us.anthropic.claude-sonnet-4-6";

    render(<Harness models={[{ id: longId, label: longId }]} selectedModelId={longId} />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const option = screen.getByRole("option", { name: new RegExp(longId, "i") });
    expect(option.textContent).toContain(longId);
    expect(option.className).toContain("whitespace-normal");
    expect(option.querySelector(".truncate")).toBeNull();
  });

  it("shows the full model id when the visible label is shortened", async () => {
    const user = userEvent.setup();

    render(
      <RuntimeModelPicker
        providers={[
          {
            id: "opencode",
            label: "OpenCode",
            disabled: false,
            models: [
              {
                id: "anthropic/claude-sonnet-4-6",
                label: "anthropic/claude-sonnet-4-6",
              },
            ],
          },
        ]}
        selectedProviderId="opencode"
        selectedModelId="anthropic/claude-sonnet-4-6"
        onSelect={vi.fn()}
        trigger={<button type="button">Open picker</button>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const option = screen.getByRole("option", {
      name: /claude-sonnet-4-6/i,
    });
    expect(option.textContent).toContain("claude-sonnet-4-6");
    expect(option.textContent).toContain("anthropic/claude-sonnet-4-6");
  });

  it("shows catalog descriptions on model rows", async () => {
    const user = userEvent.setup();

    render(
      <Harness
        models={[{ id: "opus", label: "Opus", description: "Frontier model for complex coding" }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const option = screen.getByRole("option", { name: /^Opus$/i });
    expect(option.textContent).toContain("Frontier model for complex coding");
  });

  it("does not repeat a friendly model name as a raw id", async () => {
    const user = userEvent.setup();

    render(
      <RuntimeModelPicker
        providers={[
          {
            id: "cursor",
            label: "Cursor",
            disabled: false,
            models: [{ id: "gpt-5.3-codex-fast", label: "Codex 5.3 Fast" }],
          },
        ]}
        selectedProviderId="cursor"
        selectedModelId="gpt-5.3-codex-fast"
        onSelect={vi.fn()}
        trigger={<button type="button">Open picker</button>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const option = screen.getByRole("option", { name: /^Codex 5.3 Fast$/i });
    expect(option.textContent).toContain("Codex 5.3 Fast");
    expect(option.textContent).not.toContain("gpt-5.3-codex-fast");
  });

  it("collapses inactive groups in a long catalog until they are expanded or searched", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const opencodeModels = longOpenCodeModels();

    render(
      <RuntimeModelPicker
        providers={[
          {
            id: "claude_code",
            label: "Claude",
            disabled: false,
            models: [{ id: "opus", label: "Opus" }],
          },
          {
            id: "opencode",
            label: "OpenCode",
            disabled: false,
            models: opencodeModels,
          },
        ]}
        selectedProviderId="claude_code"
        selectedModelId="opus"
        onSelect={onSelect}
        trigger={<button type="button">Open picker</button>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    expect(screen.getByRole("option", { name: /^Opus$/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GPT 0/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /OpenCode, 16 models/i }));

    expect(screen.getByRole("option", { name: /GPT 0/i })).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reveals collapsed groups while searching", async () => {
    const user = userEvent.setup();
    const opencodeModels = longOpenCodeModels();

    render(
      <RuntimeModelPicker
        providers={[
          {
            id: "claude_code",
            label: "Claude",
            disabled: false,
            models: [{ id: "opus", label: "Opus" }],
          },
          {
            id: "opencode",
            label: "OpenCode",
            disabled: false,
            models: opencodeModels,
          },
        ]}
        selectedProviderId="claude_code"
        selectedModelId="opus"
        onSelect={vi.fn()}
        trigger={<button type="button">Open picker</button>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open picker" }));
    await user.type(screen.getByPlaceholderText("Search providers or models..."), "GPT 3");

    expect(await screen.findByRole("option", { name: /GPT 3/i })).toBeInTheDocument();
  });

  it("does not fuzzy-match unrelated model names", async () => {
    const user = userEvent.setup();

    render(
      <RuntimeModelPicker
        providers={[
          {
            id: "codex_cli",
            label: "Codex CLI",
            disabled: false,
            models: [
              {
                id: "gpt-5.6-sol",
                label: "GPT-5.6-Sol",
                description: "Most capable GPT-5.6 model",
              },
              {
                id: "gpt-5.6-fable",
                label: "GPT-5.6-Fable",
                description: "Most capable GPT-5.6 model",
              },
            ],
          },
        ]}
        selectedProviderId="codex_cli"
        selectedModelId="gpt-5.6-sol"
        onSelect={vi.fn()}
        trigger={<button type="button">Open picker</button>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open picker" }));
    await user.type(screen.getByPlaceholderText("Search providers or models..."), "Sol");

    expect(screen.getByRole("option", { name: /^GPT-5.6-Sol$/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^GPT-5.6-Fable$/i })).not.toBeInTheDocument();
  });

  it("keeps inactive groups collapsed after the catalog grows while open", async () => {
    const claude = [
      {
        id: "claude_code",
        label: "Claude",
        disabled: false,
        models: [{ id: "opus", label: "Opus" }],
      },
    ];
    const grown = [
      ...claude,
      {
        id: "opencode",
        label: "OpenCode",
        disabled: false,
        models: longOpenCodeModels(),
      },
    ];

    const { rerender } = render(
      <RuntimeModelPicker
        open
        onOpenChange={vi.fn()}
        providers={claude}
        selectedProviderId="claude_code"
        selectedModelId="opus"
        onSelect={vi.fn()}
        trigger={<button type="button">Open picker</button>}
      />,
    );

    expect(screen.getByRole("option", { name: /^Opus$/i })).toBeInTheDocument();

    rerender(
      <RuntimeModelPicker
        open
        onOpenChange={vi.fn()}
        providers={grown}
        selectedProviderId="claude_code"
        selectedModelId="opus"
        onSelect={vi.fn()}
        trigger={<button type="button">Open picker</button>}
      />,
    );

    expect(screen.getByRole("option", { name: /^Opus$/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GPT 0/i })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /OpenCode, 16 models/i })).toBeInTheDocument();
  });

  it("puts the provider logo on a sticky group header, not on each model row", async () => {
    const user = userEvent.setup();

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const option = screen.getByRole("option", { name: /^Opus$/i });
    expect(option.querySelector("img")).toBeNull();
    expect(option.textContent).not.toMatch(/\//);

    const group = option.closest("[data-slot='command-group']");
    expect(group?.className).toContain("sticky");
    expect(group?.querySelector("[cmdk-group-heading] img")).not.toBeNull();
    expect(group?.querySelector("[data-slot='picker-group-title']")?.textContent).toBe("Claude");
  });

  it("offsets highlighted rows so sticky headings do not cover them", async () => {
    const user = userEvent.setup();

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open picker" }));

    expect(screen.getByRole("option", { name: /^Opus$/i }).className).toContain("scroll-mt-9");
  });

  it("says when a provider's models are the last known catalog, and why", async () => {
    const user = userEvent.setup();
    render(<Harness refreshError="model/list timed out" />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Claude: showing the last known models.");
    expect(notice).toHaveTextContent("Refresh failed: model/list timed out");
    // The last known models stay selectable.
    expect(screen.getByRole("option", { name: /^Opus$/i })).toBeInTheDocument();
  });

  it("shows no catalog notice for a fresh catalog", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Open picker" }));

    expect(screen.getByRole("option", { name: /^Opus$/i })).toBeInTheDocument();
    expect(screen.queryByText(/showing the last known models/i)).not.toBeInTheDocument();
  });
});
