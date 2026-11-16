/**
 * Made-up logos for the display options preview's sample projects, so the
 * preview looks like a real workspace, where projects usually carry one.
 * Inline SVG data URLs: nothing to fetch, and `img-src` allows `data:`.
 * Each is drawn on a 16-unit grid, in its project's color, to stay legible at
 * the badge's 14px.
 */
const LOGOS = {
  /** A bolt on a tile. */
  webApp: (fill: string) =>
    `<rect width="16" height="16" rx="4" fill="${fill}"/><path d="M9.2 2.5 4.5 9h3.3l-1 4.5L11.5 7H8.2z" fill="#fff"/>`,
  /** A coin on a disc. */
  billingApi: (fill: string) =>
    `<circle cx="8" cy="8" r="8" fill="${fill}"/><circle cx="8" cy="8" r="3.6" fill="none" stroke="#fff" stroke-width="2"/>`,
  /** Four components on a tile, one of them ghosted. */
  designSystem: (fill: string) =>
    `<rect width="16" height="16" rx="4" fill="${fill}"/><rect x="3.5" y="3.5" width="3.8" height="3.8" rx="1" fill="#fff"/><rect x="8.7" y="3.5" width="3.8" height="3.8" rx="1.9" fill="#fff"/><rect x="3.5" y="8.7" width="3.8" height="3.8" rx="1" fill="#fff"/><rect x="8.7" y="8.7" width="3.8" height="3.8" rx="1" fill="#fff" fill-opacity=".45"/>`,
} as const;

export type SampleLogo = keyof typeof LOGOS;

/** `color` is a project color: hex digits, no `#`. */
export function sampleLogoUrl(logo: SampleLogo, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${LOGOS[logo](`#${color}`)}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
