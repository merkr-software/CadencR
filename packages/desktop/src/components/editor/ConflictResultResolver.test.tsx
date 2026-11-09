import { Text } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { useEditorStore } from "@/stores/editor-store";

const mocks = vi.hoisted(() => ({ save: vi.fn(), saveQuiet: vi.fn() }));

vi.mock("@/hooks/useSetting", () => ({
  useSetting: () => ({ value: "false", setValue: vi.fn(), isLoading: false }),
}));
vi.mock("@/hooks/useEditorLanguage", () => ({
  useEditorLanguage: () => ({ languageId: "typescript" }),
}));
vi.mock("./useEditorFormat", () => ({ useEditorFormat: () => ({ beforeWrite: undefined }) }));
vi.mock("./useEditorSave", () => ({
  useEditorSave: () => ({
    save: mocks.save,
    saveForClose: mocks.save,
    saveQuiet: mocks.saveQuiet,
    onDocChange: () => {
      useEditorStore.getState().setDirty(7, "main", "conflict.ts", true);
      return true;
    },
    autoSavedVisible: false,
    isSaving: false,
    errorMessage: null,
  }),
}));
vi.mock("./editorSaveRegistry", () => ({ registerSave: vi.fn(), unregisterSave: vi.fn() }));
vi.mock("./BaseCodeMirrorEditor", () => ({
  default: ({
    initialContent,
    onDocChange,
    onSave,
  }: {
    initialContent?: string;
    onDocChange?: (content: Text) => void;
    onSave?: () => void;
  }) => (
    <div>
      <output>{initialContent}</output>
      <button type="button" onClick={() => onDocChange?.(Text.of(["edited Result"]))}>
        Edit Result
      </button>
      <button type="button" onClick={onSave}>
        CodeMirror Save
      </button>
    </div>
  ),
}));

import ConflictResultResolver from "./ConflictResultResolver";

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState({ features: {} });
  const store = useEditorStore.getState();
  store.initFeature(7);
  store.openFile(7, "main", "conflict.ts");
  mocks.save.mockImplementation(async () => {
    useEditorStore.getState().setDirty(7, "main", "conflict.ts", false);
  });
});

describe("ConflictResultResolver", () => {
  it("is one writable Result with no comparison or staging surface", async () => {
    const { user } = render(
      <ConflictResultResolver
        featureId={7}
        paneId="main"
        projectId={2}
        filePath="conflict.ts"
        initialContent={"<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n"}
        operation="merge"
      />,
    );

    expect(screen.getByLabelText("Writable Result")).toBeInTheDocument();
    expect(screen.queryByText("Compare Result with")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stage/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit Result" }));
    expect(
      useEditorStore
        .getState()
        .features[7]?.panes.main?.tabs.find((tab) => tab.filePath === "conflict.ts")?.isDirty,
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "CodeMirror Save" }));
    expect(mocks.save).toHaveBeenCalledOnce();
  });
});
