import path from "node:path";
import { withOwnedTemporaryDirectory } from "./files.mjs";

export function validateReleaseAssets(list, expected, { requireComplete = false } = {}) {
  if (!Array.isArray(list)) throw new Error("release asset listing is invalid");
  const allowed = new Set(expected.map(({ name }) => name));
  const assets = new Map();
  for (const asset of list) {
    if (!asset || typeof asset.name !== "string" || !allowed.has(asset.name)) {
      throw new Error("release contains an unexpected asset");
    }
    if (assets.has(asset.name)) throw new Error(`duplicate release asset: ${asset.name}`);
    if (asset.state !== "uploaded") {
      throw new Error(`release asset is not uploaded: ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }
  if (requireComplete && assets.size !== expected.length) {
    throw new Error("release is missing expected assets");
  }
  return assets;
}

export async function verifyRemoteArtifacts(client, assets, expected, directory) {
  for (const artifact of expected) {
    const asset = assets.get(artifact.name);
    if (asset) await verifyRemoteArtifact(client, asset, artifact, directory);
  }
}

export async function verifyRemoteArtifact(client, asset, artifact, directory) {
  return withOwnedTemporaryDirectory(directory, ".mirror-verify-", async (temporary) =>
    client.verifyAsset({
      asset,
      expectedUrl: artifact.expectedUrl,
      sha256: artifact.sha256,
      size: artifact.size,
      outputPath: path.join(temporary, "asset"),
    }),
  );
}
