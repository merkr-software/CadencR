const { readdirSync } = require("node:fs");
const { join } = require("node:path");

function assertRendererHasNoSourceMaps(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) assertRendererHasNoSourceMaps(file);
    else if (entry.name.endsWith(".map"))
      throw new Error(`Source map leaked into packaged renderer: ${file}`);
  }
}

module.exports = { assertRendererHasNoSourceMaps };
