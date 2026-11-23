import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConnector as build } from "../../../../scripts/native-provider-build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export const buildConnector = (options) => build(root, options);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildConnector();
  console.log(`Built ${resolve(root, "bin/provider")}`);
}
