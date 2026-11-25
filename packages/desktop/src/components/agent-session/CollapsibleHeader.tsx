import { useUiTranslation } from "@/lib/i18n/ui";
import { createElement, type RefObject } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChevronRightIcon,
  CheckCircleIcon,
  RotateCcwIcon,
  Trash2Icon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react";
import { SlidingText } from "@/components/SlidingText";

export interface BadgeConfig {
  label: React.ReactNode;
  className: string;
  icon?: React.ReactNode;
}

export interface CollapsibleHeaderProps {
  headerRef: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  isOpen: boolean;
  IconComponent: React.ComponentType<{ className?: string }>;
  badge: BadgeConfig;
  displayLabel: string;
  navAgentIndex?: number;
  onMarkDone?: () => void;
  resumable?: boolean;
  onResume?: () => void;
  canDelete?: boolean;
  onDelete?: () => void;
  maximized?: boolean;
  onToggleMaximize?: () => void;
}

function HeaderActions({
  isOpen,
  onMarkDone,
  resumable,
  onResume,
  canDelete,
  onDelete,
  maximized,
  onToggleMaximize,
}: Pick<
  CollapsibleHeaderProps,
  | "isOpen"
  | "onMarkDone"
  | "resumable"
  | "onResume"
  | "canDelete"
  | "onDelete"
  | "maximized"
  | "onToggleMaximize"
>): React.ReactNode {
  const { t } = useUiTranslation();
  return (
    <div className="ml-auto flex items-center gap-1">
      {onMarkDone && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-green-400"
          onClick={(event) => {
            event.stopPropagation();
            onMarkDone();
          }}
        >
          <CheckCircleIcon className="size-3" />
          {t("conversation.stream.collapsibleHeader.markDone", "Mark Done")}
        </Button>
      )}
      {resumable && onResume && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs"
          onClick={(event) => {
            event.stopPropagation();
            onResume();
          }}
        >
          <RotateCcwIcon className="size-3" />
          {t("conversation.stream.collapsibleHeader.resume", "Resume")}
        </Button>
      )}
      {canDelete && onDelete && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-red-400"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Trash2Icon className="size-3" />
          {t("conversation.stream.collapsibleHeader.remove", "Remove")}
        </Button>
      )}
      {isOpen && onToggleMaximize && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            onToggleMaximize();
          }}
          title={
            maximized
              ? t("conversation.stream.collapsibleHeader.minimize", "Minimize")
              : t("conversation.stream.collapsibleHeader.maximize", "Maximize")
          }
        >
          {maximized ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
        </Button>
      )}
    </div>
  );
}

export function CollapsibleHeader({
  headerRef,
  onToggle,
  isOpen,
  IconComponent,
  badge,
  displayLabel,
  navAgentIndex,
  onMarkDone,
  resumable,
  onResume,
  canDelete,
  onDelete,
  maximized,
  onToggleMaximize,
}: CollapsibleHeaderProps) {
  return (
    <div
      ref={headerRef}
      className="shrink-0 flex cursor-pointer items-center gap-2 px-3 py-2 outline-none hover:bg-muted/50"
      onClick={onToggle}
      data-nav-item
      {...(navAgentIndex != null ? { "data-nav-agent-index": navAgentIndex } : {})}
      tabIndex={-1}
    >
      <ChevronRightIcon
        className={cn(
          "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
          isOpen && "rotate-90",
        )}
      />
      {createElement(IconComponent, {
        className: "size-4 shrink-0 text-muted-foreground",
      })}
      <Badge variant="secondary" className={cn("shrink-0 gap-1 text-xs", badge.className)}>
        {badge.icon}
        {badge.label}
      </Badge>
      <SlidingText className="text-sm font-medium" text={displayLabel} />
      <HeaderActions
        isOpen={isOpen}
        onMarkDone={onMarkDone}
        resumable={resumable}
        onResume={onResume}
        canDelete={canDelete}
        onDelete={onDelete}
        maximized={maximized}
        onToggleMaximize={onToggleMaximize}
      />
    </div>
  );
}
