import type { ReactElement } from "react";
import { ShieldCheck } from "lucide-react";
import type { RemoteStatus } from "@/api/generated";
import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { CopyIconButton } from "./remote-ui";

/**
 * The addresses the workspace answers on, and the full fingerprint of the
 * self-signed certificate they serve (the pairing steps quote its start).
 */
export function RemoteLanSection({ status }: { status: RemoteStatus }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <section className="space-y-2">
      {status.lan_urls.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            "remote.lan.noAddress",
            "No local network address detected. Connect to Wi-Fi or use a tunnel.",
          )}
        </p>
      ) : (
        <ul className="space-y-1">
          {status.lan_urls.map((url) => (
            <li
              key={url}
              className="flex items-center justify-between gap-2 rounded border border-border bg-card px-2 py-1"
            >
              <code className="truncate font-mono text-xs">{url}</code>
              <CopyIconButton
                value={url}
                successLabel={<UiTrans i18nKey="remote.lan.urlCopied" defaults="URL copied" />}
              />
            </li>
          ))}
        </ul>
      )}

      {status.fingerprint ? (
        <div className="rounded border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <p className="flex items-start gap-1.5">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-green)]" aria-hidden />
            <span>
              {t(
                "remote.lan.fingerprintHint",
                "Phones on your network see this certificate. Its SHA-256 fingerprint, to compare with the one in the browser's warning details:",
              )}
            </span>
          </p>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <code className="truncate font-mono text-[11px] text-foreground">
              {status.fingerprint}
            </code>
            <CopyIconButton
              value={status.fingerprint}
              successLabel={
                <UiTrans i18nKey="remote.lan.fingerprintCopied" defaults="Fingerprint copied" />
              }
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
