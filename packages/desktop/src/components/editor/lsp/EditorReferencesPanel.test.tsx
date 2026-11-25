import { EditorView } from "@codemirror/view";
import { act, render, screen } from "@/test-utils";
import { uiI18n } from "@/lib/i18n/ui";
import { expect, it } from "vitest";
import EditorReferencesPanel from "./EditorReferencesPanel";

it("uses the English plural default for zero results in French", async () => {
  const view = new EditorView();
  try {
    render(
      <EditorReferencesPanel
        view={view}
        references={[]}
        workspaceRoot={null}
        open
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("0 references in 0 files");
    await act(async () => {
      await uiI18n.changeLanguage("fr");
    });
    expect(screen.getByRole("heading")).toHaveTextContent("0 references in 0 files");
  } finally {
    view.destroy();
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
  }
});
