import { useId } from "react";
import type { McpInput, McpInstallOption } from "@/api/generated";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const KIND_LABELS: Record<string, string> = {
  npm: "npm package",
  pypi: "PyPI package",
  oci: "Container image",
  remote: "Remote server",
};

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
  return (
    <div role="radiogroup" aria-label="How the server runs" className="grid gap-2">
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
            {KIND_LABELS[option.kind] ?? option.kind}
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
              {option.transport === "stdio" ? "runs locally" : option.transport.toUpperCase()}
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
  const id = useId();
  const where =
    input.kind === "env"
      ? "Environment variable"
      : input.kind === "header"
        ? "HTTP header"
        : input.kind === "url_variable"
          ? "URL value"
          : "Argument";
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="flex items-baseline gap-1.5 text-[12px] font-medium">
        <span className="font-mono">{input.label}</span>
        <span className="text-[11px] font-normal text-muted-foreground">
          {where}
          {input.required ? " · required" : " · optional"}
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
  const nameId = useId();
  const nameValid = SERVER_NAME_PATTERN.test(serverName);
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <label htmlFor={nameId} className="text-[12px] font-medium">
          Server name in the CLI
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
            Letters, digits, dots, dashes or underscores, starting with a letter or digit.
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
          Secrets go straight into the CLI's own configuration, the same as typing its{" "}
          <code>mcp add</code> command. Cadencr does not keep a copy.
        </p>
      )}
    </div>
  );
}
