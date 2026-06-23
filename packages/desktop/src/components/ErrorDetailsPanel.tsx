import { CopyIcon } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

interface ErrorDetailsPanelProps {
  details: string;
}

export function ErrorDetailsPanel({ details }: ErrorDetailsPanelProps): ReactElement {
  return (
    <>
      <pre className="max-h-64 w-full max-w-lg overflow-auto rounded border bg-muted/40 p-2 text-xs text-foreground/80 whitespace-pre-wrap">
        {details}
      </pre>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copyToClipboard(details, "Error details copied")}
        >
          <CopyIcon className="size-4" />
          Copy error details
        </Button>
      </div>
    </>
  );
}
