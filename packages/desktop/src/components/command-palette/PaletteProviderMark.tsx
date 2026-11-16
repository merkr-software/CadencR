import type { ReactElement } from "react";
import { ProviderMonoMark } from "@/components/SidebarProviderBadge";
import { useProviderMetadata } from "@/lib/provider-icons";

/** The provider's quiet mono mark and its name, as the sidebar draws it. */
export function PaletteProviderMark({ providerId }: { providerId: string }): ReactElement {
  const meta = useProviderMetadata(providerId, null, "mono");
  return (
    <>
      <ProviderMonoMark
        iconSrc={meta?.iconSrc}
        scale={meta?.monoIconScale}
        className="shrink-0 text-muted-foreground"
      />
      <span>{meta?.label ?? providerId}</span>
    </>
  );
}
