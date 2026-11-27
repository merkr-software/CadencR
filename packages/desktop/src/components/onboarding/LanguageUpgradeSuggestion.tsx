import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLanguageSettingState } from "@/lib/i18n/LanguageProvider";
import {
  DEFAULT_LANGUAGE,
  languageOptions,
  LEGACY_ENGLISH,
  type Language,
} from "@/lib/i18n/languages";
import { useUiTranslation } from "@/lib/i18n/ui";
import { useSaveInterfaceLanguage } from "@/lib/i18n/useSaveInterfaceLanguage";

export function LanguageUpgradeSuggestion() {
  const { suggestedLanguage } = useLanguageSettingState();
  return suggestedLanguage ? <LanguageChoice language={suggestedLanguage} /> : null;
}

function LanguageChoice({ language }: { language: Language }) {
  const { t, i18n } = useUiTranslation();
  const { save, busy } = useSaveInterfaceLanguage(language, LEGACY_ENGLISH);
  const name = languageOptions[language].name;
  const displayName = new Intl.DisplayNames(i18n.resolvedLanguage, { type: "language" }).of(
    new Intl.Locale(language).language,
  );
  const keepEnglish = () => {
    if (!busy) void save(DEFAULT_LANGUAGE);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) keepEnglish();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-sm"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {t("shell.language.upgrade.title", "Switch to {{language}}?", {
              language: displayName ?? name,
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              "shell.language.upgrade.description",
              "This is your system language. You can change the interface language anytime in Settings → General.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter aria-busy={busy}>
          {busy && <Loader2 className="size-4 self-center animate-spin" aria-hidden />}
          <Button variant="outline" disabled={busy} onClick={keepEnglish}>
            {t("shell.language.upgrade.keep", "Keep English")}
          </Button>
          <Button disabled={busy} onClick={() => void save(language)}>
            <span lang={language}>{name}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
