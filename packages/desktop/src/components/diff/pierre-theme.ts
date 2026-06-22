import { registerCustomTheme } from "@pierre/diffs";
import type { ThemeId } from "@/lib/themes";

const CADENCR_DRACULA_DIFF_THEME = "cadencr-dracula-diff";
const CADENCR_AURORA_DIFF_THEME = "cadencr-aurora-diff";
const CADENCR_ONE_DARK_DIFF_THEME = "cadencr-one-dark-diff";
const CADENCR_ONE_LIGHT_DIFF_THEME = "cadencr-one-light-diff";
const CADENCR_MONOKAI_DIFF_THEME = "cadencr-monokai-diff";
const CADENCR_MONOKAI_LIGHT_DIFF_THEME = "cadencr-monokai-light-diff";
const CADENCR_FROST_DARK_DIFF_THEME = "cadencr-frost-dark-diff";
const CADENCR_FROST_LIGHT_DIFF_THEME = "cadencr-frost-light-diff";
const CADENCR_CARBON_OWL_DIFF_THEME = "cadencr-carbon-owl-diff";
const CADENCR_PAPER_OWL_DIFF_THEME = "cadencr-paper-owl-diff";

type PierreThemeName =
  | typeof CADENCR_DRACULA_DIFF_THEME
  | typeof CADENCR_AURORA_DIFF_THEME
  | typeof CADENCR_ONE_DARK_DIFF_THEME
  | typeof CADENCR_ONE_LIGHT_DIFF_THEME
  | typeof CADENCR_MONOKAI_DIFF_THEME
  | typeof CADENCR_MONOKAI_LIGHT_DIFF_THEME
  | typeof CADENCR_FROST_DARK_DIFF_THEME
  | typeof CADENCR_FROST_LIGHT_DIFF_THEME
  | typeof CADENCR_CARBON_OWL_DIFF_THEME
  | typeof CADENCR_PAPER_OWL_DIFF_THEME;
type PierreThemeRegistration = Parameters<typeof registerCustomTheme>[1] extends () => Promise<
  infer Theme
>
  ? Theme
  : never;

/**
 * Shared TextMate scope groups for Pierre diff themes — kept in one place so
 * per-theme palettes only need to declare hex values, not repeat the scope
 * literals. Order is meaningful only insofar as it mirrors the TextMate
 * convention (comment → keyword → string → …).
 */
const TOKEN_SCOPES = [
  { key: "comment", scope: ["comment", "punctuation.definition.comment"], italic: true },
  { key: "keyword", scope: ["keyword", "storage", "storage.type"] },
  { key: "string", scope: ["string", "constant.other.symbol"] },
  { key: "number", scope: ["constant.numeric", "constant.language", "support.constant"] },
  { key: "function", scope: ["entity.name.function", "support.function", "variable.language"] },
  { key: "type", scope: ["entity.name.type", "entity.name.class", "support.type"] },
  { key: "tag", scope: ["entity.name.tag", "support.class", "variable.other.constant"] },
  { key: "deleted", scope: ["invalid", "markup.deleted"] },
  { key: "inserted", scope: ["markup.inserted"] },
] as const satisfies ReadonlyArray<{
  key: string;
  scope: readonly string[];
  italic?: boolean;
}>;

type TokenKey = (typeof TOKEN_SCOPES)[number]["key"];
type Palette = Record<TokenKey, string>;

interface EditorColors {
  background: string;
  foreground: string;
  lineHighlight: string;
  selection: string;
}

function buildPierreTheme(
  name: PierreThemeName,
  type: "dark" | "light",
  editor: EditorColors,
  palette: Palette,
): PierreThemeRegistration {
  return {
    name,
    type,
    colors: {
      "editor.background": editor.background,
      "editor.foreground": editor.foreground,
      "editor.lineHighlightBackground": editor.lineHighlight,
      "editor.selectionBackground": editor.selection,
    },
    tokenColors: TOKEN_SCOPES.map((entry) => {
      const italic = "italic" in entry && entry.italic;
      return {
        scope: [...entry.scope],
        settings: italic
          ? { foreground: palette[entry.key], fontStyle: "italic" }
          : { foreground: palette[entry.key] },
      };
    }),
  };
}

const DRACULA_THEME = buildPierreTheme(
  CADENCR_DRACULA_DIFF_THEME,
  "dark",
  {
    background: "#1e2030",
    foreground: "#f8f8f2",
    lineHighlight: "#2a2c3e",
    selection: "#44475a",
  },
  {
    comment: "#6272a4",
    keyword: "#ff79c6",
    string: "#f1fa8c",
    number: "#ffb86c",
    function: "#50fa7b",
    type: "#8be9fd",
    tag: "#bd93f9",
    deleted: "#ff5555",
    inserted: "#50fa7b",
  },
);

const AURORA_THEME = buildPierreTheme(
  CADENCR_AURORA_DIFF_THEME,
  "light",
  {
    background: "#ffffff",
    foreground: "#2f2438",
    lineHighlight: "#f3eef8",
    selection: "#ded1f0",
  },
  {
    comment: "#746986",
    keyword: "#a01872",
    string: "#8a6500",
    number: "#9b5f00",
    function: "#1f7a42",
    type: "#126a80",
    tag: "#6a32be",
    deleted: "#b42318",
    inserted: "#1f7a42",
  },
);

const ONE_DARK_THEME = buildPierreTheme(
  CADENCR_ONE_DARK_DIFF_THEME,
  "dark",
  {
    background: "#282c34",
    foreground: "#abb2bf",
    lineHighlight: "#2c313a",
    selection: "#3e4451",
  },
  {
    comment: "#5c6370",
    keyword: "#c678dd",
    string: "#98c379",
    number: "#d19a66",
    function: "#61afef",
    type: "#e5c07b",
    tag: "#e06c75",
    deleted: "#e06c75",
    inserted: "#98c379",
  },
);

const ONE_LIGHT_THEME = buildPierreTheme(
  CADENCR_ONE_LIGHT_DIFF_THEME,
  "light",
  {
    background: "#fbfaf8",
    foreground: "#383a42",
    lineHighlight: "#eeece6",
    selection: "#e6e3dd",
  },
  {
    comment: "#a0a1a7",
    keyword: "#a626a4",
    string: "#50a14f",
    number: "#986801",
    function: "#4078f2",
    type: "#c18401",
    tag: "#e45649",
    deleted: "#e45649",
    inserted: "#50a14f",
  },
);

const MONOKAI_THEME = buildPierreTheme(
  CADENCR_MONOKAI_DIFF_THEME,
  "dark",
  {
    background: "#272822",
    foreground: "#f8f8f2",
    lineHighlight: "#3e3d32",
    selection: "#49483e",
  },
  {
    comment: "#75715e",
    keyword: "#f92672",
    string: "#e6db74",
    number: "#ae81ff",
    function: "#a6e22e",
    type: "#66d9ef",
    tag: "#f92672",
    deleted: "#f92672",
    inserted: "#a6e22e",
  },
);

const MONOKAI_LIGHT_THEME = buildPierreTheme(
  CADENCR_MONOKAI_LIGHT_DIFF_THEME,
  "light",
  {
    background: "#faf9f5",
    foreground: "#3a3a32",
    lineHighlight: "#eceae1",
    selection: "#e3e1d8",
  },
  {
    comment: "#9a958a",
    keyword: "#d4006a",
    string: "#8a7400",
    number: "#7c3aed",
    function: "#5a8a00",
    type: "#0089b3",
    tag: "#d4006a",
    deleted: "#d4006a",
    inserted: "#5a8a00",
  },
);

const FROST_DARK_THEME = buildPierreTheme(
  CADENCR_FROST_DARK_DIFF_THEME,
  "dark",
  {
    background: "#141826",
    foreground: "#d9e2ee",
    lineHighlight: "#1e2740",
    selection: "#2a3550",
  },
  {
    comment: "#6f7a93",
    keyword: "#c8a6ff",
    string: "#6fe0a8",
    number: "#f2d98a",
    function: "#6cb6ff",
    type: "#7fd6e8",
    tag: "#ff97a0",
    deleted: "#ff7a85",
    inserted: "#6fe0a8",
  },
);

const FROST_LIGHT_THEME = buildPierreTheme(
  CADENCR_FROST_LIGHT_DIFF_THEME,
  "light",
  {
    background: "#eef3fa",
    foreground: "#2a3142",
    lineHighlight: "#e2ebf7",
    selection: "#d4e2f5",
  },
  {
    comment: "#6b7488",
    keyword: "#7a4fc0",
    string: "#2f8a5b",
    number: "#9a7a10",
    function: "#2f6fd0",
    type: "#1f7d9c",
    tag: "#c2384a",
    deleted: "#c2384a",
    inserted: "#2f8a5b",
  },
);

const CARBON_OWL_THEME = buildPierreTheme(
  CADENCR_CARBON_OWL_DIFF_THEME,
  "dark",
  {
    background: "#1b1d22",
    foreground: "#bbbbbb",
    lineHighlight: "#22262d",
    selection: "#353d49",
  },
  {
    comment: "#6c7689",
    keyword: "#d39e17",
    string: "#37ae6f",
    number: "#c13838",
    function: "#3398db",
    type: "#a15def",
    tag: "#de456b",
    deleted: "#c13838",
    inserted: "#37ae6f",
  },
);

const PAPER_OWL_THEME = buildPierreTheme(
  CADENCR_PAPER_OWL_DIFF_THEME,
  "light",
  {
    background: "#f7f4ec",
    foreground: "#403f53",
    lineHighlight: "#ece7db",
    selection: "#d3e8f8",
  },
  {
    comment: "#7e8595",
    keyword: "#994cc3",
    string: "#08916a",
    number: "#aa0982",
    function: "#4876d6",
    type: "#0c969b",
    tag: "#d3423e",
    deleted: "#d3423e",
    inserted: "#08916a",
  },
);

let registered = false;

export function ensurePierreThemesRegistered(): void {
  if (registered) return;
  registerCustomTheme(CADENCR_DRACULA_DIFF_THEME, () => Promise.resolve(DRACULA_THEME));
  registerCustomTheme(CADENCR_AURORA_DIFF_THEME, () => Promise.resolve(AURORA_THEME));
  registerCustomTheme(CADENCR_ONE_DARK_DIFF_THEME, () => Promise.resolve(ONE_DARK_THEME));
  registerCustomTheme(CADENCR_ONE_LIGHT_DIFF_THEME, () => Promise.resolve(ONE_LIGHT_THEME));
  registerCustomTheme(CADENCR_MONOKAI_DIFF_THEME, () => Promise.resolve(MONOKAI_THEME));
  registerCustomTheme(CADENCR_MONOKAI_LIGHT_DIFF_THEME, () => Promise.resolve(MONOKAI_LIGHT_THEME));
  registerCustomTheme(CADENCR_FROST_DARK_DIFF_THEME, () => Promise.resolve(FROST_DARK_THEME));
  registerCustomTheme(CADENCR_FROST_LIGHT_DIFF_THEME, () => Promise.resolve(FROST_LIGHT_THEME));
  registerCustomTheme(CADENCR_CARBON_OWL_DIFF_THEME, () => Promise.resolve(CARBON_OWL_THEME));
  registerCustomTheme(CADENCR_PAPER_OWL_DIFF_THEME, () => Promise.resolve(PAPER_OWL_THEME));
  registered = true;
}

export function getPierreThemeName(themeId: ThemeId): PierreThemeName {
  switch (themeId) {
    case "aurora":
      return CADENCR_AURORA_DIFF_THEME;
    case "one-dark":
      return CADENCR_ONE_DARK_DIFF_THEME;
    case "one-light":
      return CADENCR_ONE_LIGHT_DIFF_THEME;
    case "dracula":
      return CADENCR_DRACULA_DIFF_THEME;
    case "monokai":
      return CADENCR_MONOKAI_DIFF_THEME;
    case "monokai-light":
      return CADENCR_MONOKAI_LIGHT_DIFF_THEME;
    case "frost-dark":
      return CADENCR_FROST_DARK_DIFF_THEME;
    case "frost-light":
      return CADENCR_FROST_LIGHT_DIFF_THEME;
    case "carbon-owl":
      return CADENCR_CARBON_OWL_DIFF_THEME;
    case "paper-owl":
      return CADENCR_PAPER_OWL_DIFF_THEME;
  }
}
