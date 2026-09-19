import { readBoundedRegularFile } from "./io.mjs";

export function parseNamedArguments(args, flags) {
  const allowed = new Set(flags);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--")) {
      throw new Error(`invalid argument ${JSON.stringify(flag ?? "")}`);
    }
    const key = flag.slice(2);
    if (options[key] !== undefined) throw new Error(`duplicate argument ${flag}`);
    options[key] = value;
  }
  for (const flag of allowed) {
    if (options[flag.slice(2)] === undefined) throw new Error(`missing required argument ${flag}`);
  }
  return options;
}

export async function readSubmission(file) {
  const bytes = await readBoundedRegularFile(file, 1024 * 1024, "submission");
  return JSON.parse(bytes.toString("utf8"));
}
