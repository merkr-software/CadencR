import { BotIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { useCatalogProviderMetadata } from "@/hooks/useCatalogProviderMetadata";
import { getProviderMetadata, type ProviderIconVariant, type ProviderMetadata } from "./providers";
import { cn } from "./utils";

export function useProviderMetadata(
  providerId?: string | null,
  catalogLabel?: string | null,
  variant: ProviderIconVariant = "color",
) {
  const catalogMetadata = useCatalogProviderMetadata(providerId);
  return useMemo(
    () => getProviderMetadata(providerId, catalogLabel, variant, catalogMetadata),
    [catalogLabel, catalogMetadata, providerId, variant],
  );
}

interface ProviderIconProps {
  providerId?: string | null;
  alt: string;
  className?: string;
  /** Color logos for pickers; mono silhouettes for compact chrome. */
  variant?: ProviderIconVariant;
}

export const ProviderIcon = memo(function ProviderIcon({
  providerId,
  alt,
  className = "size-4 rounded-sm",
  variant = "color",
}: ProviderIconProps) {
  const metadata = useProviderMetadata(providerId, null, variant);
  return (
    <ProviderIconGraphic
      providerId={providerId}
      metadata={metadata}
      alt={alt}
      className={className}
    />
  );
});

export function ProviderIconGraphic({
  providerId,
  metadata,
  alt,
  className = "size-4 rounded-sm",
}: Omit<ProviderIconProps, "variant"> & {
  metadata: ProviderMetadata | null;
}): React.JSX.Element | null {
  if (!metadata?.iconSrc) {
    return providerId ? (
      <BotIcon role="img" aria-label={alt} className={cn(className, "text-muted-foreground")} />
    ) : null;
  }
  return (
    <img
      src={metadata.iconSrc}
      alt={alt}
      className={cn(
        className,
        // Mono assets are black-on-transparent. Invert for Cadencr dark themes
        // via `data-appearance` (not Tailwind `dark:`, which tracks OS preference).
        metadata.isMonochrome && "provider-icon-mono opacity-80",
      )}
    />
  );
}
