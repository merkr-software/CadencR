import { beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, type BrowserWindow, type WebContents } from "electron";
import { uiI18n } from "../../src/shared/ui-i18n";
import { installContextMenu, suppressNextNativeContextMenu } from "./context-menu";

const menuPopup = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: menuPopup })),
  },
}));

interface ContextMenuEvent {
  preventDefault: () => void;
}

interface ContextMenuParams {
  misspelledWord: string;
  dictionarySuggestions: string[];
  linkURL: string;
  mediaType: string;
  x: number;
  y: number;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

function contextParams(): ContextMenuParams {
  return {
    misspelledWord: "",
    dictionarySuggestions: [],
    linkURL: "",
    mediaType: "none",
    x: 10,
    y: 12,
    editFlags: {
      canCut: false,
      canCopy: false,
      canPaste: true,
      canSelectAll: false,
    },
  };
}

function install(webContentsId = 7): (event: ContextMenuEvent, params: ContextMenuParams) => void {
  const handlers = new Map<string, unknown>();
  const webContents = {
    id: webContentsId,
    on: vi.fn((channel: string, handler: unknown) => {
      handlers.set(channel, handler);
    }),
    send: vi.fn(),
    replaceMisspelling: vi.fn(),
    copyImageAt: vi.fn(),
  } as unknown as WebContents;

  installContextMenu({} as BrowserWindow, webContents);

  return handlers.get("context-menu") as (
    event: ContextMenuEvent,
    params: ContextMenuParams,
  ) => void;
}

describe("installContextMenu", () => {
  beforeEach(() => {
    menuPopup.mockClear();
    vi.mocked(Menu.buildFromTemplate).mockClear();
  });

  it("suppresses exactly the next native popup when the renderer owns the context menu", () => {
    const handler = install();
    const event = { preventDefault: vi.fn() };

    suppressNextNativeContextMenu(7);
    handler(event, contextParams());

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    expect(menuPopup).not.toHaveBeenCalled();

    handler(event, contextParams());

    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(menuPopup).toHaveBeenCalledTimes(1);
  });

  it("localizes edit actions while retaining their roles and availability", async () => {
    uiI18n.addResourceBundle("fr", "ui", {
      "native.menu.cut": "Couper",
      "native.menu.copy": "Copier",
      "native.menu.paste": "Coller",
      "native.menu.selectAll": "Tout sélectionner",
    });
    try {
      await uiI18n.changeLanguage("fr");
      install()({ preventDefault: vi.fn() }, contextParams());
      expect(Menu.buildFromTemplate).toHaveBeenCalledWith([
        { role: "cut", label: "Couper", enabled: false },
        { role: "copy", label: "Copier", enabled: false },
        { role: "paste", label: "Coller", enabled: true },
        { role: "selectAll", label: "Tout sélectionner", enabled: false },
      ]);
    } finally {
      await uiI18n.changeLanguage("en");
      uiI18n.removeResourceBundle("fr", "ui");
    }
  });

  it("does not let one renderer suppress another renderer native popup", () => {
    const handler = install(7);
    const event = { preventDefault: vi.fn() };

    suppressNextNativeContextMenu(8);
    handler(event, contextParams());

    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(menuPopup).toHaveBeenCalledTimes(1);
  });
});
