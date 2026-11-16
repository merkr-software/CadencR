/** URL.hostname is normalized by WHATWG URL before this check. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(host)
  );
}
