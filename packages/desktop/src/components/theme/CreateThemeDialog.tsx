import { useCallback, useId, useState, type FormEvent, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDialogSubmitShortcut } from "@/components/git-actions/useDialogSubmitShortcut";
import { THEME_LIST, type ThemeDefinition } from "@/lib/themes";
import { ThemeCard } from "./ThemeCard";

/** Matches `MAX_LABEL_LEN` in the backend's theme validator, which 400s past it. */
const MAX_LABEL_LENGTH = 64;

const ARROW_STEPS: Record<string, number | undefined> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Name a new theme, and pick what it starts from.
 *
 * A theme is 100-odd tokens that have to agree with each other, so there is no
 * "blank" option: every new theme is a copy of one that already renders. The
 * user's own themes are offered alongside the built-ins — iterating on your own
 * work is at least as common as starting from a shipped palette.
 *
 * The name is asked for here rather than derived from the base, because a
 * generated one is not a placeholder the user can ignore: it names the project
 * in the sidebar, the folder on disk and the entry in every theme selector, and
 * changing it afterwards means editing the file. One field now is cheaper than
 * living with “Dracula (copy)”.
 */
export function CreateThemeDialog({
  userThemes,
  isCreating,
  onCreate,
  onClose,
}: {
  userThemes: ThemeDefinition[];
  isCreating: boolean;
  onCreate: (base: ThemeDefinition, label: string) => void;
  onClose: () => void;
}): ReactElement {
  const themes = [...THEME_LIST, ...userThemes];
  const nameId = useId();
  // The id rather than the definition: the list gets a new identity whenever a
  // theme file changes, and a held object would be copied from a stale one.
  const [baseId, setBaseId] = useState<string | null>(null);
  const [name, setName] = useState("");

  const base = themes.find((theme) => theme.id === baseId) ?? null;
  const label = name.trim();
  const incomplete = base === null || label.length === 0;

  const create = useCallback((): void => {
    // `base` is re-derived above, so this both guards and narrows it.
    if (!base || incomplete || isCreating) return;
    onCreate(base, label);
  }, [base, incomplete, isCreating, label, onCreate]);

  // ⌘/Ctrl+Enter submits, as it does in every other dialog; plain Enter works
  // too, from the one field this form has.
  useDialogSubmitShortcut({ open: true, enabled: !incomplete && !isCreating, onSubmit: create });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    create();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[min(80vh,var(--dialog-max-h))] gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">Create theme</DialogTitle>
          <DialogDescription>
            Name your theme and pick the one to start from. You get a complete copy of its colors in
            a project of its own, and the app puts it on so you can see your changes. The original
            is untouched.
          </DialogDescription>
        </DialogHeader>
        <ThemeBaseGrid
          themes={themes}
          selectedId={baseId}
          disabled={isCreating}
          onSelect={setBaseId}
        />
        <form onSubmit={submit} className="space-y-2 border-t border-border px-6 py-4">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <label htmlFor={nameId} className="text-xs font-medium">
                Name
              </label>
              <Input
                id={nameId}
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Midnight Ember"
                maxLength={MAX_LABEL_LENGTH}
                disabled={isCreating}
              />
            </div>
            <Button type="submit" disabled={incomplete || isCreating}>
              {isCreating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
              {isCreating ? "Creating…" : "Create theme"}
            </Button>
          </div>
          {/* Announced: submitting disables the field the user was in, so the
              only remaining signal is this line. */}
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {isCreating
              ? "Copying the colors and opening its project…"
              : base
                ? `Starting from ${base.label}.`
                : "Pick a theme above to start from."}
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The themes to start from, as a radiogroup: arrows move the choice and the
 * focus together, and only the chosen card is a tab stop — otherwise reaching
 * the name field past 15-odd themes would be a chore.
 */
function ThemeBaseGrid({
  themes,
  selectedId,
  disabled,
  onSelect,
}: {
  themes: ThemeDefinition[];
  selectedId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = ARROW_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-theme-card]")];
    const from = cards.findIndex((card) => card === document.activeElement);
    const next = cards[(Math.max(from, 0) + step + cards.length) % cards.length];
    next?.focus();
    next?.click();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme to start from"
      onKeyDown={onKeyDown}
      className="grid max-h-[calc(var(--app-vh)*0.6)] grid-cols-2 gap-2 overflow-y-auto p-4 sm:grid-cols-4"
    >
      {themes.map((theme, index) => (
        <ThemeCard
          key={theme.id}
          theme={theme}
          selected={theme.id === selectedId}
          disabled={disabled}
          tabIndex={theme.id === selectedId || (selectedId === null && index === 0) ? 0 : -1}
          onSelect={() => onSelect(theme.id)}
          className="p-2"
        />
      ))}
    </div>
  );
}
