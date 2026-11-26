import { EditorView } from "@codemirror/view";
import { act, render, screen } from "@/test-utils";
import { uiI18n } from "@/lib/i18n/ui";
import frFR from "@/lib/i18n/catalogs/fr-FR.json";
import { expect, it } from "vitest";
import EditorReferencesPanel from "./EditorReferencesPanel";

it("uses the catalog's zero-count form for references and files", async () => {
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
      await uiI18n.changeLanguage("fr-FR");
    });
    const { referenceSummary_zero, referenceCount_zero } = frFR.ui.workspace.editor.references;
    const references = referenceCount_zero.replace("{{count, number}}", "0");
    expect(screen.getByRole("heading")).toHaveTextContent(
      referenceSummary_zero.replace("{{references}}", references).replace("{{count, number}}", "0"),
    );
  } finally {
    view.destroy();
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
  }
});
