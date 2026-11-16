/**
 * Metric-compatible stand-ins for Office's default fonts, served from the app
 * itself: Carlito for Calibri, Caladea for Cambria (both OFL). The ooxml
 * renderer already lists them right after the Office family in every font
 * stack, so a Calibri document lays out with Calibri's widths on a machine
 * without Office — without the library's opt-in Google Fonts download.
 *
 * Canvas text doesn't trigger web-font loading, so the faces must be loaded
 * before the first paint (`loadOfficeFonts`).
 */
import "@fontsource/carlito/400.css";
import "@fontsource/carlito/400-italic.css";
import "@fontsource/carlito/700.css";
import "@fontsource/carlito/700-italic.css";
import "@fontsource/caladea/400.css";
import "@fontsource/caladea/400-italic.css";
import "@fontsource/caladea/700.css";
import "@fontsource/caladea/700-italic.css";

const FACES = ["Carlito", "Caladea"].flatMap((family) =>
  ["400", "italic 400", "700", "italic 700"].map((style) => `${style} 16px "${family}"`),
);

let loading: Promise<void> | null = null;

export function loadOfficeFonts(): Promise<void> {
  loading ??= Promise.all(FACES.map((face) => document.fonts.load(face))).then(
    () => undefined,
    (error: unknown) => {
      // Let the next document retry rather than fail for the whole session.
      loading = null;
      throw error;
    },
  );
  return loading;
}
