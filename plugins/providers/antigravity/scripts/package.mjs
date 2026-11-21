import { fileURLToPath } from "node:url";
import { packageConnector } from "../../../../scripts/native-provider-build.mjs";

await packageConnector(fileURLToPath(new URL("../", import.meta.url)));
