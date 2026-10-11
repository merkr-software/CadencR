import { incrementalPayload, verifyBaseline } from "./incremental.mjs";

export function preflightCatalog(options, prepared, staged) {
  const now = options.now ?? new Date();
  const baseline = prepared.previous
    ? verifyBaseline(
        prepared.previous.bytes,
        prepared.publicKey.bytes,
        prepared.request.key_id,
        now,
      )
    : null;
  incrementalPayload({
    packages: staged.map(({ plan }) => plan.mirrored_package),
    baseline,
    generatedAt: prepared.request.generated_at,
    expiresAt: prepared.request.expires_at,
    now,
  });
  return new Set(
    (baseline?.packages ?? []).map((entry) => `${entry.agent.id}@${entry.agent.version}`),
  );
}
