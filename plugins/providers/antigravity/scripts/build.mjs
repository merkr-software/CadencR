import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConnector } from "../../../../scripts/native-provider-build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await buildConnector(root);
console.log(`Built ${resolve(root, "bin/provider")}`);
