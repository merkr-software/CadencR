import type { ComponentProps } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";

import { cn } from "@/lib/utils";

const ghostButton =
  "inline-flex items-center justify-center rounded-md text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export type CalendarProps = ComponentProps<typeof DayPicker>;

/**
 * Month calendar built on react-day-picker, themed with our design tokens so it
 * matches the rest of the app (the native `datetime-local` popup did not). Used
 * by `DateTimePicker`.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "relative flex flex-col gap-4",
        month: "flex flex-col gap-4",
        month_caption: "flex h-7 items-center justify-center",
        caption_label: "text-sm font-medium",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between",
        button_previous: cn(ghostButton, "size-7 text-muted-foreground hover:text-foreground"),
        button_next: cn(ghostButton, "size-7 text-muted-foreground hover:text-foreground"),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-8 text-[0.7rem] font-normal text-muted-foreground",
        week: "mt-1 flex w-full",
        day: "size-8 p-0 text-center",
        day_button: cn(ghostButton, "size-8 font-normal"),
        today: "[&>button]:rounded-md [&>button]:bg-accent [&>button]:text-accent-foreground",
        selected:
          "[&>button]:rounded-md [&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground",
        outside: "[&>button]:text-muted-foreground/40",
        disabled:
          "[&>button]:pointer-events-none [&>button]:text-muted-foreground/30 [&>button]:opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          ),
      }}
      {...props}
    />
  );
}
