# Official marketplace trust material

Public halves only; no private key is ever committed. Custody and rotation follow
the [key custody runbook](../MARKETPLACE_RELEASE_CONFIG.md#key-custody-runbook).

| Item                       | Value                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| Offline root key id        | `cadencr-root-1`                                                           |
| Root public key (base64)   | `qUXWCxcpNirGB4FE6xSo9azWv3RR2Fu+szGlS39074Q=`                             |
| Online signing key id      | `cadencr-registry-1`                                                       |
| Online public key (base64) | `Ox20iUMpTdJ0sUYaZ9ydino9SAXS4hf2NKddLZy1FeQ=`                             |
| Trust generation           | `1` ([payload](trust-gen1-payload.json), [signed](signed-trust-gen1.json)) |

Generated on 2026-10-25 with `scripts/marketplace-keys.sh`. The root private key is
held offline by the release owner; the online private key exists only as the
`CADENCR_REGISTRY_PRIVATE_KEY_PEM` secret of the registry's
`protected-marketplace-publisher` and `protected-marketplace-renewal` environments.
The same public values are configured as `merkr-software/cadencr-registry`
repository variables (`CADENCR_REGISTRY_KEY_ID`, `CADENCR_REGISTRY_PUBLIC_KEY_PEM`,
`CADENCR_REGISTRY_ROOT_KEY_ID`, `CADENCR_REGISTRY_ROOT_PUBLIC_KEY_PEM`,
`CADENCR_REGISTRY_TRUST_MANIFEST_JSON`, `CADENCR_REGISTRY_TRUST_MIN_GENERATION`).

Verify the signed generation with the CLI:

```sh
cadencr registry verify-trust-manifest --manifest docs/marketplace-trust/signed-trust-gen1.json \
  --root-public-key docs/marketplace-trust/root-public.pem --root-key-id cadencr-root-1 \
  --minimum-generation 1
```
