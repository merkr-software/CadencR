import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The installed package directory, walking up from `from` like Node does
 *  (ignoring `exports`, so non-exported files such as LICENSE are reachable). */
export function packageDir(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`Cannot find installed package ${name}`);
  }
}
