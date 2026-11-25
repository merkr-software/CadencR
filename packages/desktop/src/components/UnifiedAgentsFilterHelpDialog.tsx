import { UiTrans, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
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
  const { t } = useUiTranslation();
  const examples = buildExamples(projects, t);
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("agents.unifiedAgentsFilterHelpDialog.agentFilterLanguage", "Agent filter language")}
          </DialogTitle>
          <DialogDescription>
            <UiTrans
              i18nKey="agents.filter.help.description"
              defaults="An empty filter shows every agent, the ones that need you first. Type plain text to filter by name, and add <syntax/> filters to narrow further. Quote values that contain spaces."
              components={{ syntax: <code>/key:value</code> }}
            />
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 text-sm">
          <section className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t("agents.unifiedAgentsFilterHelpDialog.availableKeys", "Available keys")}
            </h3>
            <HelpRows />
          </section>

          <section className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t(
                "agents.unifiedAgentsFilterHelpDialog.examplesWithYourProjects",
                "Examples with your projects",
              )}
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

function HelpRows(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="overflow-hidden rounded-lg border border-border/80">
      <HelpRow
        code="/last:5"
        detail={t(
          "agents.filter.help.recent",
          "Only agents active in the last 5 minutes (plus pinned and busy ones).",
        )}
      />
      <HelpRow code="/last:all" detail={t("agents.filter.help.all", "Every agent. The default.")} />
      <HelpRow
        code={`/project:${quoteFilterValue(t("agents.filter.help.exampleProject", "My Project"))}`}
        detail={t(
          "agents.filter.help.project",
          "Filter by project. Use {{separator}} for multiple projects.",
          { separator: "|" },
        )}
      />
      <HelpRow
        code="/exclude:auth|docs"
        detail={t(
          "agents.filter.help.exclude",
          "Hide agents whose name contains any of these. Use {{separator}} for multiple.",
          { separator: "|" },
        )}
      />
      <HelpRow code="/pin:true" detail={t("agents.filter.help.pin", "Show only pinned agents.")} />
      <HelpRow
        code="/sort:attention"
        detail={t(
          "agents.filter.help.attention",
          "Waiting on you, failed, working, unread, then the rest. The default.",
        )}
      />
      <HelpRow
        code="/sort:created"
        detail={t("agents.filter.help.created", "Newest created agent first.")}
      />
      <HelpRow
        code="/sort:-created"
        detail={t("agents.filter.help.createdAscending", "Oldest created agent first.")}
      />
      <HelpRow
        code="/sort:message"
        detail={t("agents.filter.help.message", "Newest message first.")}
      />
      <HelpRow
        code="/sort:-message"
        detail={t("agents.filter.help.messageAscending", "Oldest message first.")}
      />
    </div>
  );
}

function HelpRow({ code, detail }: { code: string; detail: string }): ReactElement {
  return (
    <div className="grid grid-cols-[minmax(130px,0.6fr)_1fr] gap-3 border-b border-border/60 px-3 py-2 last:border-b-0">
      <code className="font-mono text-xs text-foreground">{code}</code>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function buildExamples(projects: Project[], t: UiTranslator): string[] {
  const firstProject = projects[0]?.name ?? t("agents.filter.help.exampleProject", "My Project");
  const secondProject =
    projects[1]?.name ?? t("agents.filter.help.anotherExampleProject", "Another Project");
  const query = t("agents.filter.help.exampleQuery", "auth bug");
  return [
    `/last:5 /sort:created /project:${quoteFilterValue(firstProject)}`,
    `${query} /last:60 /sort:message /project:${quoteFilterValue(firstProject)}`,
    `/last:all /sort:-created /project:${quoteFilterValue(firstProject)}|${quoteFilterValue(secondProject)}`,
  ];
}
