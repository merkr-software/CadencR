import { Link } from "@tanstack/react-router";
import { Ban, ShieldCheck } from "lucide-react";
import { listingKey } from "@/lib/marketplace-listing-base";
import type { PluginMember } from "@/lib/marketplace-plugin-listings";
import { cn } from "@/lib/utils";
import { KINDS } from "./kinds";
import { KindChips, PluginMark, PluginStateBadge } from "./PluginBits";
import { KindTrust, Section } from "./PluginDetailSections";
import { KindAction } from "./PluginInstallPanel";

/** Where one member stands against the release on screen. */
function MemberState({
  member,
  version,
}: {
  member: PluginMember;
  version: string;
}): React.JSX.Element {
  const listing = member.listing;
  const installed = listing?.installed?.version;
  if (!listing)
    return <span className="text-[11px] text-muted-foreground">Not in the loaded catalog</span>;
  if (!listing.installed)
    return <span className="text-[11px] text-muted-foreground">Not installed</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <PluginStateBadge listing={listing} />
      {installed !== version && (
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {installed ?? "No revision"} → {version}
        </span>
      )}
    </span>
  );
}

function MemberRow({
  member,
  version,
}: {
  member: PluginMember;
  version: string;
}): React.JSX.Element {
  const meta = KINDS[member.ref.kind];
  const listing = member.listing;
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-3 py-2.5 last:border-b-0",
        meta.tone,
      )}
    >
      {listing ? (
        <PluginMark listing={listing} size={32} />
      ) : (
        <span aria-hidden="true" className="mp-mark" style={{ width: 32, height: 32 }} />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <Link
          to="/marketplace/$kind/$id"
          params={{ kind: member.ref.kind, id: member.ref.id }}
          className="block truncate text-[13px] font-semibold hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {listing?.name ?? member.ref.id}
        </Link>
        <span className="flex flex-wrap items-center gap-2">
          <KindChips kinds={[member.ref.kind]} />
          <MemberState member={member} version={version} />
        </span>
      </div>
      {listing?.installed && (
        <div className="flex flex-wrap items-center gap-2">
          <KindAction listing={listing} />
        </div>
      )}
    </li>
  );
}

/** What one release adds, member by member, each with its own state and page. */
export function IncludesSection({
  members,
  version,
  unknownKinds = [],
}: {
  members: PluginMember[];
  version: string;
  unknownKinds?: string[];
}): React.JSX.Element {
  return (
    <Section title={`Includes · ${members.length + unknownKinds.length}`}>
      <ul className="overflow-hidden rounded-lg border border-border/80">
        {members.map((member) => (
          <MemberRow
            key={listingKey(member.ref.kind, member.ref.id)}
            member={member}
            version={version}
          />
        ))}
        {unknownKinds.map((kind) => (
          <li
            key={kind}
            className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5 text-[12px] text-[var(--acc-orange)] last:border-b-0"
          >
            <Ban aria-hidden="true" className="size-3.5 shrink-0" />
            <span>
              A <span className="font-mono">{kind}</span> contribution — needs a newer Cadencr
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** One plugin installs several components: say how many, and what each one runs. */
export function PluginTrustSection({
  members,
  version,
}: {
  members: PluginMember[];
  version: string;
}): React.JSX.Element {
  const count = members.length;
  return (
    <Section title="Trust & safety">
      <div className="space-y-2 rounded-lg border border-border/80 bg-card p-3 text-xs text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <ShieldCheck aria-hidden="true" className="size-3.5 text-primary" />
          Signed catalog, verified archives
        </p>
        <p>
          This plugin installs {count} component{count === 1 ? "" : "s"}. Each is verified and
          installed on its own, and can be removed on its own from its page.
        </p>
        {members.map((member) => (
          <div
            key={listingKey(member.ref.kind, member.ref.id)}
            className="space-y-1.5 border-t border-border/60 pt-2"
          >
            <p className="font-medium text-foreground">
              {member.listing?.name ?? member.ref.id} · {KINDS[member.ref.kind].label}
            </p>
            {member.listing ? (
              <KindTrust listing={member.listing} version={version} />
            ) : (
              <p>Not in the loaded catalog, so Cadencr cannot describe it yet.</p>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
