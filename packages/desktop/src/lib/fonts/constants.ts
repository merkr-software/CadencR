/**
 * The single canonical default monospace stack. Matches the CSS `--font-mono`
 * default in index.css and replaces the previously divergent hardcoded xterm
 * stack. A user-chosen family is prepended in front of this; the stack stays
 * behind it as a graceful fallback for missing glyphs.
 */
export const DEFAULT_MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace, "Noto Sans JP Variable"';

/** Workspace setting key. Mirrored in packages/service settings allowlist. */
export const MONO_FONT_SETTING_KEY = "mono_font_family";

/** Fixed TypeScript preview snippet — exhibits discriminating glyphs. */
export const MONO_FONT_PREVIEW = `const greet = (name: string): string => {
  return \`Hello, \${name}!\`; // 0O1lI| => ->
};`;

/**
 * Build the CSS font-family value for a chosen family (or the default when
 * null/empty). The chosen face goes first; DEFAULT_MONO_STACK is the fallback.
 */
export function resolveMonoStack(family: string | null): string {
  return family ? `"${family}", ${DEFAULT_MONO_STACK}` : DEFAULT_MONO_STACK;
}
