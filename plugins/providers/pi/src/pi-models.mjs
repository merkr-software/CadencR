const BASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
const EXTENDED_THINKING_LEVELS = [...BASE_THINKING_LEVELS, "xhigh", "max"];

function requiredTrimmedString(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`Pi returned an invalid ${field}`);
  }
  return value;
}

export function modelValue(model) {
  return `${requiredTrimmedString(model.provider, "model provider")}/${requiredTrimmedString(model.id, "model ID")}`;
}

export function splitModelValue(value) {
  const slash = typeof value === "string" ? value.indexOf("/") : -1;
  if (slash <= 0 || slash === value.length - 1 || value.trim() !== value) {
    throw new Error(`invalid Pi model value \`${String(value)}\``);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function buildModelConfigOption(availableModels, state) {
  if (!availableModels || !Array.isArray(availableModels.models)) {
    throw new Error("Pi returned malformed output for get_available_models");
  }
  if (availableModels.models.length === 0) {
    throw new Error("Pi returned no available models; run `pi` and configure a provider first");
  }

  const seen = new Set();
  const options = availableModels.models.map((model) => {
    if (!model || typeof model !== "object") {
      throw new Error("Pi returned a malformed model entry");
    }
    const value = modelValue(model);
    if (seen.has(value)) throw new Error(`Pi returned duplicate model ID \`${value}\``);
    seen.add(value);

    const nativeName =
      typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id;
    const option = {
      value,
      name: `${model.provider}: ${nativeName}`,
    };
    const details = [];
    if (Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0) {
      details.push(`${model.contextWindow.toLocaleString("en-US")} token context`);
    }
    if (Array.isArray(model.input) && model.input.includes("image")) details.push("vision");
    if (details.length > 0) option.description = details.join(" · ");

    const levels = supportedThinkingLevels(model);
    if (model.reasoning === true) {
      option._meta = {
        cadencr: {
          supportsEffort: true,
          supportedEffortLevels: levels,
          defaultEffortLevel: defaultThinkingLevel(levels, state?.thinkingLevel),
        },
      };
    }
    return option;
  });

  const selectedValue = state?.model ? modelValue(state.model) : null;
  const currentValue = selectedValue && seen.has(selectedValue) ? selectedValue : options[0].value;
  return {
    id: "model",
    name: "Model",
    description: "Select the Pi model before starting the session",
    category: "model",
    type: "select",
    currentValue,
    options,
  };
}

function defaultThinkingLevel(levels, requested) {
  if (levels.includes(requested)) return requested;
  if (levels.includes("medium")) return "medium";
  return levels[0];
}

export function buildSessionConfigOptions({ availableModels, state, thinkingLevels }) {
  const model = buildModelConfigOption(availableModels, state);
  const levels =
    Array.isArray(thinkingLevels) && thinkingLevels.length > 0
      ? thinkingLevels
      : supportedThinkingLevels(state?.model);
  const thinkingValue = defaultThinkingLevel(levels, state?.thinkingLevel);
  return [
    model,
    {
      id: "thinking_level",
      name: "Thinking level",
      description: "Control Pi reasoning depth for the selected model",
      category: "thought_level",
      type: "select",
      currentValue: thinkingValue,
      options: levels.map((value) => ({ value, name: thinkingLabel(value) })),
    },
    {
      id: "auto_compaction",
      name: "Automatic compaction",
      description: "Let Pi compact the conversation when its context becomes full",
      category: "_pi",
      type: "boolean",
      currentValue: state?.autoCompactionEnabled !== false,
    },
    selectOption(
      "steering_mode",
      "Steering queue",
      "How Pi drains messages sent while it is working",
      state?.steeringMode ?? "all",
      ["all", "one-at-a-time"],
    ),
    selectOption(
      "follow_up_mode",
      "Follow-up queue",
      "How Pi drains messages queued after a turn",
      state?.followUpMode ?? "all",
      ["all", "one-at-a-time"],
    ),
  ];
}

function selectOption(id, name, description, currentValue, values) {
  return {
    id,
    name,
    description,
    category: "_pi",
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: thinkingLabel(value) })),
  };
}

function thinkingLabel(value) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
