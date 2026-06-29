import { memo, type ReactElement, type ReactNode } from "react";
import type { Project } from "@/api/generated";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { quoteFilterValue } from "@/components/UnifiedAgentsFilterLanguage";

interface UnifiedAgentsFilterHelpDialogProps {
  projects: Project[];
  children: ReactNode;
}

export const UnifiedAgentsFilterHelpDialog = memo(function UnifiedAgentsFilterHelpDialog({
  projects,
  children,
}: UnifiedAgentsFilterHelpDialogProps): ReactElement {
  const examples = buildExamples(projects);
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agent filter language</DialogTitle>
          <DialogDescription>
            Type plain text to filter agent names. Add advanced filters with
            <code>/key:value</code>. Quote values that contain spaces.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 text-sm">
          <section className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Available keys
            </h3>
            <div className="overflow-hidden rounded-lg border border-border/80">
              <HelpRow code="/last:5" detail="Agents active in the last 5 minutes." />
              <HelpRow code="/last:all" detail="All agents." />
              <HelpRow
                code='/project:"My Project"'
                detail="Filter by project. Use | for multiple projects."
              />
              <HelpRow
                code="/exclude:auth|docs"
                detail="Hide agents whose name contains any of these. Use | for multiple."
              />
              <HelpRow code="/pin:true" detail="Show only pinned agents." />
              <HelpRow code="/sort:created" detail="Newest created agent first." />
              <HelpRow code="/sort:-created" detail="Oldest created agent first." />
              <HelpRow code="/sort:message" detail="Newest message first." />
              <HelpRow code="/sort:-message" detail="Oldest message first." />
            </div>
          </section>

          <section className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Examples with your projects
            </h3>
            <div className="grid gap-2">
              {examples.map((example: string) => (
                <code
                  key={example}
                  className="rounded-md border border-border/70 bg-muted/45 px-3 py-2 font-mono text-xs text-foreground"
                >
                  {example}
                </code>
              ))}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
});

function HelpRow({ code, detail }: { code: string; detail: string }): ReactElement {
  return (
    <div className="grid grid-cols-[minmax(130px,0.6fr)_1fr] gap-3 border-b border-border/60 px-3 py-2 last:border-b-0">
      <code className="font-mono text-xs text-foreground">{code}</code>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function buildExamples(projects: Project[]): string[] {
  const firstProject = projects[0]?.name ?? "My Project";
  const secondProject = projects[1]?.name ?? "Another Project";
  return [
    `/last:5 /sort:created /project:${quoteFilterValue(firstProject)}`,
    `auth bug /last:60 /sort:message /project:${quoteFilterValue(firstProject)}`,
    `/last:all /sort:-created /project:${quoteFilterValue(firstProject)}|${quoteFilterValue(secondProject)}`,
  ];
}
