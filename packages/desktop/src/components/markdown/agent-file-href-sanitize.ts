import { parseAgentFileHref } from "@/components/prompt-editor/file-reference";

/**
 * rehype plugins that carry agent file links (`[x](foo.ts:42)`,
 * `[x](file:///abs/x.rs)`, `[x](C:/x.rs)`) through `rehype-sanitize`.
 *
 * Its protocol check reads whatever precedes a first `:` that comes before any
 * `/`, `?`, or `#` as a URL scheme, so `foo.ts:` / `file:` / `C:` fail the
 * allowlist and the whole `href` is dropped — every such link went dead in any
 * message containing a `<`. `protect…` wraps those hrefs in an allowlisted
 * scheme before the sanitize pass and `restore…` unwraps them right after.
 */

export const AGENT_FILE_HREF_SCHEME = "cadencr-agent-file";
const PREFIX = `${AGENT_FILE_HREF_SCHEME}:`;

/** The slice of a hast tree these plugins touch. */
interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** `C:/…` or `C:\…`: the only colon a smuggled path may still contain. */
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

/**
 * Only exact file links pass: a parsed path with any other colon left in it
 * (`vbscript:run/x.rs` "has a slash") must still face the allowlist.
 */
function isSmugglableFileHref(href: string): boolean {
  if (href.trim().startsWith("file://")) return parseAgentFileHref(href) !== null;
  const path = parseAgentFileHref(href)?.path;
  return path !== undefined && !path.replace(DRIVE_PREFIX, "").includes(":");
}

/** `rewrite` returns the new href, `null` to drop it, or `undefined` to keep it. */
function rewriteLinkHrefs(
  node: HastNode,
  rewrite: (href: string) => string | null | undefined,
): void {
  const properties = node.type === "element" && node.tagName === "a" ? node.properties : undefined;
  if (properties && typeof properties.href === "string") {
    const next = rewrite(properties.href);
    if (next === null) delete properties.href;
    else if (next !== undefined) properties.href = next;
  }
  node.children?.forEach((child) => rewriteLinkHrefs(child, rewrite));
}

export function protectAgentFileHrefs() {
  return (tree: HastNode): void =>
    rewriteLinkHrefs(tree, (href) =>
      isSmugglableFileHref(href) ? PREFIX + encodeURIComponent(href) : undefined,
    );
}

/**
 * Raw HTML can spell the envelope itself (`cadencr-agent-file:javascript%3A…`),
 * and the allowlist lets it through — so only a payload that is still a file
 * link gets unwrapped; anything else loses its href.
 */
export function restoreAgentFileHrefs() {
  return (tree: HastNode): void =>
    rewriteLinkHrefs(tree, (href) => {
      if (!href.startsWith(PREFIX)) return undefined;
      const original = decodeEnvelope(href.slice(PREFIX.length));
      return original !== null && isSmugglableFileHref(original) ? original : null;
    });
}

function decodeEnvelope(payload: string): string | null {
  try {
    return decodeURIComponent(payload);
  } catch {
    // Malformed escapes can only come from a hand-written envelope: not a link.
    return null;
  }
}
