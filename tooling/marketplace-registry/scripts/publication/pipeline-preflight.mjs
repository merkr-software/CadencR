import { createPublicKey } from "node:crypto";
import { comparePackages } from "../lib.mjs";
import { validateCatalogContinuity, validateCatalogIdentities } from "./snapshot.mjs";
import { validateSigningPayload, verifyIndexEnvelope } from "./signing.mjs";

export function preflightCatalog(options, prepared, staged) {
  const payload = {
    schema_version: 1,
    generated_at: prepared.request.generated_at,
    expires_at: prepared.request.expires_at,
    packages: staged.map(({ plan }) => plan.mirrored_package).sort(comparePackages),
  };
  validateSigningPayload(payload, { now: options.now ?? new Date() });
  validateCatalogIdentities(payload.packages);
  if (!prepared.previous) return;
  let baseline;
  try {
    baseline = JSON.parse(prepared.previous.bytes.toString("utf8"));
  } catch {
    throw new Error("previous index must be valid JSON");
  }
  verifyIndexEnvelope(baseline, {
    publicKey: createPublicKey(prepared.publicKey.bytes),
    keyId: prepared.request.key_id,
    now: options.now ?? new Date(),
    allowExpired: true,
  });
  validateCatalogContinuity(baseline.signed, payload);
}
