import { z } from "zod";
import type { ProviderPromptCapabilities, ProviderResumeCommand } from "@/api/generated";

/**
 * Provider-neutral host conventions a catalog entry may declare: the provider
 * executable (or a built-in adapter) reports them, the host never infers them
 * from a provider id. See docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md
 * (`host-integration`) and the ACP `initialize` prompt capabilities.
 */

export interface ProviderHostCapabilityFields {
  /** `/compact` is a session action Cadencr performs, not a runtime slash command. */
  compact_action?: boolean;
  resume_command?: ProviderResumeCommand;
  prompt_capabilities?: ProviderPromptCapabilities;
}

const resumeCommandSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()),
}) satisfies z.ZodType<ProviderResumeCommand>;

const promptCapabilitiesSchema = z.object({
  image: z.boolean(),
  audio: z.boolean(),
  embedded_context: z.boolean(),
}) satisfies z.ZodType<ProviderPromptCapabilities>;

const hostCapabilityFieldsSchema = z.object({
  compact_action: z.boolean().nullish(),
  resume_command: resumeCommandSchema.nullish(),
  prompt_capabilities: promptCapabilitiesSchema.nullish(),
});

/**
 * Validate the host-capability fields of one catalog entry (the generated
 * client types them but nothing checks them at runtime). Serde emits `null`
 * for absent options; those normalize to `undefined`. A malformed entry
 * throws so the catalog query fails visibly instead of building a shell
 * command or attachment policy from garbage.
 */
export function validateHostCapabilityFields<T extends { id: string }>(
  entry: T,
): T & ProviderHostCapabilityFields {
  const parsed = hostCapabilityFieldsSchema.safeParse(entry);
  if (!parsed.success) {
    throw new Error(
      `Agent catalog entry "${entry.id}" has invalid host capabilities: ${z.prettifyError(parsed.error)}`,
    );
  }
  const { compact_action, resume_command, prompt_capabilities } = parsed.data;
  return {
    ...entry,
    compact_action: compact_action ?? false,
    resume_command: resume_command ?? undefined,
    prompt_capabilities: prompt_capabilities ?? undefined,
  };
}

/**
 * Whether a submitted prompt is the `/compact` session action rather than
 * text for the runtime: only for providers whose catalog declares
 * `compact_action`; elsewhere `/compact` stays the runtime's own command.
 */
export function isCompactActionPrompt(text: string, compactAction: boolean): boolean {
  return compactAction && text.trim() === "/compact";
}
