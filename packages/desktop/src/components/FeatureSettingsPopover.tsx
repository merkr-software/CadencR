import type { ReactElement } from "react";
import { SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ModelSelector } from "./ModelSelector";

interface FeatureSettingsPopoverProps {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FeatureSettingsPopover({
  featureId,
  open,
  onOpenChange,
}: FeatureSettingsPopoverProps): ReactElement {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" title="Feature settings">
          <SettingsIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[820px] max-w-[calc(100vw-2rem)]" align="end">
        <ModelSelector level="feature" featureId={featureId} />
      </PopoverContent>
    </Popover>
  );
}
