import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { uiI18n } from "@/lib/i18n/ui";
import {
  appendComposerContext,
  composerKeyFor,
  useComposerContextStore,
} from "@/stores/composer-context-store";
import { useAddSelectionToPrompt } from "@/components/editor/useAddSelectionToPrompt";
import { useAddTerminalSelectionToPrompt } from "@/components/terminal/useAddTerminalSelectionToPrompt";
import { ComposerContextProvider, type ComposerContextValue } from "./ComposerContext";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import type { ImageAttachment } from "@/hooks/useImageAttachments";
import { AttachmentChips, ContextTray } from "./ContextTray";

function attachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "att-1",
    fileName: "image.png",
    previewUrl: "data:image/png;base64,abc123",
    base64: "abc123",
    mimeType: "image/png",
    kind: "image",
    ...overrides,
  };
}

describe("AttachmentChips", () => {
  it("shows images as thumbnails and other files by name", () => {
    render(
      <AttachmentChips
        items={[
          attachment({ id: "1", fileName: "photo.png" }),
          attachment({
            id: "2",
            fileName: "brief.pdf",
            kind: "document",
            mimeType: "application/pdf",
          }),
        ]}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByText("brief.pdf")).toBeInTheDocument();
  });

  it("removes an attachment by id", async () => {
    const onRemove = vi.fn();
    const { user } = render(
      <AttachmentChips
        items={[attachment({ id: "x", fileName: "pic.png" })]}
        onRemove={onRemove}
      />,
    );
    await user.click(screen.getByRole("button", { name: /remove pic\.png/i }));
    expect(onRemove).toHaveBeenCalledWith("x");
  });
});

const shortcuts = vi.hoisted(() => new Map<string, (event: KeyboardEvent) => void>());
vi.mock("@/hooks/useShortcut", () => ({
  useScopedGlobalShortcutById: (key: string, handler: (event: KeyboardEvent) => void) => {
    shortcuts.set(key, handler);
  },
}));
vi.mock("./ReviewCommentsSuggestion", () => ({ ReviewCommentsSuggestion: () => null }));
vi.mock("./PullRequestLinkSuggestion", () => ({ PullRequestLinkSuggestion: () => null }));

const composer: ComposerContextValue = {
  featureId: 46,
  isRunning: false,
  isFirstPrompt: false,
  editor: { focus: vi.fn(), getText: () => "", setText: vi.fn(), insertText: vi.fn() },
  attachments: { items: [], add: vi.fn(), remove: vi.fn() },
  contextUsage: null,
  slashCommands: undefined,
  send: vi.fn(),
  history: [],
};

function CaptureSelection({ view }: { view: EditorView }) {
  const terminal = {
    focus: vi.fn(),
    clearScreen: vi.fn(),
    clearInput: vi.fn(),
    blur: vi.fn(),
    markForKill: vi.fn(),
    write: vi.fn(),
    getSelection: () => "$ ls\nsrc/",
    paste: vi.fn(),
  };
  useAddSelectionToPrompt({
    featureId: 46,
    enabled: true,
    getActive: () => ({ view, filePath: "test.ts" }),
  });
  useAddTerminalSelectionToPrompt({
    featureId: 46,
    enabled: true,
    activePaneId: "terminal",
    paneRefs: { current: new Map([["terminal", terminal]]) },
  });
  return <ContextTray />;
}

it("localizes new and restored selection chips while preserving the prompt built from them", async () => {
  const key = composerKeyFor(46);
  const storageKey = `cadencr:composer-context:${key}`;
  const view = new EditorView({
    state: EditorState.create({
      doc: "const n = 1;\nconst m = 2;",
      selection: { anchor: 0, head: 25 },
    }),
  });
  localStorage.setItem(
    storageKey,
    JSON.stringify([
      {
        id: "saved",
        kind: "selection",
        label: "legacy.ts",
        detail: "line 7",
        content: "saved",
        language: "typescript",
      },
      {
        id: "saved-term",
        kind: "terminal",
        label: "Terminal output",
        detail: "1 line",
        content: "old output",
      },
    ]),
  );
  uiI18n.addResourceBundle("fr", "ui", {
    workspace: { tools: { terminal: { selectionLabel: "Sortie du terminal" } } },
    conversation: {
      composer: {
        contextTray: {
          selectedLine: "ligne {{start}}",
          selectedLines: "lignes {{start}}–{{end}}",
          lineCount_one: "{{count}} ligne",
          lineCount_other: "{{count}} lignes",
        },
      },
    },
  });
  try {
    render(
      <ComposerContextProvider value={composer}>
        <CaptureSelection view={view} />
      </ComposerContextProvider>,
    );
    expect(screen.getByText("line 7")).toBeVisible();
    expect(screen.getByText("Terminal output")).toBeVisible();
    await act(async () => {
      await uiI18n.changeLanguage("fr");
    });
    expect(screen.getByText("ligne 7")).toBeVisible();
    expect(screen.getByText("Sortie du terminal")).toBeVisible();
    act(() => {
      for (const id of ["terminal-add-selection-to-prompt", "editor-add-selection-to-prompt"]) {
        const trigger = shortcuts.get(id);
        if (!trigger) throw new Error(`Missing shortcut ${id}`);
        trigger(new KeyboardEvent("keydown"));
      }
    });
    expect(screen.getByText("2 lignes")).toBeVisible();
    expect(screen.getByText("lignes 1–2")).toBeVisible();
    const prompt = appendComposerContext(
      "Review this",
      useComposerContextStore.getState().items[key] ?? [],
    );
    expect(prompt).toBe(
      "Review this\n\n**legacy.ts — line 7**\n```typescript\nsaved\n```\n\n" +
        "**Terminal output — 1 line**\n```\nold output\n```\n\n" +
        "**Terminal output — 2 lines**\n```\n$ ls\nsrc/\n```\n\n" +
        "**test.ts — lines 1–2**\n```typescript\nconst n = 1;\nconst m = 2;\n```",
    );
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
    expect(screen.getByText("lines 1–2")).toBeVisible();
    expect(
      appendComposerContext("Review this", useComposerContextStore.getState().items[key] ?? []),
    ).toBe(prompt);
  } finally {
    view.destroy();
    localStorage.removeItem(storageKey);
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
    uiI18n.removeResourceBundle("fr", "ui");
  }
});
