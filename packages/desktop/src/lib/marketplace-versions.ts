type ParsedVersion = { core: number[]; pre?: string } | null;

function parseVersion(value: string): ParsedVersion {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(value.trim());
  return match
    ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] }
    : null;
}

function compareParsed(left: ParsedVersion, right: ParsedVersion): number | null {
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, undefined, { numeric: true });
}

/** Semver-ish ordering; `null` when either side does not parse, so no update is claimed. */
export function compareVersions(a: string, b: string): number | null {
  return compareParsed(parseVersion(a), parseVersion(b));
}

/** Newest first; versions that do not parse keep their relative order. */
export function sortVersions<T extends { version: string }>(versions: T[]): T[] {
  return versions
    .map((entry) => ({ entry, parsed: parseVersion(entry.version) }))
    .sort((a, b) => compareParsed(b.parsed, a.parsed) ?? 0)
    .map(({ entry }) => entry);
}

/** `candidate` when it is semver-newer than `installed`; never claimed when either is missing. */
export function newerVersion(candidate?: string, installed?: string | null): string | undefined {
  if (!candidate || !installed) return undefined;
  return (compareVersions(candidate, installed) ?? 0) > 0 ? candidate : undefined;
}

/** The oldest of `versions` by semver order (unparseable ones keep their place). */
export function lowestVersion(versions: string[]): string | undefined {
  return sortVersions(versions.map((version) => ({ version }))).at(-1)?.version;
}
