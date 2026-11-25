import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { useId } from "react";
import type { McpInput, McpInstallOption } from "@/api/generated";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** What the user still has to fill in before `option` can install. */
export function missingInputs(
  option: McpInstallOption,
  values: Record<string, string>,
): McpInput[] {
  return option.inputs.filter(
    (input) => input.required && !values[input.key]?.trim() && !input.default,
  );
}

/** How the server runs: one choice per registry package or remote. */
export function OptionPicker({
  options,
  selected,
  onSelect,
}: {
  options: McpInstallOption[];
  selected: number;
  onSelect: (index: number) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const kindLabels: Readonly<Record<string, string | undefined>> = {
    npm: t("marketplace.agent.mcpInstallForm.npmKind", "npm package"),
    pypi: t("marketplace.agent.mcpInstallForm.pypiKind", "PyPI package"),
    oci: t("marketplace.agent.mcpInstallForm.ociKind", "Container image"),
    remote: t("marketplace.agent.mcpInstallForm.remoteKind", "Remote server"),
  };
  return (
    <div
      role="radiogroup"
      aria-label={t("marketplace.agent.mcpInstallForm.howTheServerRuns", "How the server runs")}
      className="grid gap-2"
    >
      {options.map((option, index) => (
        <button
          key={`${option.kind}:${option.summary}`}
          type="button"
          role="radio"
          aria-checked={index === selected}
          onClick={() => onSelect(index)}
          className={cn(
            "rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            index === selected
              ? "border-foreground/30 bg-foreground/6"
              : "border-border/80 hover:bg-accent/50",
          )}
        >
          <span className="block text-[12.5px] font-medium">
            {Object.hasOwn(kindLabels, option.kind) ? kindLabels[option.kind] : option.kind}
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
              {option.transport === "stdio"
                ? t("marketplace.agent.mcpInstallForm.runsLocally", "runs locally")
                : option.transport.toUpperCase()}
            </span>
          </span>
          <code className="block truncate font-mono text-[11px] text-muted-foreground">
            {option.summary}
          </code>
        </button>
      ))}
    </div>
  );
}

function InputField({
  input,
  value,
  onChange,
}: {
  input: McpInput;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const id = useId();
  const where =
    input.kind === "env"
      ? t("marketplace.agent.mcpInstallForm.environment", "Environment variable")
      : input.kind === "header"
        ? t("marketplace.agent.mcpInstallForm.httpHeader", "HTTP header")
        : input.kind === "url_variable"
          ? t("marketplace.agent.mcpInstallForm.urlValue", "URL value")
          : t("marketplace.agent.mcpInstallForm.commandArgument", "Argument");
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="flex items-baseline gap-1.5 text-[12px] font-medium">
        <span className="font-mono">{input.label}</span>
        <span className="text-[11px] font-normal text-muted-foreground">
          {input.required
            ? t("marketplace.agent.mcpInstallForm.requiredInput", "{{kind}} · required", {
                kind: where,
              })
            : t("marketplace.agent.mcpInstallForm.optionalInput", "{{kind}} · optional", {
                kind: where,
              })}
        </span>
      </label>
      <Input
        id={id}
        type={input.secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={input.placeholder ?? input.default ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 font-mono text-[12px]"
      />
      {input.description && (
        <p className="text-[11px] text-muted-foreground">{input.description}</p>
      )}
    </div>
  );
}

/** The values the registry entry asks for, plus the name the CLIs register it under. */
export function McpValuesForm({
  option,
  values,
  onValuesChange,
  serverName,
  onServerNameChange,
}: {
  option: McpInstallOption;
  values: Record<string, string>;
  onValuesChange: (values: Record<string, string>) => void;
  serverName: string;
  onServerNameChange: (name: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const nameId = useId();
  const nameValid = SERVER_NAME_PATTERN.test(serverName);
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <label htmlFor={nameId} className="text-[12px] font-medium">
          {t("marketplace.agent.mcpInstallForm.serverNameInTheCli", "Server name in the CLI")}
        </label>
        <Input
          id={nameId}
          value={serverName}
          spellCheck={false}
          aria-invalid={!nameValid}
          onChange={(event) => onServerNameChange(event.target.value)}
          className="h-8 font-mono text-[12px]"
        />
        {!nameValid && (
          <p role="alert" className="text-[11px] text-destructive">
            {t(
              "marketplace.agent.mcpInstallForm.serverNameFormat",
              "Letters, digits, dots, dashes or underscores, starting with a letter or digit.",
            )}
          </p>
        )}
      </div>
      {option.inputs.map((input) => (
        <InputField
          key={input.key}
          input={input}
          value={values[input.key] ?? ""}
          onChange={(value) => onValuesChange({ ...values, [input.key]: value })}
        />
      ))}
      {option.inputs.some((input) => input.secret) && (
        <p className="text-[11px] text-muted-foreground">
          <UiTrans
            i18nKey="marketplace.agent.mcpInstallForm.secretHandling"
            defaults="Secrets go straight into the CLI's own configuration, the same as typing its <command>{{command}}</command> command. Cadencr does not keep a copy."
            components={{ command: <code /> }}
            values={{ command: "mcp add" }}
          />
        </p>
      )}
    </div>
  );
}
