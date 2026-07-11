import { CheckSquareIcon, CircleHelpIcon, ListChecksIcon, SquareTerminalIcon } from "lucide-react";
import { memo, useMemo, type ReactElement } from "react";
import { parseAskUserQuestions } from "@/components/agent-question/parse-questions";
import { getPermissionPreview } from "@/components/permission-preview";
import type { SessionGateEnvelope, SessionGateKind } from "@/lib/session-gate";
import { parsePermissionPayload } from "@/stores/ws-envelope-payload";

interface SessionGateDetailsProps {
  gate: SessionGateEnvelope;
}

export const SessionGateDetails = memo(function SessionGateDetails({
  gate,
}: SessionGateDetailsProps): ReactElement {
  const permission = useMemo(() => parsePermissionPayload(gate.payload), [gate.payload]);
  if (!permission) return <GateFallback kind={gate.kind} />;
  if (gate.kind === "question") {
    return <QuestionDetails toolInput={permission.tool_input} />;
  }
  if (gate.kind === "plan") {
    return (
      <PlanDetails
        description={permission.description}
        preview={planPreview(permission.tool_input, permission.preview)}
      />
    );
  }
  return (
    <PermissionDetails
      toolName={permission.tool_name}
      description={permission.description}
      pattern={permission.pattern}
      preview={getPermissionPreview({
        preview: permission.preview,
        input: permission.tool_input,
        fallbackToJson: false,
      })}
    />
  );
});

interface QuestionDetailsProps {
  toolInput: Record<string, unknown>;
}

const QuestionDetails = memo(function QuestionDetails({
  toolInput,
}: QuestionDetailsProps): ReactElement {
  const questions = useMemo(() => parseAskUserQuestions(toolInput), [toolInput]);
  if (questions.length === 0) return <GateFallback kind="question" />;
  return (
    <div className="flex flex-col gap-2.5">
      {questions.map((question, questionIndex) => (
        <section key={`${question.question}-${questionIndex}`} className="flex flex-col gap-1.5">
          <div className="flex items-start gap-2">
            <CircleHelpIcon
              className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-300"
              aria-hidden="true"
            />
            <p className="text-[13px] font-medium leading-5 text-foreground">{question.question}</p>
            {question.multiSelect && (
              <span className="mt-0.5 shrink-0 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                Select multiple
              </span>
            )}
          </div>
          <div className="grid gap-1 pl-5 sm:grid-cols-2">
            {question.options && question.options.length > 0 ? (
              question.options.map((option, optionIndex) => (
                <div
                  key={`${option.label}-${optionIndex}`}
                  className="flex min-w-0 items-start gap-2 rounded-md border border-border/70 bg-background/55 px-2 py-1.5"
                >
                  <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded border border-border bg-muted/60 font-mono text-[9px] text-muted-foreground">
                    {optionIndex + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium leading-4 text-foreground">
                      {option.label}
                    </span>
                    {(option.description ?? option.preview) && (
                      <span className="block text-[10px] leading-4 text-muted-foreground">
                        {option.description ?? option.preview}
                      </span>
                    )}
                  </span>
                </div>
              ))
            ) : (
              <span className="text-[10px] italic text-muted-foreground">Free-text response</span>
            )}
          </div>
        </section>
      ))}
    </div>
  );
});

interface PermissionDetailsProps {
  toolName?: string;
  description?: string;
  pattern?: string;
  preview: string | null;
}

const PermissionDetails = memo(function PermissionDetails({
  toolName,
  description,
  pattern,
  preview,
}: PermissionDetailsProps): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <SquareTerminalIcon
          className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-300"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] font-semibold text-foreground">
              {toolName ?? "Tool permission"}
            </span>
            {pattern && (
              <span className="max-w-full truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                {pattern}
              </span>
            )}
          </div>
          {description && (
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {preview ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/70 bg-background/70 px-2.5 py-2 font-mono text-[11px] leading-4 text-foreground">
          {preview}
        </pre>
      ) : (
        <p className="pl-5 text-[10px] italic text-muted-foreground">No command preview provided</p>
      )}
    </div>
  );
});

interface PlanDetailsProps {
  description?: string;
  preview: string | null;
}

const PlanDetails = memo(function PlanDetails({
  description,
  preview,
}: PlanDetailsProps): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <ListChecksIcon
          className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-300"
          aria-hidden="true"
        />
        <p className="text-[11px] leading-4 text-muted-foreground">
          {description ?? "The child is waiting for plan approval."}
        </p>
      </div>
      {preview && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border/70 bg-background/70 px-2.5 py-2 text-[11px] leading-4 text-foreground">
          {preview}
        </pre>
      )}
    </div>
  );
});

function GateFallback({ kind }: { kind: SessionGateKind }): ReactElement {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <CheckSquareIcon className="size-3.5" aria-hidden="true" />
      <span>The child is waiting for a {kind} response.</span>
    </div>
  );
}

function planPreview(input: Record<string, unknown>, preview?: string): string | null {
  if (preview?.trim()) return preview;
  const plan = input.plan;
  if (typeof plan === "string" && plan.trim()) return plan;
  const content = input.content;
  return typeof content === "string" && content.trim() ? content : null;
}
