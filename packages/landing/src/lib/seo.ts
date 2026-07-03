/**
 * Centralized brand + structured-data helpers.
 *
 * The brand name is intentionally spelled "CadencR" everywhere (the official
 * name). Lowercase variants ("cadencr", the cadencr.com domain) and the
 * "Cadencr" spelling are declared as `alternateName` so Google still resolves
 * them to the same entity — the single most important signal for a brand whose
 * name collides with the common word "cadence".
 */

export const SITE_URL = "https://cadencr.com";
export const BRAND_NAME = "CadencR";
const BRAND_TAGLINE = "The IDE for the era of agents.";

/** Spelling variants that all refer to the same product/entity. */
const BRAND_ALT_NAMES = ["Cadencr", "Cadencr IDE", "CadencR IDE", "cadencr"];

const ORG_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;
const LOGO_ID = `${SITE_URL}/#logo`;

export type SchemaNode = Record<string, unknown>;

/** Reference used by page-specific nodes to point back at the Organization. */
export const ORG_REF: SchemaNode = { "@id": ORG_ID };

const organizationSchema: SchemaNode = {
  "@type": "Organization",
  "@id": ORG_ID,
  name: BRAND_NAME,
  alternateName: BRAND_ALT_NAMES,
  url: `${SITE_URL}/`,
  logo: {
    "@type": "ImageObject",
    "@id": LOGO_ID,
    url: `${SITE_URL}/logo.png`,
    contentUrl: `${SITE_URL}/logo.png`,
    width: 512,
    height: 512,
    caption: BRAND_NAME,
  },
  image: { "@id": LOGO_ID },
  description:
    "CadencR is a local, open-source desktop IDE that unifies the Claude Code, OpenCode, and Codex coding agents into one workspace.",
  slogan: BRAND_TAGLINE,
  foundingLocation: { "@type": "Place", name: "Paris, France" },
  sameAs: ["https://github.com/merkr-software/cadencr", "https://github.com/merkr-software"],
};

const websiteSchema: SchemaNode = {
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: BRAND_NAME,
  alternateName: BRAND_ALT_NAMES,
  url: `${SITE_URL}/`,
  description:
    "CadencR is a local agent IDE for Claude Code, OpenCode, and Codex. Read streams, manage worktrees, inspect diffs, and ship from one desktop workspace.",
  publisher: ORG_REF,
  inLanguage: "en",
};

function stripContext(node: SchemaNode): SchemaNode {
  const clone: SchemaNode = { ...node };
  delete clone["@context"];
  return clone;
}

/**
 * Build the JSON-LD `@graph` for a page: the sitewide Organization + WebSite
 * entities, followed by any page-specific nodes. Page nodes may carry their own
 * `@context` (stripped here) since the graph declares a single shared one.
 */
export function buildGraph(pageNodes: SchemaNode | SchemaNode[] | undefined): string {
  const nodes = pageNodes ? (Array.isArray(pageNodes) ? pageNodes : [pageNodes]) : [];
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [organizationSchema, websiteSchema, ...nodes.map(stripContext)],
  });
}
