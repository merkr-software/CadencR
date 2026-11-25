import { useMemo } from "react";
import { defaultFilter } from "cmdk";
import { CheckIcon } from "lucide-react";
import { useUiTranslation } from "@/lib/i18n/ui";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
  CommandItem,
  useCommandState,
} from "@/components/ui/command";

const DEFAULT_OPTION_VALUE = "Default";

interface FontOptionsProps {
  fonts: string[];
  family: string | null;
  onSelect: (family: string) => void;
}

export function FontComboboxList({
  inputRef,
  ...options
}: FontOptionsProps & {
  inputRef: React.RefObject<HTMLInputElement | null>;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <Command shouldFilter={false} label={t("appearance.font.title", "Monospace font")}>
      <CommandInput
        ref={inputRef}
        placeholder={t("appearance.font.search", "Search fonts…")}
        className="h-9 text-xs"
      />
      <CommandList className="max-h-56" label={t("appearance.font.results", "Font results")}>
        <CommandEmpty className="py-3 text-center text-xs">
          {t("appearance.font.noMatches", "No matching fonts.")}
        </CommandEmpty>
        <FontOptions {...options} />
      </CommandList>
    </Command>
  );
}

function FontOptions({ fonts, family, onSelect }: FontOptionsProps): React.JSX.Element {
  const { t } = useUiTranslation();
  const query = useCommandState((state) => state.search);
  const defaultLabel = t("appearance.font.default", "Default");
  // cmdk caches keywords by item value. The default's display label changes
  // with the language, so filter with the current label and keep item IDs stable.
  const matches = useMemo(() => {
    const options = [null, ...fonts];
    if (!query) return options;
    return options
      .map((option) => ({
        option,
        score: defaultFilter(
          option ?? DEFAULT_OPTION_VALUE,
          query,
          option === null && defaultLabel !== DEFAULT_OPTION_VALUE ? [defaultLabel] : undefined,
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ option }) => option);
  }, [defaultLabel, fonts, query]);
  return (
    <CommandGroup>
      {matches.map((option) => (
        <CommandItem
          key={option === null ? "default" : `font:${option}`}
          value={option ?? DEFAULT_OPTION_VALUE}
          className="text-xs"
          style={option === null ? undefined : { fontFamily: `"${option}"` }}
          onSelect={() => onSelect(option ?? "")}
        >
          <span className="flex-1 truncate">{option ?? defaultLabel}</span>
          {family === option && <CheckIcon className="size-3" />}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
