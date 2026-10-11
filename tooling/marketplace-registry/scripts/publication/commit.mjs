export function isExactCommit(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}
