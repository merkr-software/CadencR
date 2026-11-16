import { isLoopbackHost } from "./loopback-host";
import { getBrowserDeniedOrigins } from "./runtime-config";

let previousOrigins: readonly string[] = [];
let protectedUrls: readonly (URL | null)[] = [];

function compiledOrigins(): readonly (URL | null)[] {
  const origins = getBrowserDeniedOrigins();
  if (
    origins.length !== previousOrigins.length ||
    origins.some((origin, i) => origin !== previousOrigins[i])
  ) {
    previousOrigins = origins;
    protectedUrls = origins.map((origin) => {
      try {
        return new URL(origin);
      } catch {
        return null;
      }
    });
  }
  return protectedUrls;
}

/** Dedicated local listener ports stay protected through DNS, LAN and loopback aliases. */
export function isCadencrBrowserUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return compiledOrigins().some((protectedUrl) => {
    if (!protectedUrl) return true;
    if (url.origin === protectedUrl.origin) return true;
    const port = effectivePort(url);
    if (port !== effectivePort(protectedUrl)) return false;
    // A Cadencr listener's nonstandard port is reserved on every hostname:
    // hostnames may resolve to this machine via DNS, LAN or Tailscale addresses.
    if (isLoopbackHost(protectedUrl.hostname) && protectedUrl.port !== "") return true;
    return isLoopbackHost(url.hostname) && isLoopbackHost(protectedUrl.hostname);
  });
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}
