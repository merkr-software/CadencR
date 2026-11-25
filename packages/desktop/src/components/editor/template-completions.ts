import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { autocompletion, type CompletionContext, type Completion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";

interface PhaseInfo {
  slug: string;
  name: string;
}

interface TemplateVariable {
  label: string;
  detail: string;
}

function builtinVariables(t: UiTranslator): TemplateVariable[] {
  return [
    {
      label: "feature_title",
      detail: t("workspace.editor.template.feature_title", "The user-provided feature name"),
    },
    {
      label: "feature_description",
      detail: t(
        "workspace.editor.template.feature_description",
        "Feature description (PRD or user input)",
      ),
    },
    { label: "project_name", detail: t("workspace.editor.template.project_name", "Project name") },
    {
      label: "project_path",
      detail: t("workspace.editor.template.project_path", "Project filesystem path"),
    },
    {
      label: "phase_name",
      detail: t("workspace.editor.template.phase_name", "Name of the current phase"),
    },
    {
      label: "prior_artifacts",
      detail: t(
        "workspace.editor.template.prior_artifacts",
        "Concatenated artifacts from input phases",
      ),
    },
    { label: "date", detail: t("workspace.editor.template.date", "Current date (YYYY-MM-DD)") },
  ];
}

/** @internal Exported for testing */
export function buildCompletions(precedingPhases: PhaseInfo[]): Completion[] {
  const builtins: Completion[] = builtinVariables(translateUi).map((v) => ({
    label: `{{${v.label}}}`,
    detail: v.detail,
    type: "variable",
  }));

  const artifacts: Completion[] = precedingPhases.map((p) => ({
    label: `{{artifact:${p.slug}}}`,
    detail: translateUi(
      "workspace.editor.template.phaseArtifact",
      "Artifact from '{{phase}}' phase",
      { phase: p.name },
    ),
    type: "variable",
  }));

  return [...builtins, ...artifacts];
}

/** @internal Exported for testing */
export function templateCompletionSource(precedingPhases: PhaseInfo[]) {
  return (context: CompletionContext) => {
    // Find the nearest `{{` before the cursor
    const line = context.state.doc.lineAt(context.pos);
    const textBefore = line.text.slice(0, context.pos - line.from);
    const openIdx = textBefore.lastIndexOf("{{");

    if (openIdx === -1) return null;

    // Don't trigger if there's a `}}` between `{{` and cursor (already closed)
    const between = textBefore.slice(openIdx + 2);
    if (between.includes("}}")) return null;

    const from = line.from + openIdx;

    return {
      from,
      options: buildCompletions(precedingPhases),
      filter: true,
    };
  };
}

/** Returns a CodeMirror extension that provides `{{variable}}` autocompletion. */
export function templateAutocompletion(precedingPhases: PhaseInfo[]): Extension {
  return autocompletion({
    override: [templateCompletionSource(precedingPhases)],
    icons: false,
  });
}
