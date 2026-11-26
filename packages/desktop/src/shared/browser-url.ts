/** Return the `http(s)` origin for `rawUrl`, or `null` for non-web or invalid URLs. */
export function httpBrowserOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Whether an address denotes a web page (`http:` or `https:`). */
export function isHttpBrowserUrl(rawUrl: string): boolean {
  return httpBrowserOrigin(rawUrl) !== null;
}
