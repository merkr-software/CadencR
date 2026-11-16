import { toast } from "sonner";
import { z } from "zod";

import { resolveApiBaseUrlSync } from "@/api/client";
import { pluginTabCreateGrant } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";

import { BrokerError, errorFromAxios, errorFromResponse } from "./broker-errors";

/** Header that carries a grant token on plugin requests (§4.3). */
export const PLUGIN_TOKEN_HEADER = "x-cadencr-plugin-token";

/** Re-mint a grant this close to its expiry instead of presenting it. */
const REFRESH_MARGIN_MS = 2 * 60_000;

const grantResponseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
  scopes: z.array(z.string()),
  api_version: z.number(),
});

export interface PluginGrant {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes: readonly string[];
  apiVersion: number;
}

export interface GrantDeps {
  mint: (pluginId: string, featureId: number) => Promise<unknown>;
  revoke: (token: string) => Promise<void>;
  /** A revocation failed: the tab may already be closed, so this goes app-wide. */
  reportRevokeFailure: (error: unknown) => void;
  now: () => number;
}

const defaultGrantDeps: GrantDeps = {
  mint: (pluginId, featureId) => pluginTabCreateGrant(pluginId, { feature_id: featureId }),
  revoke: async (token) => {
    const response = await fetch(`${resolveApiBaseUrlSync()}/api/plugin-tabs/grants/current`, {
      method: "DELETE",
      headers: { [PLUGIN_TOKEN_HEADER]: token },
    });
    if (!response.ok && response.status !== 401) throw await errorFromResponse(response);
  },
  reportRevokeFailure: (error) =>
    toast.error(
      `A closed custom tab's access could not be revoked (it expires on its own): ${apiErrorMessage(error, "unknown error")}`,
    ),
  now: () => Date.now(),
};

/**
 * The grant of one tab instance (§1): minted lazily on first use and re-minted
 * lazily — when a caller asks within ~2 minutes of its expiry, or after the
 * service rejected it. No timer: a hidden or idle tab mints nothing. The token
 * never leaves the renderer. `release` (guest gone) and `dispose` (tab closed)
 * revoke the live grant.
 */
export class GrantHolder {
  private current: Promise<PluginGrant> | null = null;
  /** `current`'s value once it settled (what `invalidate` compares against). */
  private settled: PluginGrant | null = null;
  private disposed = false;

  constructor(
    private readonly pluginId: string,
    private readonly featureId: number,
    private readonly deps: GrantDeps = defaultGrantDeps,
  ) {}

  get(): Promise<PluginGrant> {
    if (this.disposed) {
      return Promise.reject(new BrokerError("DISCONNECTED", "The custom tab was closed"));
    }
    // Expiring soon (or already, after the machine slept): replace it. The old
    // token stays valid until its expiry for whoever still holds it (an open
    // plugin socket), so it is not revoked.
    if (this.settled && this.settled.expiresAt - REFRESH_MARGIN_MS <= this.deps.now()) {
      this.forget();
    }
    this.current ??= this.mint();
    return this.current;
  }

  async token(): Promise<string> {
    return (await this.get()).token;
  }

  /**
   * The service rejected `staleToken`: forget it so the next `get` mints a new
   * grant. A no-op when the current grant is already another one — N requests
   * failing together with the same old token re-mint once, not N times.
   * Without a token (the service revoked every grant of the plugin, hot
   * reload) the current grant is forgotten unconditionally.
   */
  invalidate(staleToken?: string): void {
    if (staleToken !== undefined && this.settled?.token !== staleToken) return;
    this.forget();
  }

  /** The guest is gone (recycled, crashed): revoke now, mint again on next use. */
  release(): void {
    const current = this.current;
    this.forget();
    this.revoke(current);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
  }

  private forget(): void {
    this.current = null;
    this.settled = null;
  }

  private revoke(grant: Promise<PluginGrant> | null): void {
    void grant?.then(
      (value) => this.deps.revoke(value.token).catch(this.deps.reportRevokeFailure),
      // A grant that never minted has nothing to revoke; its failure already
      // reached whoever asked for it (`get`).
      () => undefined,
    );
  }

  private mint(): Promise<PluginGrant> {
    const pending: Promise<PluginGrant> = this.deps.mint(this.pluginId, this.featureId).then(
      (body) => {
        const parsed = grantResponseSchema.safeParse(body);
        const expiresAt = parsed.success ? Date.parse(parsed.data.expires_at) : Number.NaN;
        if (!parsed.success || !Number.isFinite(expiresAt)) {
          throw new BrokerError(
            "HOST_ERROR",
            "The service answered the grant with an unexpected shape",
          );
        }
        const grant: PluginGrant = {
          token: parsed.data.token,
          expiresAt,
          scopes: parsed.data.scopes,
          apiVersion: parsed.data.api_version,
        };
        if (this.current === pending) this.settled = grant;
        return grant;
      },
      (error: unknown) => {
        throw errorFromAxios(error);
      },
    );
    // A failed mint must not stick: the next request retries it.
    pending.catch(() => {
      if (this.current === pending) this.forget();
    });
    return pending;
  }
}
