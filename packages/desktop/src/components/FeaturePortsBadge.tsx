import { useUiTranslation } from "@/lib/i18n/ui";
import { useState, type ReactElement } from "react";
import { RadioTowerIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import type { AllocatedPort } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CopyButton } from "@/components/CopyButton";
import { FeatureMetaBadge } from "@/components/FeatureMetaBadge";
import { portSourceLabel, portUrl } from "@/lib/feature-ports";

interface FeaturePortsBadgeProps {
  ports: readonly AllocatedPort[];
  /** Open the port in this feature's browser pane, navigating to it first. */
  onOpenPort: (port: number) => void;
}

/**
 * A conversation's live listening ports. Servers started by an agent or typed
 * into a terminal are otherwise invisible from the sidebar, so this is the one
 * place that answers "what is this conversation currently serving?".
 */
export function FeaturePortsBadge({
  ports,
  onOpenPort,
}: FeaturePortsBadgeProps): ReactElement | null {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  if (ports.length === 0) return null;
  const label = t("sidebar.featurePortsBadge.portsInUse", "Ports {{ports}} in use", {
    count: ports.length,
    ports: ports.map((port) => port.port).join(", "),
    defaultValue_one: "Port {{ports}} in use",
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-feature-ports-badge
          className="shrink-0 rounded outline-none focus-visible:ring-1 focus-visible:ring-ring"
          // The row navigates on pointer-down, before click would ever fire.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
        >
          <FeatureMetaBadge
            icon={<RadioTowerIcon className="size-3" />}
            className="text-[var(--acc-green)]"
          >
            <span>:{ports[0].port}</span>
            {ports.length > 1 && <span className="opacity-70">+{ports.length - 1}</span>}
          </FeatureMetaBadge>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-1"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          {t(
            "sidebar.featurePortsBadge.listeningPortsForThisConversation",
            "Listening ports for this conversation",
          )}
        </p>
        {ports.map((port) => (
          <PortRow
            key={`${port.pid}-${port.port}`}
            port={port}
            onOpen={() => {
              setOpen(false);
              onOpenPort(port.port);
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function PortRow({ port, onOpen }: { port: AllocatedPort; onOpen: () => void }): ReactElement {
  const { t } = useUiTranslation();
  const url = portUrl(port.port);
  return (
    <div className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent">
      <span className="font-mono text-xs text-[var(--acc-green)]">:{port.port}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {port.process} · {portSourceLabel(port)}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="size-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
        aria-label={t("sidebar.featurePortsBadge.openUrl", "Open {{url}}", { url })}
        title={t("sidebar.featurePortsBadge.openUrl", "Open {{url}}", { url })}
        onClick={onOpen}
      >
        <SquareArrowOutUpRightIcon className="size-3.5" />
      </Button>
      <CopyButton
        text={url}
        label={t("sidebar.featurePortsBadge.copyUrl", "Copy {{url}}", { url })}
        iconClassName="size-3.5"
        className="size-6"
      />
    </div>
  );
}
