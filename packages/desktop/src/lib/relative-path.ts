/**
 * `absPath` relative to `projectRoot`, or `null` when it does not live under
 * it. Handles POSIX (`/`) and Windows (`\`) separators and trailing
 * separators on either side; the root itself is `""`.
 */
export function relativeToProject(absPath: string, projectRoot: string): string | null {
  const normalizedRoot = projectRoot.replace(/[\\/]+$/, "");
  const target = absPath.length > 1 ? absPath.replace(/[\\/]+$/, "") : absPath;
  if (target === normalizedRoot) return "";
  for (const separator of ["/", "\\"]) {
    const prefix = `${normalizedRoot}${separator}`;
    if (target.startsWith(prefix)) return target.slice(prefix.length);
  }
  return null;
}
