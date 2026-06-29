/**
 * Whether a URL is safe to hand to an external browser context. Mirrors the
 * Electron main-process policy (`electron/main/ipc.ts::openExternal`) so the
 * browser-fallback path in `desktop-bridge` can't open anything the desktop
 * shell would reject: `https:` only, no embedded credentials, no loopback. This
 * keeps the same invariant on both code paths instead of trusting raw input to
 * `window.open` in a remote tab.
 */
export function isSafeExternalUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1";
}

/**
 * Whether a URL is safe to hand to the system browser as a *user-initiated*
 * link open (`openExternalLink`). Looser than {@link isSafeExternalUrl}: it
 * also permits `http:` and loopback hosts, because explicitly choosing "open
 * in default browser" on a `localhost` dev URL is a legitimate action. Still
 * rejects credentials and any non-http(s) scheme (`file:`, `javascript:`,
 * `data:`), which the `new URL` protocol check below enforces.
 */
export function isUserOpenableUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return !parsed.username && !parsed.password;
}
